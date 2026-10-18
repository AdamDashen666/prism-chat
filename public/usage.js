// 用量统计 page: the caller's own request, token and image counters by day,
// API and model, with a range filter and API / type filters.
import { $, api, busy, createNotice, createSidebar, loadSession, onShown, showUser } from './common.js';

const ui = {
  shell: $('shell'), notice: $('notice'), content: $('content'),
  range: $('range'), account: $('filter-account'), kind: $('filter-kind'), reload: $('reload'),
  kpis: $('kpis'), chart: $('chart'), daily: $('daily-table'), byAccount: $('by-account'), byModel: $('by-model'),
};
const { show: notice } = createNotice(ui.notice);
const state = { days: 30, data: null, active: -1 };
const KINDS = { chat: '对话', image: '图片生成', trace: '模型检测', pelican: '鹈鹕测试' };
const SVG = 'http://www.w3.org/2000/svg';
const WEEKDAYS = '日一二三四五六';

const full = (n) => Number(n || 0).toLocaleString('zh-CN');
const compactFormat = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const compact = (n) => (n >= 10000 ? compactFormat.format(n) : full(n));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// ---------- data ----------
const COUNTERS = ['requests', 'failed', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'images'];
const emptyTotals = () => Object.fromEntries(COUNTERS.map((k) => [k, 0]));
function add(t, r) {
  for (const k of COUNTERS) t[k] += r[k] || 0;
  return t;
}
const nameOf = (id) => state.data?.names?.[id] || (id.startsWith('manual:') ? `${id.slice(7)}（临时输入）` : id);

function filteredRows() {
  const account = ui.account.value;
  const kind = ui.kind.value;
  return (state.data?.rows || []).filter((r) => (!account || r.accountId === account) && (!kind || r.kind === kind));
}

// Every day of the range, oldest first, including days without requests.
function dayList() {
  const out = [];
  const end = Date.parse(`${state.data.today}T00:00:00Z`);
  for (let i = state.data.days - 1; i >= 0; i--) out.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  return out;
}

const dayLabel = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
const weekday = (day) => `周${WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;

// ---------- KPI row ----------
function renderKpis(totals) {
  const tile = (label, value, title, sub) => {
    const box = el('div', 'kpi');
    box.append(el('span', 'kpi-label', label));
    const v = el('strong', 'kpi-value', value);
    v.title = title;
    box.append(v);
    if (sub) box.append(el('span', 'kpi-sub', sub));
    return box;
  };
  ui.kpis.replaceChildren(
    tile('请求次数', compact(totals.requests), `${full(totals.requests)} 次`, totals.failed ? `其中失败 ${full(totals.failed)} 次` : '没有失败的请求'),
    tile('输入 tokens', compact(totals.input), full(totals.input), totals.cacheRead ? `其中缓存命中 ${full(totals.cacheRead)}（${Math.round((100 * totals.cacheRead) / (totals.input || 1))}%）` : ''),
    tile('输出 tokens', compact(totals.output), full(totals.output), totals.reasoning ? `其中推理 ${full(totals.reasoning)}` : ''),
    tile('生成图片', compact(totals.images), `${full(totals.images)} 张`),
  );
}

// ---------- daily chart ----------
function niceTicks(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { ticks, top };
}

// Column with a 4px rounded data end and a square foot on the baseline.
function topRounded(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderChart(perDay) {
  const tooltip = el('div', 'tooltip');
  tooltip.setAttribute('role', 'status');
  const max = Math.max(0, ...perDay.map((d) => d.input + d.output));
  if (!max) {
    ui.chart.replaceChildren(el('p', 'chart-empty', state.data.rows.length ? '这段时间、这个筛选条件下没有 tokens 记录。' : '还没有用量记录。在模型对话、图片生成或模型检测里发出请求后，这里会按天汇总。'));
    return;
  }
  const width = Math.max(320, ui.chart.clientWidth || 640);
  const height = 240;
  const pad = { top: 10, right: 6, bottom: 26, left: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const base = pad.top + plotH;
  const { ticks, top } = niceTicks(max);
  const band = plotW / perDay.length;
  const barW = Math.max(2, Math.min(24, band * 0.62));
  const y = (v) => base - (plotH * v) / top;

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: '0', 'aria-label': `每日 tokens 柱状图，共 ${perDay.length} 天。用左右方向键逐天查看数值；完整数据见下方“按日明细”。` });
  for (const t of ticks) {
    const ty = Math.round(y(t)) + 0.5;
    if (t > 0) root.append(svg('line', { class: 'grid', x1: pad.left, x2: width - pad.right, y1: ty, y2: ty }));
    const label = svg('text', { class: 'tick', x: pad.left - 8, y: ty + 4, 'text-anchor': 'end' });
    label.textContent = compact(t);
    root.append(label);
  }
  const bands = [];
  perDay.forEach((d, i) => {
    const wash = svg('rect', { class: 'band', x: pad.left + band * i, y: pad.top, width: band, height: plotH, rx: 4 });
    bands.push(wash);
    root.append(wash);
  });
  perDay.forEach((d, i) => {
    const x = pad.left + band * i + (band - barW) / 2;
    const hIn = (plotH * d.input) / top;
    const hOut = (plotH * d.output) / top;
    // 2px surface gap between the two segments, taken from where they meet.
    const gap = hIn > 0 && hOut > 0 ? 1 : 0;
    if (hIn > 0) {
      const h = Math.max(hOut > 0 ? 0.5 : 1, hIn - gap);
      root.append(hOut > 0 ? svg('rect', { class: 'bar-input', x, y: base - h, width: barW, height: h }) : svg('path', { class: 'bar-input', d: topRounded(x, base - h, barW, h) }));
    }
    if (hOut > 0) {
      const h = Math.max(1, hOut - gap);
      root.append(svg('path', { class: 'bar-output', d: topRounded(x, base - hIn - hOut, barW, h) }));
    }
  });
  root.append(svg('line', { class: 'baseline', x1: pad.left, x2: width - pad.right, y1: base + 0.5, y2: base + 0.5 }));
  const every = Math.max(1, Math.ceil(perDay.length / Math.max(1, Math.floor(plotW / 56))));
  perDay.forEach((d, i) => {
    if ((perDay.length - 1 - i) % every) return; // always label the latest day
    const label = svg('text', { class: 'tick', x: pad.left + band * i + band / 2, y: height - 6, 'text-anchor': 'middle' });
    label.textContent = perDay.length === 1 ? dayLabel(d.day) : `${Number(d.day.slice(5, 7))}/${Number(d.day.slice(8))}`;
    root.append(label);
  });
  const hit = svg('rect', { class: 'hit', x: pad.left, y: pad.top, width: plotW, height: plotH + pad.bottom });
  root.append(hit);

  const show = (i) => {
    state.active = i;
    bands.forEach((b, k) => b.classList.toggle('active', k === i));
    if (i < 0) { tooltip.classList.remove('show'); return; }
    const d = perDay[i];
    const row = (cls, value, label) => {
      const r = el('div', 'tooltip-row');
      r.append(el('i', `line ${cls}`), el('strong', '', value), el('span', '', label));
      return r;
    };
    tooltip.replaceChildren(
      el('p', 'tooltip-title', `${dayLabel(d.day)} ${weekday(d.day)}`),
      row('input', full(d.input), '输入 tokens'),
      row('output', full(d.output), '输出 tokens'),
      ...(d.reasoning ? [row('none', full(d.reasoning), '其中推理')] : []),
      row('none', `${full(d.requests)} 次`, d.failed ? `请求（失败 ${d.failed}）` : '请求'),
      ...(d.images ? [row('none', `${full(d.images)} 张`, '图片')] : []),
    );
    tooltip.classList.add('show');
    const scale = ui.chart.clientWidth / width;
    const cx = (pad.left + band * i + band / 2) * scale;
    const left = Math.min(Math.max(0, cx - tooltip.offsetWidth / 2), ui.chart.clientWidth - tooltip.offsetWidth);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(0, y(d.input + d.output) * scale - tooltip.offsetHeight - 12)}px`;
  };
  const indexAt = (event) => {
    const box = root.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * width;
    return Math.min(perDay.length - 1, Math.max(0, Math.floor((x - pad.left) / band)));
  };
  hit.addEventListener('pointermove', (e) => show(indexAt(e)));
  hit.addEventListener('pointerdown', (e) => show(indexAt(e)));
  root.addEventListener('pointerleave', () => { if (document.activeElement !== root) show(-1); });
  root.addEventListener('focus', () => show(state.active >= 0 ? state.active : perDay.length - 1));
  root.addEventListener('blur', () => show(-1));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(Math.min(perDay.length - 1, Math.max(0, (state.active < 0 ? perDay.length - 1 : state.active) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : perDay.length - 1);
    } else if (e.key === 'Escape') show(-1);
  });
  ui.chart.replaceChildren(root, tooltip);
  state.active = -1;
}

// ---------- tables ----------
function table(headers, rows) {
  const t = el('table', 'usage-table');
  const head = el('tr');
  for (const h of headers) {
    const th = el('th', '', h);
    th.scope = 'col';
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    for (const c of cells) tr.append(c);
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}
const num = (n, cls = '') => el('td', n ? cls : 'zero', full(n));
function nameCell(main, sub) {
  const td = el('td', 'name', main);
  td.title = sub ? `${main}\n${sub}` : main;
  if (sub) td.append(el('small', '', sub));
  return td;
}

function grouped(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    const g = map.get(key) || { key, totals: emptyTotals(), kinds: new Set(), accounts: new Set() };
    add(g.totals, r);
    g.kinds.add(r.kind);
    g.accounts.add(r.accountId);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => (b.totals.input + b.totals.output) - (a.totals.input + a.totals.output) || b.totals.requests - a.totals.requests);
}

const kindText = (kinds) => [...kinds].map((k) => KINDS[k] || k).join('、');

function renderTables(rows, perDay) {
  if (!rows.length) {
    for (const box of [ui.byAccount, ui.byModel, ui.daily]) box.replaceChildren(el('p', 'empty-note', '没有记录'));
    return;
  }
  ui.byAccount.replaceChildren(table(['API', '请求', '失败', '输入', '输出', '图片'], grouped(rows, (r) => r.accountId).map((g) => [
    nameCell(nameOf(g.key), kindText(g.kinds)), num(g.totals.requests), num(g.totals.failed, 'failed'), num(g.totals.input), num(g.totals.output), num(g.totals.images),
  ])));

  const models = grouped(rows, (r) => r.model);
  const totalTokens = models.reduce((s, g) => s + g.totals.input + g.totals.output, 0) || 1;
  ui.byModel.replaceChildren(table(['模型', '请求', '输入', '输出', 'tokens 占比', '图片'], models.map((g) => {
    const share = (g.totals.input + g.totals.output) / totalTokens;
    const cell = el('td');
    const wrap = el('div', 'share');
    const bar = el('span', 'share-bar');
    const fill = el('i');
    fill.style.width = `${(share * 100).toFixed(1)}%`; // CSSOM: allowed by the page CSP
    bar.append(fill);
    wrap.append(bar, el('span', '', `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`));
    cell.append(wrap);
    const apis = [...g.accounts].map(nameOf);
    return [nameCell(g.key, apis.length > 2 ? `${apis.slice(0, 2).join('、')} 等 ${apis.length} 个 API` : apis.join('、')), num(g.totals.requests), num(g.totals.input), num(g.totals.output), cell, num(g.totals.images)];
  })));

  ui.daily.replaceChildren(table(['日期', '请求', '失败', '输入', '输出', '推理', '图片'], [...perDay].reverse().filter((d) => d.requests).map((d) => [
    el('td', '', `${d.day} ${weekday(d.day)}`), num(d.requests), num(d.failed, 'failed'), num(d.input), num(d.output), num(d.reasoning), num(d.images),
  ])));
}

// ---------- page ----------
function perDayTotals(rows) {
  const byDay = new Map(dayList().map((day) => [day, { day, ...emptyTotals() }]));
  for (const r of rows) if (byDay.has(r.day)) add(byDay.get(r.day), r);
  return [...byDay.values()];
}

function render() {
  if (!state.data) return;
  const rows = filteredRows();
  const perDay = perDayTotals(rows);
  renderKpis(rows.reduce(add, emptyTotals()));
  renderChart(perDay);
  renderTables(rows, perDay);
}

function renderAccountFilter() {
  const keep = ui.account.value;
  const ids = [...new Set((state.data?.rows || []).map((r) => r.accountId))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  ui.account.replaceChildren(new Option('全部', ''), ...ids.map((id) => new Option(nameOf(id), id)));
  ui.account.value = ids.includes(keep) ? keep : '';
}

async function load() {
  ui.content.classList.add('loading'); // keep the previous render visible while refetching
  try {
    state.data = await api(`/api/chat/usage?days=${state.days}`);
    renderAccountFilter();
    render();
  } catch (error) {
    notice(error.message || '加载失败');
  } finally {
    ui.content.classList.remove('loading');
  }
}

function setRange(days) {
  state.days = days;
  for (const b of ui.range.querySelectorAll('button')) {
    const on = Number(b.dataset.days) === days;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function bind() {
  createSidebar({ shell: ui.shell, openButton: $('open-sidebar'), closeButton: $('close-sidebar'), backdrop: $('backdrop') });
  const buttons = [...ui.range.querySelectorAll('button')];
  for (const b of buttons) {
    b.addEventListener('click', () => { setRange(Number(b.dataset.days)); load(); });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = buttons[(buttons.indexOf(b) + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      next.click();
    });
  }
  ui.account.addEventListener('change', render);
  ui.kind.addEventListener('change', render);
  ui.reload.addEventListener('click', () => busy(ui.reload, load));
  // The chart is drawn in pixels of its box; redraw when the box width changes.
  let width = 0;
  new ResizeObserver(() => {
    if (ui.chart.clientWidth === width) return;
    width = ui.chart.clientWidth;
    if (state.data) renderChart(perDayTotals(filteredRows()));
  }).observe(ui.chart);
}

async function init() {
  bind();
  setRange(state.days);
  ui.shell.classList.add('ready');
  try { showUser(await loadSession()); } catch (error) { notice(error.message || '加载失败'); return; }
  await load();
  // New requests made in 模型对话 / 模型检测 while this page was out of view.
  onShown(load);
}

init();
