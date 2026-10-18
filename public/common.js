// Shared by the 模型对话, 模型检测 and 用量统计 pages: the session and API calls,
// notices, the user badge, the mobile sidebar and the API / model pickers.

export const $ = (id) => document.getElementById(id);
export const CUSTOM = '__custom__';
export const session = { data: null };
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------- network ----------
/**
 * fetch() for this site's /api/chat/* endpoints; resolves with the Response.
 * Writes carry the CSRF token. If the server no longer accepts it (its key
 * changed), the session is read again and the write retried once. 401 goes to
 * the login page (the whole window when shown inside the main site).
 */
export async function request(path, { method = 'GET', body, signal } = {}, retried = false) {
  const write = method !== 'GET';
  const headers = { Accept: 'application/json' };
  if (write) { headers['Content-Type'] = 'application/json'; headers['X-Chat-CSRF'] = session.data?.csrf || ''; }
  const response = await fetch(path, { method, headers, body: write ? JSON.stringify(body ?? {}) : undefined, credentials: 'same-origin', cache: 'no-store', signal });
  if (response.status === 401) { window.top.location.href = '/'; throw new Error('请先登录 API 网站'); }
  if (write && response.status === 403 && !retried) {
    const data = await response.clone().json().catch(() => null);
    if (data?.code === 'CSRF') {
      await loadSession();
      return request(path, { method, body, signal }, true);
    }
  }
  return response;
}

/** request() + JSON; throws an Error carrying the server's message. */
export async function api(path, options) {
  const response = await request(path, options);
  let data;
  try { data = await response.json(); } catch { data = undefined; }
  if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`);
  return data;
}

export async function loadSession() {
  session.data = await api('/api/chat/session');
  return session.data;
}

/** Network failures in plain words; server messages pass through. */
export function friendlyError(error) {
  const m = String(error?.message || '');
  if (!m || /network ?error|failed to fetch|load failed|networkerror/i.test(m)) return '网络连接中断，请检查网络后重试';
  return m;
}

// ---------- page chrome ----------
export function createNotice(node) {
  let timer;
  const clear = () => node.classList.remove('show');
  // action: { label, run, ms } adds a button (e.g. 撤销) and keeps the notice up for ms.
  const show = (message, tone = 'error', action = null) => {
    clearTimeout(timer);
    node.textContent = message;
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notice-action';
      button.textContent = action.label;
      button.addEventListener('click', () => { clear(); action.run(); }, { once: true });
      node.append(button);
    }
    node.dataset.tone = tone;
    node.classList.add('show');
    timer = setTimeout(clear, action?.ms || (tone === 'error' ? 8000 : 3500));
  };
  return { show, clear };
}

export function showUser(data) {
  $('user-name').textContent = data.userName;
  $('user-avatar').textContent = (data.userName || '?').slice(0, 1).toUpperCase();
  // Entries only admins may use (Codex 转发) stay hidden for everyone else; the server enforces it too.
  for (const node of document.querySelectorAll('[data-admin-only]')) node.hidden = !data.isAdmin;
}

/** The off-canvas sidebar on narrow screens: menu button, close button, backdrop and Escape. */
export function createSidebar({ shell, openButton, closeButton, backdrop, focusOnOpen = closeButton }) {
  const isOpen = () => shell.classList.contains('sidebar-open');
  const open = () => {
    shell.classList.add('sidebar-open');
    openButton.setAttribute('aria-expanded', 'true');
    setTimeout(() => focusOnOpen?.focus(), 50);
  };
  const close = ({ restoreFocus = false } = {}) => {
    if (!isOpen()) return;
    shell.classList.remove('sidebar-open');
    openButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) openButton.focus();
  };
  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', () => close({ restoreFocus: true }));
  backdrop.addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close({ restoreFocus: true }); });
  return { open, close, isOpen };
}

/**
 * Calls fn when the page comes back into view: the browser tab is shown again, or the main
 * site's workspace shows this page's frame again (it keeps tool frames alive while another
 * view is open, so lists loaded at start go stale). A hidden frame keeps its size, so this
 * watches whether the page intersects the top window's viewport instead of resize events.
 */
export function onShown(fn) {
  let hidden = false;
  let last = 0;
  const run = () => {
    if (Date.now() - last < 2000) return;
    last = Date.now();
    fn();
  };
  new IntersectionObserver((entries) => {
    const visible = entries[entries.length - 1].isIntersecting;
    if (visible && hidden) run();
    hidden = !visible;
  }).observe(document.documentElement);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
}

/** Disables a button and spins its icon while fn runs. */
export async function busy(button, fn) {
  button.disabled = true;
  button.classList.add('spinning');
  try { return await fn(); } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

// ---------- API & model pickers ----------
// short: name only (phones, where the picker is too narrow for "name · host").
export function accountLabel(a, { short = false } = {}) {
  const base = a.grant
    ? `${a.name}${a.grant.blocked ? `（${a.grant.blocked}）` : a.grant.quota ? ` · ${a.grant.quota}` : ''}`
    : short || a.name === a.host || !a.host ? a.name : `${a.name} · ${a.host}`;
  return `${base}${a.enabled ? '' : '（已暂停）'}`;
}

/**
 * Fills an API <select> with the user's own APIs and admin grants (grouped when
 * both exist; a used-up grant stays listed, disabled, with the reason).
 * Selects the first usable one and returns the usable list.
 */
export function fillAccounts(select, accounts, { emptyLabel, short = false }) {
  select.replaceChildren();
  const usable = accounts.filter((a) => a.usable);
  if (!usable.length) {
    select.append(new Option(emptyLabel, ''));
    select.disabled = true;
    return usable;
  }
  const own = usable.filter((a) => !a.grant && !a.codex);
  const lent = accounts.filter((a) => a.grant);
  const codex = usable.filter((a) => a.codex);
  const option = (a) => {
    const o = new Option(accountLabel(a, { short }), a.id);
    o.disabled = !a.usable;
    return o;
  };
  const groups = [['我的 API', own], ['Codex 转发', codex], ['管理员授权', lent]].filter(([, list]) => list.length);
  if (groups.length > 1) {
    for (const [title, list] of groups) {
      const g = document.createElement('optgroup');
      g.label = title;
      for (const a of list) g.append(option(a));
      select.append(g);
    }
  } else for (const a of groups[0][1]) select.append(option(a));
  select.value = (own[0] || codex[0] || usable[0]).id;
  select.disabled = false;
  return usable;
}

/** Saved model list of an API merged with what was fetched live, sorted. */
export function modelsOf(account, live) {
  return [...new Set([...(live.get(account?.id) || []), ...(account?.models || [])])].sort((x, y) => x.localeCompare(y));
}

/**
 * Fills a model <select>. `groups(models)` may split the list into labelled
 * optgroups; `custom` adds the "type a model ID" entry (off for restricted grants).
 * `preferred` is selected when listed, otherwise typed into `customInput`.
 */
export function fillModels(select, models, { custom = true, preferred = '', customInput = null, groups = null } = {}) {
  select.replaceChildren();
  const parts = groups ? groups(models).filter(([, list]) => list.length) : [];
  if (parts.length > 1) {
    for (const [label, list] of parts) {
      const g = document.createElement('optgroup');
      g.label = label;
      for (const m of list) g.append(new Option(m, m));
      select.append(g);
    }
  } else for (const m of models) select.append(new Option(m, m));
  if (custom) select.append(new Option(models.length ? '自定义模型…' : '手动输入模型 ID…', CUSTOM));
  if (preferred && models.includes(preferred)) select.value = preferred;
  else if (preferred && custom && customInput) { select.value = CUSTOM; customInput.value = preferred; }
  else select.value = models[0] ?? CUSTOM;
  if (customInput) customInput.hidden = select.value !== CUSTOM;
}

/** Live model list of a saved API or grant: { models, kinds, allowCustom }. */
export const fetchModels = (accountId) => api('/api/chat/models', { method: 'POST', body: { accountId } });
