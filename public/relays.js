// API 中转 page: relays shown as cards like the saved APIs on API 管理, each with
// copy key / address / models, pause, key reset, rename and delete.
import { $, api, busy, createNotice, createSidebar, loadSession, onShown, showUser } from './common.js';
import { bindCopyDialog, createClipboard } from './clip.js';

const ui = {
  shell: $('shell'), notice: $('notice'), toggleCreate: $('toggle-create'), createCard: $('create-card'),
  form: $('create-form'), account: $('account'), name: $('name'), create: $('create'), list: $('list'),
  dialog: $('models-dialog'), modelsList: $('models-list'), modelsSearch: $('models-search'), modelsAll: $('models-all'),
  modelsCount: $('models-count'), modelsClose: $('models-close'),
};
const { show: notice } = createNotice(ui.notice);
const state = { base: '', relays: [], accounts: [], open: new Set(), models: [], fresh: '' };

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

const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '从未');
const openaiBase = () => `${state.base}/v1`;
const accountOf = (r) => state.accounts.find((a) => a.id === r.accountId);
// "原 API 名 中转" unless the name already says so.
const titleOf = (r) => {
  const name = (r.name || accountOf(r)?.name || r.host || 'API').trim();
  return /中转$/.test(name) ? name : `${name} 中转`;
};

const { copyValue, copyText } = createClipboard(notice);

function button(label, iconName, onClick, className = '') {
  const b = el('button', `entry-button ${className}`.trim());
  b.type = 'button';
  b.append(icon(iconName), el('span', '', label));
  b.addEventListener('click', () => busy(b, async () => {
    try { await onClick(); } catch (error) { notice(error.message || '操作失败'); }
  }));
  return b;
}

// ---------- models dialog ----------
function renderModels() {
  const q = ui.modelsSearch.value.trim().toLowerCase();
  const shown = state.models.filter((m) => m.toLowerCase().includes(q));
  ui.modelsList.replaceChildren(...shown.map((m) => {
    const li = el('li');
    const b = el('button', 'model-row');
    b.type = 'button';
    b.append(el('span', 'model-id', m), icon('i-copy'));
    b.addEventListener('click', () => copyText(m, ` ${m}`));
    li.append(b);
    return li;
  }));
  ui.modelsCount.textContent = `${shown.length} / ${state.models.length} 个模型`;
}

async function modelsFor(r) {
  const saved = accountOf(r)?.models || [];
  if (saved.length) return saved;
  // Nothing saved on the original API: ask its model list (through this site, like 模型对话 does).
  const data = await api('/api/chat/models', { method: 'POST', body: { accountId: r.accountId } });
  return data.models || [];
}

async function copyModels(r) {
  const models = await modelsFor(r);
  if (!models.length) { notice('原 API 没有可复制的模型'); return; }
  if (models.length === 1) { await copyText(models[0], '模型名称'); return; }
  state.models = models;
  ui.modelsSearch.value = '';
  renderModels();
  ui.dialog.showModal();
  ui.modelsSearch.focus();
}

// ---------- cards ----------
function relayCard(r) {
  const account = accountOf(r);
  const card = el('article', `relay-card ${r.enabled ? 'tone-on' : 'tone-off'}${state.fresh === r.id ? ' fresh' : ''}`);

  const header = el('header', 'entry-header');
  const symbol = el('div', 'entry-symbol');
  symbol.append(icon('i-relay'));
  const identity = el('div', 'entry-identity');
  identity.append(el('h2', '', titleOf(r)));
  const url = el('p', 'entry-url', openaiBase());
  url.title = openaiBase();
  identity.append(url);
  const health = el('span', `health-label ${r.enabled ? 'on' : 'off'}`);
  health.append(icon(r.enabled ? 'i-ok' : 'i-pause'), el('span', '', r.enabled ? '启用中' : '已停用'));
  header.append(symbol, identity, health);

  const stats = el('div', 'entry-stats');
  const count = el('div');
  count.append(el('span', 'muted', '请求次数'), el('strong', 'amount', Number(r.requests || 0).toLocaleString('zh-CN')));
  const side = el('div', 'stats-side');
  side.append(el('span', 'muted', '失败'), el('strong', r.errors ? 'bad' : '', String(r.errors || 0)));
  stats.append(count, side);

  const used = el('p', 'entry-checked', `最后使用 ${when(r.lastUsedAt)}`);
  const source = el('p', 'entry-source');
  source.append(el('span', 'muted', '原 API'), el('span', '', account ? `${account.name}${account.host && account.host !== account.name ? ` · ${account.host}` : ''}` : `${r.host || '未知'}（原 API 已删除）`));

  const actions = el('div', 'entry-actions');
  const copies = el('div', 'copy-actions');
  copies.append(
    button('复制密钥', 'i-key', () => copyValue(async () => (await api(`/api/chat/relays/${r.id}/key`, { method: 'POST', body: {} })).value, '中转密钥')),
    button('复制地址', 'i-link', () => copyText(openaiBase(), '接口地址')),
    button('复制模型', 'i-boxes', () => copyModels(r)),
  );
  const manage = el('div', 'manage-actions');
  manage.append(
    button(r.enabled ? '停用' : '启用', r.enabled ? 'i-pause' : 'i-play', async () => {
      await api(`/api/chat/relays/${r.id}/update`, { method: 'POST', body: { enabled: !r.enabled } });
      await load();
    }),
    button('重置密钥', 'i-refresh', async () => {
      if (!confirm(`重置“${titleOf(r)}”的密钥？旧密钥会立即失效，同时重新读取原 API 的地址和密钥。`)) return;
      await api(`/api/chat/relays/${r.id}/rotate`, { method: 'POST', body: {} });
      await load();
      notice('已生成新密钥，点“复制密钥”即可复制', 'info');
    }),
    button('重命名', 'i-pencil', async () => {
      const name = prompt('新的名称（显示时会自动加上“中转”）', r.name || '');
      if (name === null || !name.trim()) return;
      await api(`/api/chat/relays/${r.id}/update`, { method: 'POST', body: { name: name.trim() } });
      await load();
    }),
    button('删除', 'i-trash', async () => {
      if (!confirm(`删除“${titleOf(r)}”？使用它的客户端会立即无法访问。`)) return;
      await api(`/api/chat/relays/${r.id}/delete`, { method: 'POST', body: {} });
      await load();
    }, 'delete-action'),
  );
  actions.append(copies, manage);
  if (!r.canCopy) actions.prepend(el('p', 'entry-warning', '这个中转创建于旧版本，密钥没有保存。点“重置密钥”后即可随时复制。'));

  const footer = el('div', 'entry-footer');
  const toggle = el('button', 'details-toggle');
  toggle.type = 'button';
  const expanded = state.open.has(r.id);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.append(el('span', '', expanded ? '收起' : '中转详情'), icon('i-chevron'));
  footer.append(el('span', 'muted small', `创建于 ${when(r.createdAt)}`), toggle);

  const details = el('dl', 'detail-grid');
  details.hidden = !expanded;
  const row = (label, value, all = false, copy = '') => {
    const d = el('div', all ? 'span-all' : '');
    const dd = el('dd', '', value);
    if (copy) {
      const c = el('button', 'inline-copy');
      c.type = 'button';
      c.setAttribute('aria-label', `复制${label}`);
      c.append(icon('i-copy'));
      c.addEventListener('click', () => copyText(copy, label));
      dd.append(c);
    }
    d.append(el('dt', '', label), dd);
    details.append(d);
  };
  row('OpenAI 兼容地址', openaiBase(), true, openaiBase());
  row('Anthropic 地址（不带 /v1）', state.base, true, state.base);
  row('密钥', `sk-prism-…${r.keyTail}`);
  row('原 API 地址', r.host || '—');
  row('密钥更新', r.rotatedAt ? when(r.rotatedAt) : '未重置');
  row('中转 ID', r.id);
  toggle.addEventListener('click', () => {
    const open = details.hidden;
    details.hidden = !open;
    if (open) state.open.add(r.id); else state.open.delete(r.id);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.firstChild.textContent = open ? '收起' : '中转详情';
  });

  card.append(header, stats, used, source, actions, footer, details);
  return card;
}

function renderList() {
  ui.list.replaceChildren();
  if (!state.relays.length) {
    const empty = el('div', 'card empty-card');
    empty.append(icon('i-relay'), el('h2', '', '还没有中转'), el('p', 'muted', '点右上角“新建中转”，选一个已保存的 API 即可。'));
    ui.list.append(empty);
    return;
  }
  for (const r of state.relays) ui.list.append(relayCard(r));
}

function renderAccounts() {
  const own = state.accounts.filter((a) => !a.grant && !a.codex);
  ui.account.replaceChildren();
  ui.create.disabled = !own.length;
  if (!own.length) { ui.account.append(new Option('还没有保存 API', '')); return; }
  ui.account.append(new Option('选择一个 API…', ''));
  for (const a of own) {
    const o = new Option(`${a.name}${a.host && a.host !== a.name ? `（${a.host}）` : ''}`, a.id);
    if (!a.usable) { o.disabled = true; o.text += a.hasApiKey ? ' · 地址不可用' : ' · 没有密钥'; }
    ui.account.append(o);
  }
}

function renderBase() {
  for (const n of document.querySelectorAll('.base-v1')) n.textContent = openaiBase();
  for (const n of document.querySelectorAll('.base-plain')) n.textContent = state.base;
}

async function load() {
  try {
    const [relays, accounts] = await Promise.all([api('/api/chat/relays'), api('/api/chat/accounts')]);
    state.base = relays.base;
    state.relays = relays.relays;
    state.accounts = accounts.accounts;
    renderBase();
    renderAccounts();
    renderList();
  } catch (error) { notice(error.message || '加载失败'); }
}

function setCreateOpen(open) {
  ui.createCard.hidden = !open;
  ui.toggleCreate.setAttribute('aria-expanded', String(open));
  if (open) ui.account.focus();
}

function bind() {
  createSidebar({ shell: ui.shell, openButton: $('open-sidebar'), closeButton: $('close-sidebar'), backdrop: $('backdrop') });
  ui.toggleCreate.addEventListener('click', () => setCreateOpen(ui.createCard.hidden));
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ui.account.value) { notice('请先选择一个 API'); return; }
    busy(ui.create, async () => {
      try {
        const data = await api('/api/chat/relays', { method: 'POST', body: { accountId: ui.account.value, name: ui.name.value.trim() || undefined } });
        ui.name.value = '';
        state.fresh = data.relay.id;
        setCreateOpen(false);
        await load();
        notice(`已创建“${titleOf(data.relay)}”，在卡片上复制地址和密钥即可使用`, 'info');
      } catch (error) { notice(error.message || '创建失败'); }
    });
  });
  ui.modelsSearch.addEventListener('input', renderModels);
  ui.modelsAll.addEventListener('click', () => {
    const q = ui.modelsSearch.value.trim().toLowerCase();
    copyText(state.models.filter((m) => m.toLowerCase().includes(q)).join('\n'), '全部模型名称');
  });
  ui.modelsClose.addEventListener('click', () => ui.dialog.close());
  bindCopyDialog();
  ui.dialog.addEventListener('click', (e) => { if (e.target === ui.dialog) ui.dialog.close(); });
}

async function init() {
  bind();
  ui.shell.classList.add('ready');
  try { showUser(await loadSession()); } catch (error) { notice(error.message || '加载失败'); return; }
  await load();
  onShown(load);
}

init();
