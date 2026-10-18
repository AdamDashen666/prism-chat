// Codex 转发: signing in with a ChatGPT (Codex) subscription through OpenAI's own
// OAuth (the public Codex CLI client, PKCE), keeping the tokens fresh on the
// server, and sending authenticated requests to the Codex backend.
//
// Login without a browser on the server: the admin page makes an authorize link;
// the owner signs in on their own PC, the browser then lands on a localhost URL
// that does not load, and the owner pastes that address back. The server holds the
// PKCE verifier, so the code in the pasted address is useless to anyone else.
import crypto from 'node:crypto';
import { AppError } from '../vault.js';
import { safeLookup } from '../net.js';
import { decoded, open, readText } from '../upstream.js';

export const CODEX = {
  issuer: 'https://auth.openai.com',
  backend: 'https://chatgpt.com/backend-api/codex',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // the public client of the Codex CLI
  scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  originator: 'codex_cli_rs',
  clientVersion: '0.163.0', // the Codex CLI release the requests pretend to come from (the backend hides models from clients it thinks are too old)
  // Both addresses are on the Codex client's allow-list at different times; if the authorize
  // page rejects one, the admin page offers the other.
  redirects: { localhost: 'http://localhost:1455/auth/callback', loopback: 'http://127.0.0.1:1455/auth/callback' },
};

const LOGIN_TTL_MS = 10 * 60 * 1000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000; // refresh when the access token has less than this left
const REFRESH_MAX_AGE_MS = 8 * 24 * 3600 * 1000; // ... or when it is older than this and no expiry is known
const MODELS_TTL_MS = 10 * 60 * 1000;
const RECENT_REFRESH_MS = 20 * 1000; // after a 401, a token refreshed this recently is not refreshed again
const MAX_ERRORS = 20;
const NEWEST_VERSION = '99.0.0'; // tried once when the model list comes back empty: "newer than anything"

const ID_KEYS = ['slug', 'id', 'model', 'name'];

/** The model entries of a /models body, however the list is wrapped. */
export function parseModels(data) {
  const list = Array.isArray(data) ? data : [data?.models, data?.data, data?.items, data?.available_models].find(Array.isArray) || [];
  const items = [];
  for (const m of list) {
    const id = typeof m === 'string' ? m : ID_KEYS.map((k) => m?.[k]).find((v) => typeof v === 'string' && v);
    if (!id || items.some((x) => x.id === id)) continue;
    const o = typeof m === 'object' && m ? m : {};
    items.push({
      id, name: o.display_name || o.displayName || id, description: clip(o.description || '', 200),
      visible: !['hide', 'none'].includes(o.visibility),
      efforts: (o.supported_reasoning_levels || []).map((r) => r?.effort || r).filter((x) => typeof x === 'string'),
    });
  }
  return { items, raw: list.length };
}

export const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function generatePkce() {
  const verifier = b64url(crypto.randomBytes(64));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : null;
  } catch { return null; }
}

/** Email, plan and account ids out of the id_token (the access token is the fallback). */
export function claimsOf(idToken, accessToken) {
  const id = decodeJwt(idToken) || {};
  const access = decodeJwt(accessToken) || {};
  const auth = id['https://api.openai.com/auth'] || {};
  const authAccess = access['https://api.openai.com/auth'] || {};
  const profile = id['https://api.openai.com/profile'] || access['https://api.openai.com/profile'] || {};
  return {
    email: id.email || profile.email || '',
    plan: auth.chatgpt_plan_type || authAccess.chatgpt_plan_type || '',
    accountId: auth.chatgpt_account_id || authAccess.chatgpt_account_id || '',
    userId: auth.chatgpt_user_id || auth.user_id || authAccess.chatgpt_user_id || '',
  };
}

class TokenError extends Error {
  constructor(status, code, description) {
    super(description || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || '';
    // The refresh token itself is no good any more (not a hiccup): signing in again is the only cure.
    this.permanent = status === 401 || /^(refresh_token_expired|refresh_token_reused|refresh_token_invalidated|invalid_grant)$/i.test(this.code);
  }
}

const REFRESH_REASONS = {
  refresh_token_expired: '刷新令牌已过期',
  refresh_token_reused: '刷新令牌已被使用过（可能在别处登录或刷新过同一账号）',
  refresh_token_invalidated: '刷新令牌已被撤销（可能在 ChatGPT 里退出了设备/会话）',
};

const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function createCodexAuth({
  store, lookup = safeLookup, agent, log = () => {}, now = Date.now, config = {},
}) {
  const cfg = { ...CODEX, ...config };
  const state = store.state;
  let refreshing = null;
  let failures = 0;
  let retryAt = 0;
  let timer = null;
  let modelsPromise = null;
  let version = cfg.clientVersion; // moves to NEWEST_VERSION if that is what makes the backend list models

  const record = (kind, message) => {
    state.errors.unshift({ at: now(), kind, message: clip(message) });
    state.errors.length = Math.min(state.errors.length, MAX_ERRORS);
    store.saveSoon();
  };

  async function tokenRequest(body, { json = false } = {}) {
    const payload = Buffer.from(json ? JSON.stringify(body) : new URLSearchParams(body).toString());
    // No timeout on the response of a one-time code or rotating token: posting twice would burn it.
    const response = await open(new URL('/oauth/token', cfg.issuer), {
      headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json', 'accept-encoding': 'identity' },
      body: payload, lookup, agent, connectTimeoutMs: 20000, idleMs: 60000,
    });
    const text = await readText(decoded(response));
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const e = data?.error;
      const code = typeof e === 'string' ? e : e?.code || data?.code || '';
      const description = data?.error_description || (typeof e === 'object' ? e?.message : '') || data?.message || '';
      throw new TokenError(response.statusCode, code, clip(description));
    }
    if (!data || typeof data !== 'object') throw new TokenError(502, 'invalid_response', 'OpenAI 返回了无法识别的内容');
    return data;
  }

  const netMessage = (error) => (error?.code === 'ENOTFOUND' ? '服务器无法解析 auth.openai.com' : error?.message === 'CONNECT_TIMEOUT' || error?.message === 'IDLE_TIMEOUT' ? '连接 OpenAI 超时' : '无法连接 OpenAI');

  /** Takes the tokens of a token response (any of them may be missing in a refresh) and saves at once. */
  function applyTokens(data) {
    const t = { ...(state.tokens || {}) };
    for (const k of ['id_token', 'access_token', 'refresh_token']) if (typeof data[k] === 'string' && data[k]) t[k] = data[k];
    const info = claimsOf(t.id_token, t.access_token);
    t.account_id = info.accountId || t.account_id || '';
    state.tokens = t;
    state.info = { ...(state.info || {}), ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) };
    state.lastRefresh = now();
    store.save();
  }

  const accessExpiry = () => {
    const exp = decodeJwt(state.tokens?.access_token)?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  };

  function needsRefresh() {
    if (!state.tokens) return false;
    const exp = accessExpiry();
    if (exp) return exp - now() < REFRESH_WINDOW_MS;
    return !state.lastRefresh || now() - state.lastRefresh > REFRESH_MAX_AGE_MS;
  }

  /** One refresh at a time: the refresh token rotates, so two in flight would burn it. */
  function refresh({ reason = 'manual' } = {}) {
    if (!state.tokens?.refresh_token) return Promise.reject(new AppError('NOT_CONNECTED', '尚未登录 ChatGPT', 409));
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const data = await tokenRequest({ client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: state.tokens.refresh_token }, { json: true });
        applyTokens(data);
        state.needsLogin = '';
        failures = 0;
        retryAt = 0;
        store.save();
        log({ event: 'codex_refreshed', reason });
      } catch (error) {
        if (error instanceof TokenError && error.permanent) {
          const why = REFRESH_REASONS[error.code?.toLowerCase()] || (error.description ? `OpenAI 拒绝了刷新：${error.message}` : 'OpenAI 拒绝了刷新');
          state.needsLogin = why;
          record('refresh', `${why}，需要重新登录`);
          store.save();
          log({ event: 'codex_login_lost', code: error.code });
          throw new AppError('NEEDS_LOGIN', `${why}，请重新登录`, 503);
        }
        failures++;
        retryAt = now() + Math.min(60, 2 ** failures) * 60 * 1000;
        const message = error instanceof TokenError ? `OpenAI 暂时拒绝了刷新（${error.status}）` : netMessage(error);
        record('refresh', message);
        throw new AppError('REFRESH_FAILED', `刷新令牌失败：${message}`, 502);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  /** Headers that authenticate a Codex backend request; refreshes first when the token is about to expire. */
  async function authHeaders() {
    if (!state.tokens) throw new AppError('NOT_CONNECTED', 'Codex 转发尚未登录 ChatGPT', 503);
    if (state.needsLogin) throw new AppError('NEEDS_LOGIN', 'Codex 登录已失效，请管理员在后台重新登录', 503);
    if (needsRefresh()) {
      try { await refresh({ reason: 'proactive' }); }
      catch (error) {
        // A transient failure is fine while the old token still works.
        const exp = accessExpiry();
        if (error?.code === 'NEEDS_LOGIN' || !exp || exp <= now()) throw error;
      }
    }
    const { access_token: access, account_id: account } = state.tokens;
    return { authorization: `Bearer ${access}`, ...(account ? { 'chatgpt-account-id': account } : {}) };
  }

  /** After an upstream 401: one forced refresh, unless the token was just refreshed. */
  async function recoverUnauthorized() {
    if (!state.tokens || state.needsLogin || (state.lastRefresh && now() - state.lastRefresh < RECENT_REFRESH_MS)) return false;
    try { await refresh({ reason: 'unauthorized' }); return true; } catch { return false; }
  }

  // ---------- login ----------
  function startLogin({ redirect = 'localhost' } = {}) {
    const redirectUri = cfg.redirects[redirect] || cfg.redirects.localhost;
    const pkce = generatePkce();
    const stateParam = b64url(crypto.randomBytes(32));
    state.pending = { state: stateParam, verifier: pkce.verifier, redirect: redirectUri, createdAt: now() };
    store.save();
    const url = new URL('/oauth/authorize', cfg.issuer);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scope,
      code_challenge: pkce.challenge, code_challenge_method: 'S256', state: stateParam,
      id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: cfg.originator,
    })) url.searchParams.set(k, v);
    return { url: url.href, redirectUri, expiresAt: state.pending.createdAt + LOGIN_TTL_MS };
  }

  function cancelLogin() {
    state.pending = null;
    store.save();
  }

  /** What the owner pasted: the whole address, just its query string, or only the code. */
  function parseCallback(input) {
    const text = String(input || '').trim();
    if (!text) throw new AppError('INVALID', '请粘贴浏览器地址栏里的完整地址', 400);
    let params;
    try { params = new URL(text).searchParams; }
    catch {
      // A bare code has no spaces; anything else that is not a query string is a paste mistake and must not use up the login.
      if (!/[=&]/.test(text) && !/^[\w.~-]{8,}$/.test(text)) throw new AppError('INVALID', '这不是浏览器地址栏里的回调地址，请复制登录完成后的完整地址', 400);
      params = /[=&]/.test(text) ? new URLSearchParams(text.replace(/^\?/, '')) : new URLSearchParams({ code: text });
    }
    return { code: params.get('code') || '', state: params.get('state') || '', error: params.get('error') || '', description: params.get('error_description') || '' };
  }

  async function completeLogin(input) {
    const p = state.pending;
    if (!p) throw new AppError('NO_LOGIN', '没有进行中的登录，请先点“生成授权链接”', 409);
    if (now() - p.createdAt > LOGIN_TTL_MS) { state.pending = null; store.save(); throw new AppError('LOGIN_EXPIRED', '授权链接已超过 10 分钟，请重新生成', 409); }
    const cb = parseCallback(input);
    if (cb.error) {
      state.pending = null;
      store.save();
      const missing = /missing_codex_entitlement/i.test(cb.description);
      throw new AppError('LOGIN_DENIED', missing ? '这个 ChatGPT 账号/工作区没有开通 Codex' : `授权被拒绝：${clip(cb.description || cb.error)}`, 400);
    }
    if (!cb.code) throw new AppError('INVALID', '地址里没有 code 参数，请确认复制的是登录完成后的完整地址', 400);
    if (cb.state && cb.state !== p.state) throw new AppError('STATE_MISMATCH', '地址里的 state 与当前登录不匹配，请重新生成授权链接', 400);
    let data;
    try {
      data = await tokenRequest({ grant_type: 'authorization_code', client_id: cfg.clientId, code: cb.code, redirect_uri: p.redirect, code_verifier: p.verifier });
    } catch (error) {
      if (error instanceof TokenError) {
        state.pending = null; // a used or wrong code cannot be retried
        store.save();
        record('login', `换取令牌失败：${error.message}`);
        throw new AppError('LOGIN_FAILED', `OpenAI 拒绝了这次登录：${error.message}。请重新生成授权链接再试`, 400);
      }
      throw new AppError('LOGIN_FAILED', `${netMessage(error)}，请稍后重试（授权码还可以再用一次）`, 502);
    }
    if (!data.access_token || !data.refresh_token) throw new AppError('LOGIN_FAILED', 'OpenAI 没有返回完整的令牌', 502);
    state.tokens = null;
    applyTokens(data);
    if (!state.tokens.account_id) { state.tokens = null; state.info = null; store.save(); throw new AppError('LOGIN_FAILED', '登录成功但令牌里没有 ChatGPT 账号信息', 502); }
    Object.assign(state, { pending: null, needsLogin: '', models: null });
    failures = 0;
    store.save();
    log({ event: 'codex_login' });
    return status();
  }

  /** `~/.codex/auth.json` from a PC where `codex login` was run. It is rotated at once so this server owns the session. */
  async function importAuthJson(text) {
    let json;
    try { json = JSON.parse(String(text || '')); } catch { throw new AppError('INVALID', '内容不是有效的 JSON', 400); }
    const t = json?.tokens && typeof json.tokens === 'object' ? json.tokens : json;
    if (!t || typeof t.refresh_token !== 'string' || !t.refresh_token) throw new AppError('INVALID', '没有找到 refresh_token。请粘贴 ~/.codex/auth.json 的完整内容（需要 ChatGPT 登录方式，不是 API Key 方式）', 400);
    const before = { ...state };
    state.tokens = { id_token: t.id_token || '', access_token: t.access_token || '', refresh_token: t.refresh_token, account_id: t.account_id || '' };
    state.info = null;
    state.needsLogin = '';
    try {
      await refresh({ reason: 'import' });
    } catch (error) {
      Object.assign(state, { tokens: before.tokens, info: before.info, needsLogin: before.needsLogin, lastRefresh: before.lastRefresh });
      store.save();
      throw error instanceof AppError ? new AppError(error.code, `导入的登录无法使用：${error.message}`, 400) : error;
    }
    if (!state.tokens.account_id) { state.tokens = before.tokens; state.info = before.info; store.save(); throw new AppError('INVALID', '令牌里没有 ChatGPT 账号信息', 400); }
    Object.assign(state, { pending: null, models: null });
    store.save();
    log({ event: 'codex_import' });
    return status();
  }

  /** Forgets the login. The refresh token is also revoked at OpenAI (best effort), so it cannot be used from anywhere else. */
  async function disconnect({ revoke = true } = {}) {
    const token = state.tokens?.refresh_token;
    let revoked = false;
    if (revoke && token) {
      try {
        const response = await open(new URL('/oauth/revoke', cfg.issuer), {
          headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' },
          body: Buffer.from(JSON.stringify({ token, token_type_hint: 'refresh_token', client_id: cfg.clientId })),
          lookup, agent, connectTimeoutMs: 10000, idleMs: 10000,
        });
        await readText(decoded(response));
        revoked = response.statusCode >= 200 && response.statusCode < 300;
      } catch { /* the local copy is removed either way */ }
    }
    store.clearLogin();
    failures = 0;
    retryAt = 0;
    log({ event: 'codex_disconnect', revoked });
    return { revoked };
  }

  // ---------- backend requests ----------
  const baseHeaders = () => ({
    'openai-beta': 'responses=experimental', originator: cfg.originator, version,
    'user-agent': `${cfg.originator}/${version}`, 'accept-encoding': 'identity',
  });

  const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  /** Remembers the plan's usage windows the backend reports in response headers. */
  function noteLimits(headers) {
    const h = (k) => (Array.isArray(headers[k]) ? headers[k][0] : headers[k]);
    const window = (p) => (h(`x-codex-${p}-used-percent`) === undefined ? null : {
      usedPercent: num(h(`x-codex-${p}-used-percent`)), windowMinutes: num(h(`x-codex-${p}-window-minutes`)), resetAt: num(h(`x-codex-${p}-reset-at`)),
    });
    const primary = window('primary');
    const secondary = window('secondary');
    if (!primary && !secondary) return;
    state.limits = {
      at: now(), primary, secondary,
      credits: h('x-codex-credits-has-credits') === undefined ? null : { has: h('x-codex-credits-has-credits') === 'true', unlimited: h('x-codex-credits-unlimited') === 'true', balance: h('x-codex-credits-balance') || '' },
      reached: h('x-codex-rate-limit-reached-type') || '',
    };
    store.saveSoon();
  }

  /**
   * A request to the Codex backend with the ChatGPT login. Resolves the response
   * (any status); one 401 is answered by a forced refresh and a second try.
   * `body` may be a function so a retry can rebuild it.
   */
  async function backend(path, { method = 'POST', body, headers = {}, signal, query = '', idleMs = 180000 } = {}) {
    const url = new URL(`${cfg.backend.replace(/\/+$/, '')}${path}${query}`);
    for (let attempt = 0; ; attempt++) {
      const auth = await authHeaders();
      const payload = typeof body === 'function' ? body() : body;
      const response = await open(url, {
        method, headers: { ...baseHeaders(), ...(payload ? { 'content-type': 'application/json' } : {}), ...headers, ...auth },
        body: payload, signal, lookup, agent, connectTimeoutMs: 60000, idleMs,
      });
      noteLimits(response.headers);
      if (response.statusCode === 401 && attempt === 0) {
        response.resume();
        if (await recoverUnauthorized()) continue;
        throw new AppError('NEEDS_LOGIN', 'ChatGPT 拒绝了当前登录，请管理员在后台重新登录', 503);
      }
      return response;
    }
  }

  async function fetchModels({ force = false } = {}) {
    if (!force && state.models && now() - state.models.fetchedAt < MODELS_TTL_MS) return state.models;
    if (modelsPromise) return modelsPromise;
    modelsPromise = (async () => {
      try {
        // The backend only lists the models its client version supports (an old version may get none, or only
        // hidden ones such as codex-auto-review), so an answer without visible models is retried once as "the
        // newest client", and the answer with the most visible models wins.
        const tried = [];
        let best = null; // { v, result, debug }
        const visibleCount = (r) => r.items.filter((m) => m.visible).length;
        for (const v of [...new Set([version, NEWEST_VERSION])]) {
          const response = await backend('/models', { method: 'GET', query: `?client_version=${encodeURIComponent(v)}`, headers: { accept: 'application/json', version: v }, idleMs: 30000 });
          const text = await readText(decoded(response), 4 * 1024 * 1024);
          if (response.statusCode < 200 || response.statusCode >= 300) throw new AppError('UPSTREAM', `获取模型列表失败（HTTP ${response.statusCode}）：${clip(text, 160)}`, 502);
          let data;
          try { data = JSON.parse(text); } catch { throw new AppError('UPSTREAM', `模型列表不是 JSON（${clip(text, 80)}）`, 502); }
          const result = parseModels(data);
          const first = Array.isArray(data) ? data[0] : (data?.models || data?.data || data?.items || [])[0];
          tried.push(v);
          const debug = {
            status: response.statusCode, versions: [...tried], entries: result.raw, parsed: result.items.length, visible: visibleCount(result),
            fields: Array.isArray(data) ? ['(数组)'] : Object.keys(data || {}).slice(0, 12),
            entryFields: first && typeof first === 'object' ? Object.keys(first).slice(0, 14) : [],
          };
          if (!best || visibleCount(result) > visibleCount(best.result)) best = { v, result, debug: { ...debug, versions: [...tried] } };
          if (visibleCount(result)) break;
        }
        const { v: usedVersion, result } = best;
        const debug = { ...best.debug, versions: tried };
        if (visibleCount(result)) version = usedVersion;
        state.models = { fetchedAt: now(), items: result.items, debug };
        if (!visibleCount(result)) {
          record('models', result.items.length
            ? `ChatGPT 只返回了未列出的模型（${result.items.map((m) => m.id).join('、')}），已试版本 ${tried.join('、')}`
            : `ChatGPT 返回的模型列表是空的（已试版本 ${tried.join('、')}，返回字段：${debug.fields.join(',') || '无'}）`);
        }
        store.saveSoon();
        return state.models;
      } catch (error) {
        if (!(error instanceof AppError) || !['NOT_CONNECTED', 'NEEDS_LOGIN'].includes(error.code)) record('models', error instanceof AppError ? error.message : netMessage(error));
        throw error instanceof AppError ? error : new AppError('UPSTREAM', `获取模型列表失败：${netMessage(error)}`, 502);
      } finally { modelsPromise = null; }
    })();
    return modelsPromise;
  }

  /** The backend list plus the ids the admin added by hand. */
  function mergedModels() {
    const items = [...(state.models?.items || [])];
    for (const id of state.customModels || []) if (!items.some((m) => m.id === id)) items.push({ id, name: id, description: '手动添加', visible: true, efforts: [], custom: true });
    return { fetchedAt: state.models?.fetchedAt || now(), items };
  }

  /** What the OpenAI-style /models answers: the live list, else the last one, plus the hand-added ids. */
  async function modelList({ force = false } = {}) {
    try { await fetchModels({ force }); }
    catch (error) { if (!state.models && !state.customModels?.length) throw error; }
    return mergedModels();
  }

  function setCustomModels(ids) {
    const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean))];
    if (clean.length > 50 || clean.some((x) => !/^[A-Za-z0-9._:/-]{1,100}$/.test(x))) throw new AppError('INVALID', '模型 ID 只能包含字母、数字和 . _ : / -，最多 50 个', 400);
    state.customModels = clean;
    store.save();
    return clean;
  }

  // ---------- view ----------
  function status() {
    const p = state.pending && now() - state.pending.createdAt <= LOGIN_TTL_MS ? state.pending : null;
    const exp = accessExpiry();
    return {
      state: store.loadError ? 'broken' : !state.tokens ? 'disconnected' : state.needsLogin ? 'needs_login' : 'connected',
      loadError: store.loadError,
      needsLogin: state.needsLogin,
      account: state.info ? { email: state.info.email || '', plan: state.info.plan || '', accountId: state.info.accountId ? `${state.info.accountId.slice(0, 8)}…` : '' } : null,
      accessExpiresAt: exp, lastRefreshAt: state.lastRefresh,
      refreshing: Boolean(refreshing), retryAt: retryAt || null,
      pending: p ? { expiresAt: p.createdAt + LOGIN_TTL_MS, redirect: p.redirect } : null,
      models: state.models || state.customModels?.length ? { ...mergedModels(), debug: state.models?.debug || null } : null,
      customModels: state.customModels || [],
      clientVersion: version,
      limits: state.limits,
      errors: state.errors,
    };
  }

  function start() {
    // Keeps the session alive without anyone using it: a refresh token that is never used eventually lapses.
    timer = setInterval(() => {
      if (state.tokens && !state.needsLogin && !refreshing && now() >= retryAt && (needsRefresh() || now() - (state.lastRefresh || 0) > 3 * 24 * 3600 * 1000)) {
        refresh({ reason: 'scheduled' }).catch(() => {});
      }
    }, 10 * 60 * 1000);
    timer.unref();
    const boot = setTimeout(() => { if (state.tokens && !state.needsLogin && needsRefresh()) refresh({ reason: 'boot' }).catch(() => {}); }, 20000);
    boot.unref();
  }

  return {
    status, startLogin, completeLogin, cancelLogin, importAuthJson, refresh, disconnect, authHeaders, backend, fetchModels, modelList, cachedModelList: mergedModels, setCustomModels, recoverUnauthorized,
    record, cachedModels: () => state.models, start, close() { clearInterval(timer); store.close(); },
    get connected() { return Boolean(state.tokens) && !state.needsLogin; },
    config: cfg,
  };
}
