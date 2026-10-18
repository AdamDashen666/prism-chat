// Codex 转发 (admin): ChatGPT login status, the login wizard, models, API keys and recent problems.
import { $, api, busy, createNotice, createSidebar, loadSession, onShown, showUser } from './common.js';
import { bindCopyDialog, createClipboard } from './clip.js';

const ui = {
  shell: $('shell'), notice: $('notice'),
  badge: $('status-badge'), alert: $('status-alert'), grid: $('status-grid'), limits: $('limits'), testResult: $('test-result'),
  login: $('btn-login'), refresh: $('btn-refresh'), test: $('btn-test'), disconnect: $('btn-disconnect'),
  loginCard: $('login-card'), tabWeb: $('tab-web'), tabImport: $('tab-import'), paneWeb: $('pane-web'), paneImport: $('pane-import'),
  redirect: $('redirect'), start: $('btn-start'), linkBox: $('link-box'), link: $('auth-link'), open: $('btn-open'), copyLink: $('btn-copy-link'), timer: $('link-timer'),
  callback: $('callback'), complete: $('btn-complete'), authJson: $('auth-json'), import: $('btn-import'),
  models: $('models'), modelsNote: $('models-note'), modelsDebug: $('models-debug'), customForm: $('custom-form'), customInput: $('custom-models'), customSave: $('custom-save'), keys: $('keys'), keyForm: $('key-form'), keyName: $('key-name'), keyCreate: $('key-create'), toggleKey: $('toggle-key'),
  errors: $('errors'), baseUrl: $('base-url'), curl: $('curl-example'),
  dialog: $('models-dialog'), modelsList: $('models-list'), modelsCount: $('models-count'), modelsAll: $('models-all'),
};
const { show: notice } = createNotice(ui.notice);
const { copyValue, copyText } = createClipboard(notice);
const state = { data: null, link: null, linkTimer: 0, fresh: '', dialogModels: [] };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

// ---------- formatting ----------
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '从未');
function span(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s} 秒`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟`;
  if (s < 129600) return `${Math.round(s / 3600)} 小时`;
  return `${Math.round(s / 86400)} 天`;
}
const until = (ms) => (!ms ? '未知' : ms <= Date.now() ? '已过期' : `${span(ms - Date.now())}后`);
const ago = (ms) => (!ms ? '从未' : `${span(Date.now() - ms)}前`);
const PLAN = { plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', team: 'ChatGPT Team', business: 'ChatGPT Business', enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu', free: 'ChatGPT Free' };
const KIND = { refresh: '刷新令牌', login: '登录', models: '模型列表', proxy: '转发' };

function windowName(minutes) {
  if (!minutes) return '用量窗口';
  if (minutes >= 10000) return '每周额度';
  if (minutes % 60 === 0 && minutes <= 24 * 60) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}
const epochMs = (n) => (n > 1e12 ? n : n * 1000);

// ---------- status ----------
const STATES = {
  connected: ['已连接', 'on'], needs_login: ['需要重新登录', 'bad'], disconnected: ['未登录', 'off'], broken: ['状态文件异常', 'bad'],
};

function renderStatus() {
  const d = state.data;
  const [label, tone] = STATES[d.state] || ['未知', 'off'];
  ui.badge.textContent = label;
  ui.badge.className = `badge ${tone}`;

  const alert = d.loadError || (d.state === 'needs_login' ? `登录已失效：${d.needsLogin || '需要重新登录'}。请点“重新登录”，API Key 不受影响。` : '');
  ui.alert.hidden = !alert;
  ui.alert.textContent = alert;

  ui.grid.replaceChildren();
  const row = (name, value) => {
    const wrap = el('div');
    wrap.append(el('dt', '', name), el('dd', '', value));
    ui.grid.append(wrap);
  };
  if (d.account) {
    row('账号', d.account.email || '（令牌里没有邮箱）');
    row('订阅', PLAN[d.account.plan] || d.account.plan || '未知');
    row('ChatGPT 账号 ID', d.account.accountId || '—');
  } else row('账号', '未登录');
  if (d.state !== 'disconnected') {
    row('访问令牌有效期', d.accessExpiresAt ? `${until(d.accessExpiresAt)}（${when(d.accessExpiresAt)}）` : '未知');
    row('上次刷新', `${ago(d.lastRefreshAt)}${d.refreshing ? ' · 正在刷新…' : ''}`);
    if (d.retryAt && d.retryAt > Date.now()) row('下次自动重试', `${until(d.retryAt)}（上次刷新遇到临时错误）`);
  }

  renderLimits(d.limits);
  const connected = d.state === 'connected';
  ui.login.querySelector('span').textContent = d.state === 'disconnected' ? '登录 ChatGPT' : '重新登录';
  ui.login.disabled = d.state === 'broken';
  ui.refresh.disabled = d.state === 'disconnected' || d.state === 'broken' || d.state === 'needs_login';
  ui.test.disabled = !connected;
  ui.disconnect.disabled = d.state === 'disconnected' || d.state === 'broken';
}

function renderLimits(limits) {
  ui.limits.replaceChildren();
  const windows = limits ? [limits.primary, limits.secondary].filter(Boolean) : [];
  ui.limits.hidden = !windows.length;
  if (!windows.length) return;
  ui.limits.append(el('h3', '', `订阅用量（${ago(limits.at)}更新，随请求刷新）`));
  for (const w of windows) {
    const pct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
    const line = el('div', 'limit');
    const head = el('div', 'limit-head');
    head.append(el('span', '', windowName(w.windowMinutes)), el('strong', pct >= 90 ? 'bad' : '', `已用 ${pct.toFixed(pct % 1 ? 1 : 0)}%`));
    const bar = el('div', 'limit-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    const fill = el('i');
    fill.style.width = `${pct}%`;
    fill.className = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
    bar.append(fill);
    line.append(head, bar);
    if (w.resetAt) line.append(el('p', 'muted small', `${until(epochMs(w.resetAt))}重置（${when(epochMs(w.resetAt))}）`));
    ui.limits.append(line);
  }
  if (limits.reached) ui.limits.append(el('p', 'import-warn', `已触达限额：${limits.reached}`));
  if (limits.credits && !limits.credits.unlimited && limits.credits.has) ui.limits.append(el('p', 'muted small', `额外点数余额：${limits.credits.balance || '有'}`));
}

// ---------- models ----------
function renderModels() {
  const d = state.data;
  ui.models.replaceChildren();
  const items = d.models?.items || [];
  ui.modelsNote.textContent = d.models ? `${ago(d.models.fetchedAt)}更新${d.clientVersion ? ` · 以 Codex ${d.clientVersion} 的身份读取` : ''}` : '';
  if (document.activeElement !== ui.customInput) ui.customInput.value = (d.customModels || []).join(', ');
  const visible = items.filter((x) => x.visible);
  if (!items.length) ui.models.append(el('span', 'muted', d.state === 'connected' ? '还没有读取模型，点“测试连接”获取' : '登录后显示'));
  for (const m of visible) {
    const chip = el('button', 'chip' + (m.custom ? ' custom' : ''));
    chip.type = 'button';
    chip.title = m.description || m.name;
    chip.append(el('span', 'chip-id', m.id), icon('i-copy'));
    if (m.efforts?.length) chip.append(el('small', '', m.efforts.join('/')));
    if (m.custom) chip.append(el('small', '', '手动'));
    chip.addEventListener('click', () => copyText(m.id, ` ${m.id}`));
    ui.models.append(chip);
  }
  const hidden = items.filter((x) => !x.visible);
  if (hidden.length) ui.models.append(el('span', 'muted small', `另有 ${hidden.length} 个未列出的模型（${hidden.map((m) => m.id).join('、')}）也可以直接指定`));
  // Why the list is short: what the backend actually answered.
  const debug = d.models?.debug;
  const noneListed = d.state === 'connected' && debug && !items.some((x) => x.visible && !x.custom);
  ui.modelsDebug.hidden = !noneListed;
  if (noneListed) {
    ui.modelsDebug.textContent = `ChatGPT 没有返回可列出的模型（HTTP ${debug.status}，共 ${debug.entries} 项，已试 Codex 版本 ${debug.versions.join('、')}，返回字段：${debug.fields.join('、') || '无'}${debug.entryFields?.length ? `；单项字段：${debug.entryFields.join('、')}` : ''}）。不影响调用：在下面手动填上要用的模型 ID 即可。`;
  }
}

function visibleModels() { return (state.data?.models?.items || []).filter((m) => m.visible).map((m) => m.id); }

function copyModels() {
  const models = visibleModels();
  if (!models.length) { notice('还没有模型，请先点“测试连接”'); return; }
  if (models.length === 1) { copyText(models[0], '模型名称'); return; }
  state.dialogModels = models;
  ui.modelsList.replaceChildren(...models.map((m) => {
    const li = el('li');
    const b = el('button', 'model-row');
    b.type = 'button';
    b.append(el('span', 'model-id', m), icon('i-copy'));
    b.addEventListener('click', () => copyText(m, ` ${m}`));
    li.append(b);
    return li;
  }));
  ui.modelsCount.textContent = `${models.length} 个模型`;
  ui.dialog.showModal();
}

// ---------- keys ----------
function button(label, iconName, onClick, className = '') {
  const b = el('button', `entry-button ${className}`.trim());
  b.type = 'button';
  b.append(icon(iconName), el('span', '', label));
  b.addEventListener('click', () => busy(b, async () => {
    try { await onClick(); } catch (error) { notice(error.message || '操作失败'); }
  }));
  return b;
}

function keyCard(k) {
  const d = state.data;
  const ok = d.state === 'connected';
  const card = el('article', `relay-card ${ok ? 'tone-on' : 'tone-off'}${state.fresh === k.id ? ' fresh' : ''}`);
  const header = el('header', 'entry-header');
  const symbol = el('div', 'entry-symbol');
  symbol.append(icon('i-codex'));
  const identity = el('div', 'entry-identity');
  identity.append(el('h2', '', k.name));
  const url = el('p', 'entry-url', d.base);
  url.title = d.base;
  identity.append(url);
  const health = el('span', `health-label ${ok ? 'on' : 'off'}`);
  health.append(icon(ok ? 'i-ok' : 'i-pause'), el('span', '', ok ? '可用' : '未连接'));
  header.append(symbol, identity, health);

  const stats = el('div', 'entry-stats');
  const count = el('div');
  count.append(el('span', 'muted', '请求次数'), el('strong', 'amount', Number(k.requests || 0).toLocaleString('zh-CN')));
  const side = el('div', 'stats-side');
  side.append(el('span', 'muted', '失败'), el('strong', k.errors ? 'bad' : '', String(k.errors || 0)));
  stats.append(count, side);

  const used = el('p', 'entry-checked', `最后使用 ${k.lastUsedAt ? `${ago(k.lastUsedAt)}（${when(k.lastUsedAt)}）` : '从未'}`);
  const source = el('p', 'entry-source');
  source.append(el('span', 'muted', 'Key'), el('span', '', `sk-codex-…${k.tail}`));

  const copies = el('div', 'copy-actions');
  copies.append(
    button('复制密钥', 'i-key', () => copyValue(async () => (await api(`/api/chat/codex/keys/${k.id}/key`, { method: 'POST', body: {} })).value, 'Codex Key')),
    button('复制地址', 'i-link', () => copyText(d.base, '接口地址')),
    button('复制模型', 'i-boxes', async () => copyModels()),
  );
  const manage = el('div', 'manage-actions two');
  manage.append(
    button('重命名', 'i-pencil', async () => {
      const name = prompt('新的名称', k.name);
      if (name === null || !name.trim()) return;
      state.data = await api(`/api/chat/codex/keys/${k.id}/update`, { method: 'POST', body: { name: name.trim() } });
      render();
    }),
    button('撤销', 'i-trash', async () => {
      if (!confirm(`撤销“${k.name}”？使用它的客户端会立即无法访问，且不能恢复。`)) return;
      state.data = await api(`/api/chat/codex/keys/${k.id}/delete`, { method: 'POST', body: {} });
      render();
    }, 'delete-action'),
  );
  const actions = el('div', 'entry-actions');
  actions.append(copies, manage);
  const footer = el('div', 'entry-footer');
  footer.append(el('span', 'muted small', `创建于 ${when(k.createdAt)}`));
  card.append(header, stats, used, source, actions, footer);
  return card;
}

function renderKeys() {
  ui.keys.replaceChildren();
  const keys = state.data.keys;
  if (!keys.length) {
    const empty = el('div', 'card empty-card');
    empty.append(icon('i-codex'), el('h2', '', '还没有 Key'), el('p', 'muted', '点右上角“新建 Key”，生成给客户端用的专用 Key。'));
    ui.keys.append(empty);
    return;
  }
  for (const k of keys) ui.keys.append(keyCard(k));
}

function renderErrors() {
  ui.errors.replaceChildren();
  const list = state.data.errors || [];
  if (!list.length) { ui.errors.append(el('li', 'muted', '没有记录到问题')); return; }
  for (const e of list) {
    const li = el('li');
    li.append(el('time', 'muted small', when(e.at)), el('span', 'badge off', KIND[e.kind] || e.kind), el('span', 'err-text', e.message));
    ui.errors.append(li);
  }
}

function renderHelp() {
  ui.baseUrl.textContent = state.data.base;
  ui.curl.textContent = `curl ${state.data.base}/chat/completions \\\n  -H "Authorization: Bearer sk-codex-你的Key" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${visibleModels()[0] || 'gpt-5-codex'}","messages":[{"role":"user","content":"你好"}]}'`;
}

function render() {
  renderStatus();
  renderModels();
  renderKeys();
  renderErrors();
  renderHelp();
}

async function load() {
  try {
    state.data = await api('/api/chat/codex');
    render();
  } catch (error) { notice(error.message || '加载失败'); }
}

// ---------- login ----------
function setTab(web) {
  ui.tabWeb.setAttribute('aria-selected', String(web));
  ui.tabImport.setAttribute('aria-selected', String(!web));
  ui.paneWeb.hidden = !web;
  ui.paneImport.hidden = web;
}

function openLogin() {
  ui.loginCard.hidden = false;
  setTab(true);
  ui.loginCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeLogin() {
  ui.loginCard.hidden = true;
  ui.callback.value = '';
  ui.authJson.value = '';
  ui.linkBox.hidden = true;
  state.link = null;
  clearInterval(state.linkTimer);
}

function tickLink() {
  if (!state.link) return;
  const left = state.link.expiresAt - Date.now();
  ui.timer.textContent = left > 0 ? `链接 ${span(left)}内有效` : '链接已过期，请重新生成';
  if (left <= 0) clearInterval(state.linkTimer);
}

async function finished(message) {
  closeLogin();
  await load();
  notice(message, 'info');
}

function bind() {
  createSidebar({ shell: ui.shell, openButton: $('open-sidebar'), closeButton: $('close-sidebar'), backdrop: $('backdrop') });
  bindCopyDialog();
  ui.login.addEventListener('click', openLogin);
  $('login-close').addEventListener('click', closeLogin);
  ui.tabWeb.addEventListener('click', () => setTab(true));
  ui.tabImport.addEventListener('click', () => setTab(false));

  ui.start.addEventListener('click', () => busy(ui.start, async () => {
    try {
      const data = await api('/api/chat/codex/login/start', { method: 'POST', body: { redirect: ui.redirect.value } });
      state.link = data.login;
      ui.link.value = data.login.url;
      ui.linkBox.hidden = false;
      clearInterval(state.linkTimer);
      state.linkTimer = setInterval(tickLink, 1000);
      tickLink();
      ui.callback.focus({ preventScroll: true });
    } catch (error) { notice(error.message || '生成失败'); }
  }));
  ui.open.addEventListener('click', () => { if (state.link) window.open(state.link.url, '_blank', 'noopener'); });
  ui.copyLink.addEventListener('click', () => copyText(ui.link.value, '授权链接'));
  ui.complete.addEventListener('click', () => busy(ui.complete, async () => {
    try {
      await api('/api/chat/codex/login/complete', { method: 'POST', body: { url: ui.callback.value.trim() } });
      await finished('登录成功，服务器会自动刷新令牌');
    } catch (error) { notice(error.message || '登录失败'); }
  }));
  ui.import.addEventListener('click', () => busy(ui.import, async () => {
    try {
      await api('/api/chat/codex/import', { method: 'POST', body: { json: ui.authJson.value.trim() } });
      await finished('已导入并接管登录');
    } catch (error) { notice(error.message || '导入失败'); }
  }));

  ui.refresh.addEventListener('click', () => busy(ui.refresh, async () => {
    try { state.data = await api('/api/chat/codex/refresh', { method: 'POST', body: {} }); render(); notice('令牌已刷新', 'info'); }
    catch (error) { notice(error.message || '刷新失败'); await load(); }
  }));
  ui.test.addEventListener('click', () => busy(ui.test, async () => {
    try {
      const data = await api('/api/chat/codex/test', { method: 'POST', body: {} });
      state.data = data;
      render();
      ui.testResult.hidden = false;
      ui.testResult.className = `test-result ${data.ok ? 'ok' : 'bad'}`;
      ui.testResult.textContent = data.message;
    } catch (error) { notice(error.message || '测试失败'); }
  }));
  ui.disconnect.addEventListener('click', () => busy(ui.disconnect, async () => {
    if (!confirm('断开连接？服务器会删除保存的登录令牌并向 OpenAI 撤销它。API Key 会保留，但重新登录前无法使用。')) return;
    try {
      const data = await api('/api/chat/codex/disconnect', { method: 'POST', body: {} });
      state.data = data;
      render();
      ui.testResult.hidden = true;
      notice(data.revoked ? '已断开，并已在 OpenAI 撤销令牌' : '已断开。没能联系上 OpenAI 撤销令牌，建议在 ChatGPT 设置里检查已登录的设备', data.revoked ? 'info' : 'error');
    } catch (error) { notice(error.message || '断开失败'); }
  }));

  ui.toggleKey.addEventListener('click', () => {
    const open = ui.keyForm.hidden;
    ui.keyForm.hidden = !open;
    ui.toggleKey.setAttribute('aria-expanded', String(open));
    if (open) ui.keyName.focus();
  });
  ui.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ui.keyCreate, async () => {
      try {
        const data = await api('/api/chat/codex/keys', { method: 'POST', body: { name: ui.keyName.value.trim() || '未命名' } });
        state.data = data;
        state.fresh = data.key.id;
        ui.keyName.value = '';
        ui.keyForm.hidden = true;
        ui.toggleKey.setAttribute('aria-expanded', 'false');
        render();
        notice('已创建，点卡片上的“复制密钥”即可使用', 'info');
      } catch (error) { notice(error.message || '创建失败'); }
    });
  });
  ui.customForm.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(ui.customSave, async () => {
      try {
        state.data = await api('/api/chat/codex/models/custom', { method: 'POST', body: { models: ui.customInput.value } });
        render();
        notice('已保存手动添加的模型', 'info');
      } catch (error) { notice(error.message || '保存失败'); }
    });
  });
  $('models-close').addEventListener('click', () => ui.dialog.close());
  ui.dialog.addEventListener('click', (e) => { if (e.target === ui.dialog) ui.dialog.close(); });
  ui.modelsAll.addEventListener('click', () => copyText(state.dialogModels.join('\n'), '全部模型名称'));
}

async function init() {
  bind();
  ui.shell.classList.add('ready');
  let session;
  try { session = await loadSession(); showUser(session); } catch (error) { notice(error.message || '加载失败'); return; }
  if (!session.isAdmin) { ui.grid.textContent = '只有管理员可以使用 Codex 转发'; return; }
  await load();
  onShown(load);
  // The token refreshes itself on the server; keep the page's numbers current while it is open.
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
}

init();
