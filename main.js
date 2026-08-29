'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, MarkdownRenderChild, TFile, Menu, Notice, Platform } = obsidian;

/* ------------------------------------------------------------------ *
 * constants + helpers
 * ------------------------------------------------------------------ */

const DAY_MS = 86400000;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DEFAULT_PATH = 'Habit Tracker Data.md';

const MIN_COL = 22;
const MAX_COL = 110;

const PALETTE = [
  '#ec4899', '#f59e0b', '#3b82f6', '#06b6d4', '#8b5cf6',
  '#22c55e', '#ef4444', '#14b8a6', '#eab308', '#f97316',
];

const DEFAULT_DATA = {
  habits: [
    { id: 'h_new1', name: 'New habit', color: '#ec4899' },
    { id: 'h_new2', name: 'New habit', color: '#f59e0b' },
    { id: 'h_new3', name: 'New habit', color: '#3b82f6' },
  ],
  logs: {},
  moods: {},
  period: 'week',
  colW: 0,
  columns: null,
};

function habitEntryCount(data, id) {
  const log = (data.logs || {})[id] || {};
  let n = 0;
  for (const k of Object.keys(log)) if (log[k]) n++;
  return n;
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function serializeData(data) {
  const payload = {
    habits: data.habits,
    logs: data.logs,
    moods: data.moods,
    period: data.period,
    colW: data.colW,
    columns: data.columns,
  };
  return [
    '---',
    'habit-tracker-data: true',
    '---',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n');
}

function parseDataFile(text) {
  if (!text) return null;
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISO(s) {
  const p = String(s).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function dayDiff(a, b) {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function mondayOf(d) {
  const wd = (d.getDay() + 6) % 7;
  return addDays(d, -wd);
}

function sundayOf(d) {
  return addDays(mondayOf(d), 6);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function uid() {
  return 'h_' + Math.random().toString(36).slice(2, 9);
}

function avg(list) {
  const vals = list.filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* ------------------------------------------------------------------ *
 * faces
 * ------------------------------------------------------------------ */

function faceSVG(level, size) {
  const s = size || 24;
  let eyes;
  let mouth;
  let brows = '';

  if (level === 5) {
    eyes =
      '<path d="M7.4 10.6 Q9.1 8.5 10.8 10.6" fill="none" stroke="var(--hm-ink)" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M13.2 10.6 Q14.9 8.5 16.6 10.6" fill="none" stroke="var(--hm-ink)" stroke-width="1.5" stroke-linecap="round"/>';
    mouth = 'M7.3 13.6 Q12 19 16.7 13.6';
  } else {
    eyes =
      '<circle cx="8.8" cy="10" r="1.15" fill="var(--hm-ink)"/>' +
      '<circle cx="15.2" cy="10" r="1.15" fill="var(--hm-ink)"/>';
    if (level === 1) {
      mouth = 'M7.7 16.6 Q12 12.3 16.3 16.6';
      brows =
        '<path d="M6.5 7.9 L10.4 9.4" stroke="var(--hm-ink)" stroke-width="1.3" stroke-linecap="round"/>' +
        '<path d="M17.5 7.9 L13.6 9.4" stroke="var(--hm-ink)" stroke-width="1.3" stroke-linecap="round"/>';
    } else if (level === 2) {
      mouth = 'M8.2 16.1 Q12 13.4 15.8 16.1';
    } else if (level === 4) {
      mouth = 'M8.2 14.3 Q12 17.6 15.8 14.3';
    } else {
      mouth = 'M8.3 15 L15.7 15';
    }
  }

  return (
    `<svg class="hm-face-svg" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true">` +
    '<circle cx="12" cy="12" r="11" fill="currentColor"/>' +
    brows +
    eyes +
    `<path d="${mouth}" fill="none" stroke="var(--hm-ink)" stroke-width="1.5" stroke-linecap="round"/>` +
    '</svg>'
  );
}

/* ------------------------------------------------------------------ *
 * floating panel
 * ------------------------------------------------------------------ */

let openPanel = null;

function closePanel() {
  if (openPanel) {
    if (openPanel.cleanup) openPanel.cleanup();
    openPanel.remove();
    openPanel = null;
  }
}

function showPanel(anchorEl, build) {
  closePanel();

  const panel = document.createElement('div');
  panel.className = 'hm-panel';
  build(panel);
  document.body.appendChild(panel);

  if (window.innerWidth < 560) {
    panel.classList.add('hm-panel-sheet');
  } else {
    const r = anchorEl.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.top - ph - 10;
    if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - ph - 8);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  const onDown = (e) => {
    if (!panel.contains(e.target)) closePanel();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closePanel();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  panel.cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };

  openPanel = panel;
  return panel;
}

/* ------------------------------------------------------------------ *
 * view
 * ------------------------------------------------------------------ */

class TrackerView extends MarkdownRenderChild {
  constructor(plugin, containerEl, mode) {
    super(containerEl);
    this.plugin = plugin;
    this.mode = mode;
    this.labelW = Platform.isMobile ? 104 : 140;
    this.scrollLeft = null;
    this.pendingScroll = null;
    this.armed = null;
    this.rows = new Map();
  }

  onload() {
    this.plugin.views.add(this);
    this.safeRender();
  }

  safeRender() {
    try {
      this.render();
    } catch (err) {
      const el = this.containerEl;
      el.empty ? el.empty() : (el.innerHTML = '');
      const box = document.createElement('div');
      box.setAttribute(
        'style',
        'padding:8px 10px;border:1px solid #b45309;border-radius:6px;color:#f59e0b;font-size:12px;'
      );
      box.textContent = 'Habit tracker error: ' + (err && err.message ? err.message : String(err));
      el.appendChild(box);
      console.error('[habit-mood-tracker]', err);
    }
  }

  // if styles.css never loaded, the whole grid collapses to nothing
  verifyStyles() {
    if (!this.rootEl || !this.rootEl.isConnected) return;
    if (window.getComputedStyle(this.rootEl).position === 'relative') return;
    const warn = document.createElement('div');
    warn.setAttribute(
      'style',
      'padding:8px 10px;border:1px solid #b45309;border-radius:6px;color:#f59e0b;font-size:12px;margin-bottom:8px;'
    );
    warn.textContent =
      'styles.css is missing from .obsidian/plugins/habit-mood-tracker/ on this device — copy it over and reopen.';
    this.containerEl.prepend(warn);
  }

  onunload() {
    this.plugin.views.delete(this);
    if (this.settleRO) {
      this.settleRO.disconnect();
      this.settleRO = null;
    }
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
  }

  get data() {
    return this.plugin.data;
  }

  get colW() {
    const stored = this.data.colW;
    if (stored && stored >= MIN_COL && stored <= MAX_COL) return stored;
    return Platform.isMobile ? 40 : 48;
  }

  /* ---------------------------- date range -------------------------- */

  ensureColumns() {
    const d = this.data;
    let changed = false;

    if (!Array.isArray(d.columns) || !d.columns.length) {
      const m = mondayOf(new Date());
      d.columns = [];
      for (let i = 0; i < 7; i++) d.columns.push(iso(addDays(m, i)));
      changed = true;
    }

    // grow forward a week at a time so today is always on the tracker
    const todayKey = iso(new Date());
    let guard = 0;
    while (d.columns[d.columns.length - 1] < todayKey && guard++ < 520) {
      const last = parseISO(d.columns[d.columns.length - 1]);
      for (let i = 1; i <= 7; i++) d.columns.push(iso(addDays(last, i)));
      changed = true;
    }

    return changed;
  }

  buildDates() {
    const changed = this.ensureColumns();
    this.dates = this.data.columns.slice();
    this.todayIdx = this.dates.indexOf(iso(new Date()));
    if (changed) this.plugin.queueSave();
  }

  /* ------------------------------ render ---------------------------- */

  render() {
    const el = this.containerEl;
    if (this.scrollEl && this.userScrolled) this.scrollLeft = this.scrollEl.scrollLeft;
    el.empty ? el.empty() : (el.innerHTML = '');
    el.classList.add('hm-host');
    this.rows.clear();

    const root = document.createElement('div');
    root.className = 'hm-root';
    el.appendChild(root);
    this.rootEl = root;

    if (this.mode === 'log') {
      root.classList.add('hm-log');
      this.cardsEl = document.createElement('div');
      this.cardsEl.className = 'hm-cards';
      root.appendChild(this.cardsEl);
      this.renderCards();
      requestAnimationFrame(() => this.verifyStyles());
      return;
    }

    root.style.setProperty('--hm-col', this.colW + 'px');
    root.style.setProperty('--hm-label', this.labelW + 'px');
    this.buildDates();

    const scroll = document.createElement('div');
    scroll.className = 'hm-scroll';
    root.appendChild(scroll);
    this.scrollEl = scroll;

    const inner = document.createElement('div');
    inner.className = 'hm-inner';
    scroll.appendChild(inner);
    this.innerEl = inner;

    inner.appendChild(this.buildHeaderRow());
    for (const habit of this.data.habits) inner.appendChild(this.buildHabitRow(habit));
    if (!this.data.habits.length) inner.appendChild(this.buildAddRow());
    inner.appendChild(this.buildMoodRow());

    if (this.todayIdx >= 0) {
      const band = document.createElement('div');
      band.className = 'hm-band';
      band.style.left = `calc(var(--hm-label) + ${this.todayIdx * this.colW}px)`;
      inner.appendChild(band);
    }

    for (let i = 1; i < this.dates.length; i++) {
      if (dayDiff(parseISO(this.dates[i]), parseISO(this.dates[i - 1])) === 1) continue;
      const line = document.createElement('div');
      line.className = 'hm-gapline';
      line.style.left = `calc(var(--hm-label) + ${i * this.colW}px)`;
      inner.appendChild(line);
    }

    this.attachPan(scroll);
    this.attachZoom(scroll);

    requestAnimationFrame(() => {
      this.verifyStyles();
      if (this.pendingScroll != null) {
        scroll.scrollLeft = this.pendingScroll;
        this.pendingScroll = null;
      } else if (this.userScrolled && this.scrollLeft != null) {
        scroll.scrollLeft = this.scrollLeft;
      } else {
        this.positionToday(scroll, 0);
      }
    });
  }

  // today sits ~65% across the visible area, clamped to the ends
  targetScroll(scroll) {
    const w = scroll.clientWidth;
    if (!w) return null;
    const max = Math.max(0, scroll.scrollWidth - w);
    if (this.todayIdx < 0) return max;
    const frac = Platform.isMobile ? 0.65 : 0.7;
    return clamp(this.labelW + (this.todayIdx + 0.5) * this.colW - w * frac, 0, max);
  }

  reassert(scroll) {
    if (!scroll.isConnected || this.userScrolled) return;
    const t = this.targetScroll(scroll);
    if (t == null) return;
    if (Math.abs(scroll.scrollLeft - t) > 2) {
      scroll.scrollLeft = t;
      this.scrollLeft = t;
    }
  }

  positionToday(scroll, attempt) {
    if (!scroll.isConnected) return;

    // the pane may not be laid out yet, especially on a cold start
    const t = this.targetScroll(scroll);
    if (t == null) {
      if (attempt < 12) setTimeout(() => this.positionToday(scroll, attempt + 1), 60);
      return;
    }

    scroll.scrollLeft = t;
    this.scrollLeft = t;

    if (this.settleRO) {
      this.settleRO.disconnect();
      this.settleRO = null;
    }
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }

    // startup relayout can reset scrollLeft under us; keep putting it back
    // until the layout stops moving or the user actually scrolls
    const started = Date.now();
    this.settleTimer = setInterval(() => {
      if (!scroll.isConnected || this.userScrolled || Date.now() - started > 4000) {
        clearInterval(this.settleTimer);
        this.settleTimer = null;
        return;
      }
      this.reassert(scroll);
    }, 100);

    // content can grow without the container resizing, so watch both
    if (typeof ResizeObserver !== 'undefined') {
      this.settleRO = new ResizeObserver(() => this.reassert(scroll));
      this.settleRO.observe(scroll);
      if (this.innerEl) this.settleRO.observe(this.innerEl);
      setTimeout(() => {
        if (this.settleRO) {
          this.settleRO.disconnect();
          this.settleRO = null;
        }
      }, 4000);
    }
  }

  /* ------------------------------ cards ----------------------------- */

  renderCards() {
    const wrap = this.cardsEl;
    if (!wrap) return;
    wrap.innerHTML = '';
    this.charts = [];

    const seg = document.createElement('div');
    seg.className = 'hm-seg';
    [['week', 'Week'], ['month', 'Month'], ['year', 'Year']].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.className = 'hm-seg-btn' + (this.data.period === key ? ' is-on' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        this.data.period = key;
        this.plugin.saveState();
      });
      seg.appendChild(b);
    });
    wrap.appendChild(seg);

    this.ensureColumns();

    const stack = document.createElement('div');
    stack.className = 'hm-stack';
    wrap.appendChild(stack);

    stack.appendChild(this.buildTimeCard('Mood', 'mood', '#22c55e'));
    stack.appendChild(this.buildTimeCard('Productivity', 'productivity', '#3b82f6'));
    stack.appendChild(this.buildTimeCard('Stress', 'stress', '#f59e0b'));
    stack.appendChild(this.buildMoodMixCard());

    requestAnimationFrame(() => this.drawCharts());
  }

  // how many days fit across the chart before you have to scrub
  get span() {
    const p = this.data.period;
    return p === 'month' ? 30 : p === 'year' ? 365 : 7;
  }

  // the exact day sequence the tracker shows, so the two always agree
  columnSeries(kind) {
    const cols = this.data.columns || [];
    const moods = this.data.moods;
    return cols.map((k, i) => {
      const d = parseISO(k);
      const m = moods[k];
      return {
        key: k,
        label: d.getDate() + ' ' + MON[d.getMonth()],
        value: m && m[kind] != null ? m[kind] : null,
        gap: i > 0 && dayDiff(d, parseISO(cols[i - 1])) !== 1,
      };
    });
  }

  buildTimeCard(title, kind, color) {
    const series = this.columnSeries(kind);
    const card = document.createElement('div');
    card.className = 'hm-chart-card';

    const head = document.createElement('div');
    head.className = 'hm-chart-head';
    const t = document.createElement('span');
    t.className = 'hm-card-title';
    t.textContent = title;
    head.appendChild(t);

    const filled = series.filter((p) => p.value != null);
    if (filled.length >= 2) {
      const last = filled[filled.length - 1].value;
      const prev = filled[filled.length - 2].value;
      const pct = prev ? Math.round(((last - prev) / prev) * 100) : 0;
      const badge = document.createElement('span');
      badge.className = 'hm-badge ' + (pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : 'is-flat');
      badge.textContent = (pct > 0 ? '+' : '') + pct + '%';
      head.appendChild(badge);
    }
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'hm-chart-body';

    if (!filled.length) {
      body.innerHTML = '<div class="hm-empty">No data yet</div>';
      body.classList.add('is-empty');
      card.appendChild(body);
      return card;
    }

    const axis = document.createElement('div');
    axis.className = 'hm-chart-axis';
    body.appendChild(axis);

    const scroll = document.createElement('div');
    scroll.className = 'hm-chart-scroll';
    body.appendChild(scroll);
    card.appendChild(body);

    this.attachDragPan(scroll);
    this.charts.push({ scroll, axis, series, color });
    return card;
  }

  drawCharts() {
    const H = Platform.isMobile ? 150 : 190;
    const padT = 16;
    const padB = 26;
    const padX = 14;
    const plotH = H - padT - padB;

    for (const c of this.charts) {
      if (!c.scroll.isConnected) continue;
      const n = c.series.length;
      const box = c.scroll.clientWidth || 600;
      const step = Math.max(2, box / this.span);
      const W = Math.max(box, (n - 1) * step + padX * 2);
      const x = (i) => (n <= 1 ? W / 2 : padX + (i * (W - padX * 2)) / (n - 1));
      const y = (v) => padT + ((5 - v) / 4) * plotH;

      let grid = '';
      for (let v = 1; v <= 5; v++) {
        grid += `<line x1="0" y1="${y(v).toFixed(1)}" x2="${W}" y2="${y(v).toFixed(1)}" stroke="var(--background-modifier-border)" stroke-width="1"/>`;
      }

      // same divider the tracker draws wherever the dates jump
      let breaks = '';
      c.series.forEach((p, i) => {
        if (!p.gap) return;
        const xb = ((x(i - 1) + x(i)) / 2).toFixed(1);
        breaks += `<line x1="${xb}" y1="0" x2="${xb}" y2="${H - padB + 4}" stroke="var(--text-faint)" stroke-width="1" opacity="0.55"/>`;
      });

      let segs = '';
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          segs += `<polyline points="${run.join(' ')}" fill="none" stroke="${c.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        run = [];
      };
      c.series.forEach((p, i) => {
        if (p.value == null) {
          flush();
          return;
        }
        run.push(x(i).toFixed(1) + ',' + y(p.value).toFixed(1));
      });
      flush();

      let dots = '';
      c.series.forEach((p, i) => {
        if (p.value == null) return;
        dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="${c.color}"><title>${p.label}: ${p.value}</title></circle>`;
      });

      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 64))));
      let labels = '';
      c.series.forEach((p, i) => {
        if (i % every !== 0 && i !== n - 1) return;
        labels += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-faint)">${p.label}</text>`;
      });

      c.scroll.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="hm-chart-svg">${grid}${breaks}${segs}${dots}${labels}</svg>`;

      c.axis.innerHTML = '';
      for (let v = 5; v >= 1; v--) {
        const lab = document.createElement('span');
        lab.className = 'hm-axis-lab';
        lab.style.top = y(v) - 6 + 'px';
        lab.textContent = String(v);
        c.axis.appendChild(lab);
      }
      c.axis.style.height = H + 'px';

      c.scroll.scrollLeft = c.scroll.scrollWidth;
    }
  }

  attachDragPan(el) {
    let dragging = false;
    let startX = 0;
    let startScroll = 0;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      el.classList.add('is-dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      el.scrollLeft = startScroll - (e.clientX - startX);
    });
    const stop = () => {
      dragging = false;
      el.classList.remove('is-dragging');
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointercancel', stop);
  }

  buildMoodMixCard() {
    const card = document.createElement('div');
    card.className = 'hm-chart-card';
    const head = document.createElement('div');
    head.className = 'hm-chart-head';
    head.innerHTML = '<span class="hm-card-title">Most common moods</span>';
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'hm-chart-body is-empty';

    const counts = [0, 0, 0, 0, 0];
    for (const k of Object.keys(this.data.moods)) {
      const m = this.data.moods[k];
      if (m && m.mood) counts[m.mood - 1]++;
    }
    const max = Math.max.apply(null, counts);

    if (!max) {
      body.innerHTML = '<div class="hm-empty">No data yet</div>';
    } else {
      const bars = document.createElement('div');
      bars.className = 'hm-mix';
      counts.forEach((c, i) => {
        const col = document.createElement('div');
        col.className = 'hm-mix-col';
        const count = document.createElement('span');
        count.className = 'hm-mix-count';
        count.textContent = c ? String(c) : '';
        const bar = document.createElement('div');
        bar.className = 'hm-mix-bar';
        bar.style.height = Math.max(4, (c / max) * 90) + 'px';
        if (c === max) bar.classList.add('is-top');
        const face = document.createElement('span');
        face.className = 'hm-face hm-mix-face' + (c ? ' has' : '');
        face.innerHTML = faceSVG(i + 1, 20);
        col.appendChild(count);
        col.appendChild(bar);
        col.appendChild(face);
        bars.appendChild(col);
      });
      body.appendChild(bars);
    }
    card.appendChild(body);
    return card;
  }

  /* ------------------------------- rows ----------------------------- */

  makeRow(cls) {
    const row = document.createElement('div');
    row.className = 'hm-row' + (cls ? ' ' + cls : '');
    const label = document.createElement('div');
    label.className = 'hm-label';
    const track = document.createElement('div');
    track.className = 'hm-track';
    track.style.width = this.dates.length * this.colW + 'px';
    const tail = document.createElement('div');
    tail.className = 'hm-tail';
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(tail);
    return { row, label, track, tail };
  }

  tapButton(btn, onWeek, onDay) {
    let timer = null;
    let mode = null;

    const disarm = () => {
      clearTimeout(timer);
      timer = null;
      mode = null;
      btn.classList.remove('is-armed');
    };

    const arm = (m) => {
      clearTimeout(timer);
      mode = m;
      btn.classList.add('is-armed');
      timer = setTimeout(disarm, 600);
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mode === 'week') {
        disarm();
        onWeek();
        return;
      }
      arm('week');
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'day') {
        disarm();
        onDay();
        return;
      }
      arm('day');
    });
  }

  buildHeaderRow() {
    const { row, label, track, tail } = this.makeRow('hm-head-row');

    const minus = document.createElement('button');
    minus.className = 'hm-weekbtn' + (this.canDropDays(1) || this.canDropDays(7) ? '' : ' is-off');
    minus.textContent = '\u2212';
    minus.setAttribute('aria-label', 'Remove a week (double click) or a day (double right click)');
    this.tapButton(minus, () => this.dropDays(7), () => this.dropDays(1));
    label.appendChild(minus);

    const plus = document.createElement('button');
    plus.className = 'hm-weekbtn';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Add a week (double click) or a day (double right click)');
    this.tapButton(plus, () => this.addDaysToGrid(7), () => this.addDaysToGrid(1));
    tail.appendChild(plus);

    const today = new Date();
    this.dates.forEach((ds, i) => {
      const d = parseISO(ds);
      const diff = dayDiff(d, today);
      const cell = document.createElement('div');
      cell.className = 'hm-dcell' + (i === this.todayIdx ? ' is-today' : '');
      const top = diff >= -6 && diff <= 7 ? DOW[d.getDay()] : MON[d.getMonth()];
      cell.innerHTML = `<span class="hm-dcell-top">${top}</span><span class="hm-dcell-num">${d.getDate()}</span>`;
      cell.style.left = i * this.colW + 'px';
      cell.dataset.i = String(i);
      cell.dataset.date = ds;
      if (i > 0 && dayDiff(d, parseISO(this.dates[i - 1])) !== 1) cell.classList.add('is-gap');
      track.appendChild(cell);
    });

    track.addEventListener('click', (e) => {
      const cell = e.target.closest('.hm-dcell');
      if (!cell || this.suppressTap) return;
      this.openDatePanel(cell, Number(cell.dataset.i), cell.dataset.date);
    });

    return row;
  }

  openDatePanel(anchorEl, index, dateStr) {
    const d = parseISO(dateStr);

    showPanel(anchorEl, (panel) => {
      const head = document.createElement('div');
      head.className = 'hm-panel-head';
      head.textContent = `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
      panel.appendChild(head);

      const input = document.createElement('input');
      input.type = 'date';
      input.className = 'hm-input';
      input.value = dateStr;
      panel.appendChild(input);

      const apply = () => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return;
        closePanel();
        this.setColumnDate(index, input.value);
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') apply();
      });

      const actions = document.createElement('div');
      actions.className = 'hm-actions';

      const prev = index > 0 ? this.data.columns[index - 1] : null;
      if (prev && dayDiff(d, parseISO(prev)) !== 1) {
        const reset = document.createElement('button');
        reset.className = 'hm-btn';
        reset.textContent = 'Reset';
        reset.title = 'Continue on from the day before';
        reset.addEventListener('click', () => {
          closePanel();
          this.setColumnDate(index, iso(addDays(parseISO(prev), 1)));
        });
        actions.appendChild(reset);
      }

      const set = document.createElement('button');
      set.className = 'hm-btn is-primary';
      set.textContent = 'Set date';
      set.addEventListener('click', apply);
      actions.appendChild(set);
      panel.appendChild(actions);

      setTimeout(() => input.focus(), 30);
    });
  }

  addDaysToGrid(n) {
    const cols = this.data.columns;
    const last = parseISO(cols[cols.length - 1]);
    for (let i = 1; i <= n; i++) cols.push(iso(addDays(last, i)));
    this.plugin.saveState();
  }

  hasEntries(dates) {
    const logs = this.data.logs;
    const ids = Object.keys(logs);
    for (const k of dates) {
      if (this.data.moods[k]) return true;
      for (const id of ids) if (logs[id] && logs[id][k]) return true;
    }
    return false;
  }

  trailing(n) {
    const cols = this.data.columns || [];
    if (cols.length <= n) return null;
    return { cut: cols.length - n, removed: cols.slice(cols.length - n) };
  }

  canDropDays(n) {
    const t = this.trailing(n);
    if (!t) return false;
    if (this.data.columns[t.cut - 1] < iso(new Date())) return false;
    return !this.hasEntries(t.removed);
  }

  dropDays(n) {
    const t = this.trailing(n);
    if (this.canDropDays(n)) {
      this.data.columns = this.data.columns.slice(0, t.cut);
      this.plugin.saveState();
      return;
    }
    if (t && this.hasEntries(t.removed)) {
      new Notice(
        n === 1
          ? 'All day tracking data must be deleted first.'
          : 'All week tracking data must be deleted first.'
      );
    }
  }

  // index of the next date change after `from`, or the end of the grid
  nextBreak(cols, from) {
    for (let j = from + 1; j < cols.length; j++) {
      if (dayDiff(parseISO(cols[j]), parseISO(cols[j - 1])) !== 1) return j;
    }
    return cols.length;
  }

  // rewrites only this stretch: days before `index` and any later date change are untouched
  setColumnDate(index, dateStr) {
    const cols = this.data.columns;
    const end = this.nextBreak(cols, index);
    const from = parseISO(dateStr);
    const seg = [];
    for (let k = 0; k < end - index; k++) seg.push(iso(addDays(from, k)));
    this.data.columns = cols.slice(0, index).concat(seg, cols.slice(end));
    this.plugin.saveState();
  }

  buildAddRow() {
    const { row, label } = this.makeRow('hm-add-row');
    const btn = document.createElement('div');
    btn.className = 'hm-name hm-add';
    btn.textContent = '+ Add habit';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.suppressTap) return;
      this.openHabitPanel(null, btn);
    });
    label.appendChild(btn);
    return row;
  }

  buildHabitRow(habit) {
    const { row, label, track, tail } = this.makeRow();
    row.dataset.habit = habit.id;

    const name = document.createElement('div');
    name.className = 'hm-name';
    name.textContent = habit.name;
    label.appendChild(name);
    this.attachHabitMenu(name, habit);

    const blocks = document.createElement('div');
    blocks.className = 'hm-blocks';
    track.appendChild(blocks);

    const cells = document.createElement('div');
    cells.className = 'hm-cells';
    track.appendChild(cells);

    this.dates.forEach((ds, i) => {
      const c = document.createElement('div');
      c.className = 'hm-cell';
      c.style.left = i * this.colW + 'px';
      c.dataset.date = ds;
      cells.appendChild(c);
    });

    cells.addEventListener('click', (e) => {
      const cell = e.target.closest('.hm-cell');
      if (!cell || this.suppressTap) return;
      this.tapCell(habit, cell);
    });

    this.rows.set(habit.id, { blocks, tail, cells });
    this.paintRow(habit);
    return row;
  }

  paintRow(habit) {
    const ref = this.rows.get(habit.id);
    if (!ref) return;
    const log = this.data.logs[habit.id] || {};
    const frag = document.createDocumentFragment();
    const colW = this.colW;

    let i = 0;
    while (i < this.dates.length) {
      if (!log[this.dates[i]]) {
        i++;
        continue;
      }
      let j = i;
      while (
        j + 1 < this.dates.length &&
        log[this.dates[j + 1]] &&
        dayDiff(parseISO(this.dates[j + 1]), parseISO(this.dates[j])) === 1
      )
        j++;
      const len = j - i + 1;
      const b = document.createElement('div');
      b.className = 'hm-block';
      b.style.left = i * colW + 3 + 'px';
      b.style.width = len * colW - 6 + 'px';
      b.style.background = habit.color;
      if (len > 1 && colW >= 30) b.textContent = String(len);
      frag.appendChild(b);
      i = j + 1;
    }

    ref.blocks.innerHTML = '';
    ref.blocks.appendChild(frag);

    const best = this.bestStreak(log);
    ref.tail.textContent = best ? String(best) : '';
  }

  bestStreak(log) {
    const days = Object.keys(log).filter((k) => log[k]).sort();
    let best = 0;
    let cur = 0;
    let prev = null;
    for (const d of days) {
      if (prev && dayDiff(parseISO(d), parseISO(prev)) === 1) cur++;
      else cur = 1;
      if (cur > best) best = cur;
      prev = d;
    }
    return best;
  }

  tapCell(habit, cell) {
    const key = habit.id + '|' + cell.dataset.date;
    const now = Date.now();

    if (this.armed && this.armed.key === key && now - this.armed.t < 500) {
      clearTimeout(this.armed.timer);
      this.armed.cell.classList.remove('is-armed');
      this.armed = null;
      this.toggle(habit, cell.dataset.date);
      return;
    }

    if (this.armed) {
      clearTimeout(this.armed.timer);
      this.armed.cell.classList.remove('is-armed');
    }
    cell.classList.add('is-armed');
    const timer = setTimeout(() => {
      cell.classList.remove('is-armed');
      this.armed = null;
    }, 500);
    this.armed = { key, t: now, timer, cell };
  }

  toggle(habit, date) {
    const logs = this.data.logs;
    if (!logs[habit.id]) logs[habit.id] = {};
    if (logs[habit.id][date]) delete logs[habit.id][date];
    else logs[habit.id][date] = 1;
    this.plugin.saveStateQuiet();
    for (const v of this.plugin.views) {
      if (v.mode === 'log') v.renderCards();
      else v.paintRow(habit);
    }
  }

  /* ----------------------------- mood row --------------------------- */

  buildMoodRow() {
    const { row, track } = this.makeRow('hm-mood-row');
    const cells = document.createElement('div');
    cells.className = 'hm-cells';
    track.appendChild(cells);

    this.dates.forEach((ds, i) => {
      const c = document.createElement('div');
      c.className = 'hm-cell hm-mcell';
      c.style.left = i * this.colW + 'px';
      c.dataset.date = ds;
      c.appendChild(this.faceEl(ds));
      cells.appendChild(c);
    });

    cells.addEventListener('click', (e) => {
      const cell = e.target.closest('.hm-mcell');
      if (!cell || this.suppressTap) return;
      this.openMoodPanel(cell.dataset.date, cell);
    });

    this.moodCells = cells;
    return row;
  }

  faceEl(ds) {
    const m = this.data.moods[ds];
    const lvl = m && m.mood ? m.mood : 3;
    const span = document.createElement('span');
    span.className = 'hm-face' + (m && m.mood ? ' has' : '');
    span.innerHTML = faceSVG(lvl, Math.max(14, Math.min(24, this.colW - 18)));
    return span;
  }

  repaintFace(ds) {
    if (!this.moodCells) return;
    const cell = this.moodCells.querySelector(`.hm-mcell[data-date="${ds}"]`);
    if (!cell) return;
    cell.innerHTML = '';
    cell.appendChild(this.faceEl(ds));
  }

  openMoodPanel(ds, anchor) {
    const d = parseISO(ds);
    const heading = `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;

    showPanel(anchor, (panel) => {
      const setVal = (kind, val) => {
        const moods = this.data.moods;
        if (!moods[ds]) moods[ds] = {};
        if (val == null) delete moods[ds][kind];
        else moods[ds][kind] = val;
        if (!Object.keys(moods[ds]).length) delete moods[ds];
        this.plugin.saveStateQuiet();
        for (const v of this.plugin.views) {
          if (v.mode === 'log') v.renderCards();
          else v.repaintFace(ds);
        }
      };

      const head = document.createElement('div');
      head.className = 'hm-panel-head';
      head.textContent = heading;
      panel.appendChild(head);

      const lab1 = document.createElement('div');
      lab1.className = 'hm-panel-label';
      lab1.textContent = 'How was your day?';
      panel.appendChild(lab1);

      const faces = document.createElement('div');
      faces.className = 'hm-facepick';
      for (let lvl = 1; lvl <= 5; lvl++) {
        const b = document.createElement('button');
        const cur = this.data.moods[ds] && this.data.moods[ds].mood;
        b.className = 'hm-face hm-pickface has' + (cur === lvl ? ' is-sel' : '');
        b.innerHTML = faceSVG(lvl, 34);
        b.addEventListener('click', () => {
          const now = this.data.moods[ds] && this.data.moods[ds].mood;
          setVal('mood', now === lvl ? null : lvl);
          faces.querySelectorAll('.hm-pickface').forEach((f, idx) => {
            f.classList.toggle('is-sel', now !== lvl && idx + 1 === lvl);
          });
        });
        faces.appendChild(b);
      }
      panel.appendChild(faces);

      panel.appendChild(this.buildScale('How productive were you?', 'productivity', ds, setVal));
      panel.appendChild(this.buildScale('How stressed were you?', 'stress', ds, setVal));
    });
  }

  buildScale(labelText, kind, ds, setVal) {
    const wrap = document.createElement('div');
    wrap.className = 'hm-scale-wrap';

    const lab = document.createElement('div');
    lab.className = 'hm-panel-label';
    lab.textContent = labelText;
    wrap.appendChild(lab);

    const scale = document.createElement('div');
    scale.className = 'hm-scale';
    const line = document.createElement('div');
    line.className = 'hm-scale-line';
    scale.appendChild(line);

    const cur = this.data.moods[ds] ? this.data.moods[ds][kind] : null;
    const stops = [null, 1, 2, 3, 4, 5];
    stops.forEach((val) => {
      const stop = document.createElement('button');
      const on = (val == null && !cur) || (val != null && cur === val);
      stop.className = 'hm-stop' + (on ? ' is-on' : '');
      stop.innerHTML =
        '<span class="hm-dot"></span><span class="hm-stop-lab">' +
        (val == null ? 'Not set' : val) +
        '</span>';
      stop.addEventListener('click', () => {
        setVal(kind, val);
        scale.querySelectorAll('.hm-stop').forEach((s, idx) => {
          s.classList.toggle('is-on', stops[idx] === val);
        });
      });
      scale.appendChild(stop);
    });

    wrap.appendChild(scale);
    return wrap;
  }

  /* --------------------------- habit editing ------------------------ */

  attachHabitMenu(nameEl, habit) {
    const open = (x, y) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle('Edit habit').setIcon('pencil').onClick(() => this.openHabitPanel(habit, nameEl))
      );
      menu.addItem((i) =>
        i.setTitle('Move up').setIcon('arrow-up').onClick(() => this.move(habit, -1))
      );
      menu.addItem((i) =>
        i.setTitle('Move down').setIcon('arrow-down').onClick(() => this.move(habit, 1))
      );
      menu.addSeparator();
      const used = habitEntryCount(this.data, habit.id);
      menu.addItem((i) => {
        i.setTitle(used ? 'Delete habit (' + used + ' logged days)' : 'Delete habit').setIcon('trash');
        if (i.setDisabled) i.setDisabled(used > 0);
        i.onClick(() => {
          if (habitEntryCount(this.data, habit.id)) {
            new Notice('"' + habit.name + '" has ' + used + ' logged days. Clear them before deleting.');
            return;
          }
          this.data.habits = this.data.habits.filter((h) => h.id !== habit.id);
          delete this.data.logs[habit.id];
          this.plugin.saveState();
        });
      });
      menu.showAtPosition({ x, y });
    };

    nameEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      open(e.clientX, e.clientY);
    });

    let hold = null;
    nameEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      hold = setTimeout(() => {
        hold = null;
        open(e.clientX, e.clientY);
      }, 550);
    });
    const cancel = () => {
      if (hold) clearTimeout(hold);
      hold = null;
    };
    nameEl.addEventListener('pointerup', cancel);
    nameEl.addEventListener('pointermove', cancel);
    nameEl.addEventListener('pointercancel', cancel);
  }

  move(habit, dir) {
    const list = this.data.habits;
    const i = list.findIndex((h) => h.id === habit.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    this.plugin.saveState();
  }

  openHabitPanel(habit, anchor) {
    const editing = !!habit;
    const draft = editing
      ? { name: habit.name, color: habit.color }
      : { name: '', color: PALETTE[this.data.habits.length % PALETTE.length] };

    showPanel(anchor, (panel) => {
      const head = document.createElement('div');
      head.className = 'hm-panel-head';
      head.textContent = editing ? 'Edit habit' : 'New habit';
      panel.appendChild(head);

      const lab = document.createElement('div');
      lab.className = 'hm-panel-label';
      lab.textContent = 'Name';
      panel.appendChild(lab);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'hm-input';
      input.value = draft.name;
      panel.appendChild(input);

      const lab2 = document.createElement('div');
      lab2.className = 'hm-panel-label';
      lab2.textContent = 'Colour';
      panel.appendChild(lab2);

      const sw = document.createElement('div');
      sw.className = 'hm-swatches';
      PALETTE.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'hm-swatch' + (c === draft.color ? ' is-on' : '');
        b.style.background = c;
        b.addEventListener('click', () => {
          draft.color = c;
          sw.querySelectorAll('.hm-swatch').forEach((s) => s.classList.remove('is-on'));
          b.classList.add('is-on');
          custom.value = c;
        });
        sw.appendChild(b);
      });
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.className = 'hm-color';
      custom.value = draft.color;
      custom.addEventListener('input', () => {
        draft.color = custom.value;
        sw.querySelectorAll('.hm-swatch').forEach((s) => s.classList.remove('is-on'));
      });
      sw.appendChild(custom);
      panel.appendChild(sw);

      const actions = document.createElement('div');
      actions.className = 'hm-actions';
      const save = document.createElement('button');
      save.className = 'hm-btn is-primary';
      save.textContent = editing ? 'Save habit' : 'Add habit';
      const commit = () => {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }
        if (editing) {
          habit.name = name;
          habit.color = draft.color;
        } else {
          this.data.habits.push({ id: uid(), name, color: draft.color });
        }
        closePanel();
        this.plugin.saveState();
      };
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
      });
      actions.appendChild(save);
      panel.appendChild(actions);

      setTimeout(() => input.focus(), 30);
    });
  }

  /* ------------------------- panning + zooming ---------------------- */

  attachPan(scroll) {
    // merely touching the grid is not scrolling it - on a phone that happens
    // constantly while a note opens, and it used to cancel the repositioning
    const markUser = () => {
      this.userScrolled = true;
    };
    scroll.addEventListener('touchmove', markUser, { passive: true });
    scroll.addEventListener('wheel', markUser, { passive: true });

    let dragging = false;
    let startX = 0;
    let startScroll = 0;

    scroll.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      dragging = true;
      this.suppressTap = false;
      startX = e.clientX;
      startScroll = scroll.scrollLeft;
      scroll.classList.add('is-dragging');
    });

    scroll.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) {
        this.suppressTap = true;
        this.userScrolled = true;
        e.preventDefault();
      }
      scroll.scrollLeft = startScroll - dx;
    });

    const stop = () => {
      if (!dragging) return;
      dragging = false;
      scroll.classList.remove('is-dragging');
      this.scrollLeft = scroll.scrollLeft;
      setTimeout(() => {
        this.suppressTap = false;
      }, 0);
    };
    scroll.addEventListener('pointerup', stop);
    scroll.addEventListener('pointerleave', stop);
    scroll.addEventListener('pointercancel', stop);
    scroll.addEventListener('scroll', () => {
      this.scrollLeft = scroll.scrollLeft;
    });
  }

  setZoom(nextW, anchorX) {
    const colW = this.colW;
    const w = clamp(Math.round(nextW), MIN_COL, MAX_COL);
    if (w === colW) return;
    const scroll = this.scrollEl;
    const idx = (anchorX + scroll.scrollLeft - this.labelW) / colW;
    this.data.colW = w;
    this.pendingScroll = Math.max(0, idx * w + this.labelW - anchorX);
    this.plugin.queueSave();
    for (const v of this.plugin.views) if (v.mode !== 'log') v.safeRender();
  }

  attachZoom(scroll) {
    scroll.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        if (!e.deltaY) return;
        // swallow it either way, so the note never scrolls out from under the tracker
        e.preventDefault();
        e.stopPropagation();
        const zoomIn = e.deltaY < 0;
        const cur = this.colW;
        if ((zoomIn && cur >= MAX_COL) || (!zoomIn && cur <= MIN_COL)) return;
        const rect = scroll.getBoundingClientRect();
        this.setZoom(cur * (zoomIn ? 1.12 : 0.89), e.clientX - rect.left);
      },
      { passive: false }
    );

    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    scroll.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      pinch = { d: dist(e.touches), w: this.colW };
    });

    scroll.addEventListener(
      'touchmove',
      (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        const rect = scroll.getBoundingClientRect();
        const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const next = pinch.w * (dist(e.touches) / pinch.d);
        if (Math.abs(next - this.colW) >= 2) this.setZoom(next, mid);
      },
      { passive: false }
    );

    const endPinch = () => {
      pinch = null;
    };
    scroll.addEventListener('touchend', endPinch);
    scroll.addEventListener('touchcancel', endPinch);
  }
}

/* ------------------------------------------------------------------ *
 * plugin
 * ------------------------------------------------------------------ */

class HabitMoodPlugin extends Plugin {
  async onload() {
    this.views = new Set();
    this.loaded = false;

    const stored = (await this.loadData()) || {};
    this.settings = { dataPath: stored.dataPath || DEFAULT_PATH };
    this.legacy = stored;
    this.data = cloneDefaults();
    this.normalise();

    const register = (lang, mode) =>
      this.registerMarkdownCodeBlockProcessor(lang, (src, el, ctx) => {
        ctx.addChild(new TrackerView(this, el, mode));
      });

    register('tracker', 'tracker');
    register('habits', 'tracker');
    register('log', 'log');

    this.addSettingTab(new HabitSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on('modify', (f) => this.onFileChanged(f)));
    this.registerEvent(this.app.vault.on('create', (f) => this.onFileChanged(f)));
    this.registerEvent(
      this.app.vault.on('rename', async (f, oldPath) => {
        if (oldPath !== this.settings.dataPath) return;
        this.settings.dataPath = f.path;
        await this.saveData(Object.assign({}, this.legacy, { dataPath: f.path }));
      })
    );

    // the adapter isn't reliable during onload, so read once the vault is up
    this.app.workspace.onLayoutReady(() => this.loadState());
  }

  onunload() {
    this.flushSave();
    closePanel();
  }

  async loadState() {
    const found = await this.locateDataFile();
    if (found && found !== this.settings.dataPath) {
      this.settings.dataPath = found;
      await this.saveData(Object.assign({}, this.legacy, { dataPath: found }));
    }

    const path = this.settings.dataPath;
    const raw = await this.readRaw();
    const fileExists = raw != null;
    let parsed = parseDataFile(raw);

    // a file we cannot read is never overwritten - it may be the only copy
    if (fileExists && !parsed) {
      this.loaded = false;
      console.error('[habit-mood-tracker] could not parse ' + path);
      new Notice('Habit tracker: ' + path + ' could not be read. Nothing was written to it.');
      return;
    }

    let lifted = false;
    if (!parsed) {
      const l = this.legacy || {};
      if (l.habits || l.logs || l.moods) {
        parsed = l;
        lifted = true;
      }
    }

    this.data = Object.assign(cloneDefaults(), parsed || {});
    this.normalise();
    this.lastRaw = raw;
    this.loaded = true;

    if (!fileExists && lifted) {
      await this.writeDataFile();
      new Notice('Habit tracker data moved to ' + path);
    }

    this.refresh();
  }

  normalise() {
    const d = this.data;
    if (!d.logs) d.logs = {};
    if (!d.moods) d.moods = {};
    if (!Array.isArray(d.habits)) d.habits = cloneDefaults().habits;

    if (!Array.isArray(d.columns) || !d.columns.length) {
      const base = d.start || d.anchor || d.rangeStart;
      const weeks = 1 + clamp(Math.round(d.extraWeeks || 0), 0, 52);
      const from = base ? parseISO(base) : mondayOf(new Date());
      const cols = [];
      for (let i = 0; i < weeks * 7; i++) cols.push(iso(addDays(from, i)));
      d.columns = cols;
    }
    delete d.start;
    delete d.anchor;
    delete d.extraWeeks;
    delete d.rangeStart;
    delete d.rangeEnd;
    delete d.dataPath;

    if (d.period === 'day') d.period = 'week';

    for (const k of Object.keys(d.moods)) {
      const m = d.moods[k];
      if (m && m.energy != null && m.productivity == null) {
        m.productivity = m.energy;
        delete m.energy;
      }
    }
  }

  /* ------------------------ vault-backed storage --------------------- */

  // the file may have been moved into a folder; find it by its marker or name
  async locateDataFile() {
    const configured = this.settings.dataPath;
    try {
      if (await this.app.vault.adapter.exists(configured)) return configured;
    } catch (e) {
      /* fall through to the scan */
    }

    const wanted = configured.split('/').pop().toLowerCase();
    let byName = null;
    let files = [];
    try {
      files = this.app.vault.getMarkdownFiles() || [];
    } catch (e) {
      return null;
    }

    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache && cache.frontmatter && cache.frontmatter['habit-tracker-data']) return f.path;
      if (!byName && f.name.toLowerCase() === wanted) byName = f.path;
    }
    return byName;
  }

  async readRaw() {
    const path = this.settings.dataPath;
    try {
      if (await this.app.vault.adapter.exists(path)) {
        return await this.app.vault.adapter.read(path);
      }
    } catch (e) {
      console.error('[habit-mood-tracker] read failed', e);
    }
    // fall back to the vault index in case the adapter path missed
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) return await this.app.vault.read(f);
    } catch (e) {
      console.error('[habit-mood-tracker] vault read failed', e);
    }
    return null;
  }

  async writeDataFile() {
    if (!this.loaded) return; // never persist a state we did not load
    const path = this.settings.dataPath;
    const body = serializeData(this.data);
    if (body === this.lastRaw) return;

    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, body);
      } else if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.write(path, body);
      } else {
        const dir = path.split('/').slice(0, -1).join('/');
        if (dir && !(await this.app.vault.adapter.exists(dir))) {
          try {
            await this.app.vault.createFolder(dir);
          } catch (e) {
            /* already there */
          }
        }
        await this.app.vault.create(path, body);
      }
      this.lastRaw = body;
    } catch (err) {
      console.error('[habit-mood-tracker] could not write ' + path, err);
      new Notice('Habit tracker could not save to ' + path);
    }
  }

  // another device (or you) changed the file
  async onFileChanged(file) {
    if (!file || file.path !== this.settings.dataPath) return;
    const raw = await this.readRaw();
    if (raw == null || raw === this.lastRaw) return;
    const parsed = parseDataFile(raw);
    if (!parsed) return;
    this.lastRaw = raw;
    this.data = Object.assign(cloneDefaults(), parsed);
    this.normalise();
    this.loaded = true;
    this.refresh();
  }

  async saveStateQuiet() {
    await this.writeDataFile();
  }

  async saveState() {
    await this.writeDataFile();
    this.refresh();
  }

  queueSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeDataFile();
    }, 400);
  }

  flushSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeDataFile();
  }

  refresh() {
    for (const v of this.views) v.safeRender();
  }

  async setDataPath(path) {
    this.settings.dataPath = path;
    this.lastRaw = null;
    await this.saveData(Object.assign({}, this.legacy, { dataPath: path }));
    await this.loadState();
  }
}

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

class HabitSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Habits')
      .addButton((b) =>
        b
          .setButtonText('Add habit')
          .setCta()
          .onClick(async () => {
            this.plugin.data.habits.push({
              id: uid(),
              name: 'New habit',
              color: PALETTE[this.plugin.data.habits.length % PALETTE.length],
            });
            await this.plugin.saveState();
            this.display();
          })
      );

    this.plugin.data.habits.forEach((habit, i) => {
      const s = new Setting(containerEl);
      s.addText((t) =>
        t.setValue(habit.name).onChange(async (v) => {
          habit.name = v;
          await this.plugin.saveState();
        })
      );
      s.addColorPicker((c) =>
        c.setValue(habit.color).onChange(async (v) => {
          habit.color = v;
          await this.plugin.saveState();
        })
      );
      s.addExtraButton((b) =>
        b
          .setIcon('arrow-up')
          .setTooltip('Move up')
          .onClick(async () => {
            if (i === 0) return;
            const list = this.plugin.data.habits;
            const tmp = list[i - 1];
            list[i - 1] = list[i];
            list[i] = tmp;
            await this.plugin.saveState();
            this.display();
          })
      );
      const used = habitEntryCount(this.plugin.data, habit.id);
      s.addExtraButton((b) => {
        b.setIcon('trash').setTooltip(
          used
            ? used + ' logged days \u2014 clear them before deleting'
            : 'Delete habit'
        );
        if (used) b.setDisabled(true);
        b.onClick(async () => {
          if (habitEntryCount(this.plugin.data, habit.id)) {
            new Notice('"' + habit.name + '" has ' + used + ' logged days. Clear them before deleting.');
            return;
          }
          this.plugin.data.habits = this.plugin.data.habits.filter((h) => h.id !== habit.id);
          delete this.plugin.data.logs[habit.id];
          await this.plugin.saveState();
          this.display();
        });
      });
    });

    new Setting(containerEl)
      .setName('Zoom')
      .addButton((b) =>
        b.setButtonText('Reset zoom').onClick(async () => {
          this.plugin.data.colW = 0;
          await this.plugin.saveState();
        })
      );

    const d = this.plugin.data || {};
    const moodDays = Object.keys(d.moods || {}).length;
    const habitDays = Object.keys(d.logs || {}).reduce(
      (n, id) => n + Object.keys(d.logs[id] || {}).length,
      0
    );

    new Setting(containerEl)
      .setName('Data file')
      .addText((t) => {
        t.setPlaceholder(DEFAULT_PATH).setValue(this.plugin.settings.dataPath);
        t.onChange((v) => {
          if (this.pathTimer) clearTimeout(this.pathTimer);
          this.pathTimer = setTimeout(async () => {
            let path = (v || '').trim() || DEFAULT_PATH;
            if (!path.toLowerCase().endsWith('.md')) path += '.md';
            await this.plugin.setDataPath(path);
            this.display();
          }, 900);
        });
      });

    new Setting(containerEl)
      .setName('Status')
      .setDesc(
        this.plugin.loaded
          ? 'Loaded ' + (d.habits || []).length + ' habits, ' + habitDays +
            ' logged days and ' + moodDays + ' mood entries.'
          : 'Not loaded. The data file is missing or its JSON block could not be read \u2014 nothing has been written over it.'
      )
      .addButton((b) =>
        b.setButtonText('Reload from file').onClick(async () => {
          this.plugin.lastRaw = null;
          await this.plugin.loadState();
          this.display();
        })
      );

  }
}

module.exports = HabitMoodPlugin;
