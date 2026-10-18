// API sources: the user's own saved APIs (read through Vault with their session)
// and APIs an admin lent them (grants, through Vault's loopback bridge). The
// endpoint and key never leave the server; the browser only sees these views.
import { AppError } from './vault.js';
import { authHeader } from './upstream.js';
import { checkId } from './validate.js';

// Admin-lent APIs appear as accounts with id `g_<grantId>`. Vault checks
// ownership, model and quota on every request.
const GRANT_PREFIX = 'g_';
export const isGrant = (id) => id.startsWith(GRANT_PREFIX);
// Codex 转发 (the ChatGPT subscription behind /chat/codex) is offered to admins as one more account.
export const CODEX_ID = 'codex';
export const isCodex = (id) => id === CODEX_ID;

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

export const accountName = (a) => (a.displayName || '').trim() || hostOf(a.baseUrl) || 'API';

export function accountView(a) {
  return {
    id: a.id,
    name: accountName(a),
    host: hostOf(a.baseUrl),
    models: Array.isArray(a.models) ? a.models.filter((m) => typeof m === 'string') : [],
    enabled: a.isEnabled !== false,
    hasApiKey: Boolean(a.hasApiKey),
    usable: Boolean(a.hasApiKey) && a.queryBlockReason !== 'unsafeAddress',
  };
}

function quotaText(g) {
  const u = g.usage || {};
  const parts = [];
  if (g.dailyRequests != null) parts.push(`今日 ${u.dayRequests ?? 0}/${g.dailyRequests} 次`);
  if (g.monthlyRequests != null) parts.push(`本月 ${u.monthRequests ?? 0}/${g.monthlyRequests} 次`);
  if (g.monthlyTokens != null) parts.push(`Tokens ${u.monthTokens ?? 0}/${g.monthlyTokens}`);
  if (g.monthlyImages != null) parts.push(`图片 ${u.monthImages ?? 0}/${g.monthlyImages}`);
  return parts.join(' · ');
}

export function grantView(g) {
  return {
    id: `${GRANT_PREFIX}${g.id}`,
    name: String(g.label || '管理员授权'),
    host: '管理员授权',
    models: Array.isArray(g.allowedModels) ? g.allowedModels.filter((m) => typeof m === 'string') : [],
    enabled: true,
    hasApiKey: true,
    usable: !g.blockedReason,
    grant: { quota: quotaText(g), blocked: g.blockedReason || '', restricted: Array.isArray(g.allowedModels) && g.allowedModels.length > 0 },
  };
}

export function createAccounts(vault, { codex } = {}) {
  function codexView() {
    const items = codex.cachedModelList().items;
    const shown = items.filter((m) => m.visible !== false);
    return {
      id: CODEX_ID, name: 'Codex 转发', host: 'ChatGPT Codex 订阅', models: (shown.length ? shown : items).map((m) => m.id),
      enabled: true, hasApiKey: true, usable: codex.connected, codex: true,
    };
  }

  // A Vault/grant hiccup must never hide the user's own APIs.
  async function list(cookie, me) {
    const [accounts, grants] = await Promise.all([
      vault.listAccounts(cookie),
      vault.grantsEnabled ? vault.listGrants(cookie).catch(() => []) : [],
    ]);
    return [...accounts.map(accountView), ...grants.map(grantView), ...(codex && me?.isAdmin ? [codexView()] : [])];
  }

  // Returns { account, header, key, label, bill }. `bill(record)` reports usage
  // for grants and is a no-op otherwise.
  async function credentials(cookie, accountId, me, kind = 'chat', model = '') {
    const id = checkId(accountId);
    if (isCodex(id)) {
      // No endpoint or key here: requests go through the Codex auth object (tokens stay in the sidecar).
      if (!codex || !me?.isAdmin) throw new AppError('FORBIDDEN', '只有管理员可以使用 Codex 转发', 403);
      if (kind === 'image') throw new AppError('UNSUPPORTED', 'Codex 转发不支持图片生成', 400);
      if (!codex.connected) throw new AppError('NOT_CONNECTED', 'Codex 转发还没有登录 ChatGPT（或登录已失效），请先在“Codex 转发”页面登录', 409);
      return { account: { id, baseUrl: '', models: [] }, header: null, key: '', label: 'Codex 转发', bill: () => {}, codex };
    }
    if (isGrant(id)) {
      const grantId = id.slice(GRANT_PREFIX.length);
      const acquired = await vault.acquireGrant(grantId, me.id, kind, model);
      if (!acquired?.baseUrl || !acquired?.apiKey) throw new AppError('NO_KEY', '授权的 API 不可用', 409);
      const account = {
        id, baseUrl: acquired.baseUrl, models: acquired.models || [], allowedModels: acquired.allowedModels || [],
        protocolProfileId: acquired.protocolProfileId, customProtocolProfile: acquired.customProtocolProfile,
      };
      const bill = (record) => vault.reportUsage({ grantId, userId: me.id, model, kind, ...record })
        .catch((error) => console.warn(JSON.stringify({ event: 'usage_report_failed', code: error?.code })));
      return { account, header: authHeader(account, acquired.apiKey), key: acquired.apiKey, label: String(acquired.label || '管理员授权'), bill };
    }
    const account = await vault.getAccount(cookie, id);
    if (!account.hasApiKey) throw new AppError('NO_KEY', '该 API 没有保存密钥', 409);
    const key = await vault.readKey(cookie, account.id);
    if (!key) throw new AppError('NO_KEY', '该 API 没有保存密钥', 409);
    return { account, header: authHeader(account, key), key, label: accountName(account), bill: () => {} };
  }

  return { list, credentials };
}
