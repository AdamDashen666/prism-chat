// Talks to the existing Vault.Web app on loopback, always with the *caller's*
// session cookie. Ownership checks therefore stay inside Vault: this service
// never reads the database or holds decryption keys.
import http from 'node:http';

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// bridgeSecret: shared key for Vault's loopback-only /api/internal/chat/* endpoints
// (admin-granted APIs). Empty = grants are simply not offered.
export function createVaultClient({ host = '127.0.0.1', port = 5080, publicHost = 'qiuzhang.xyz', timeoutMs = 8000, bridgeSecret = '' } = {}) {
  function call(method, path, cookie, extraHeaders = {}, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const headers = {
        host: publicHost,
        'x-forwarded-proto': 'https',
        accept: 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      };
      if (method !== 'GET') headers['content-length'] = String(payload ? payload.length : 0);
      const request = http.request({ host, port, method, path, headers, timeout: timeoutMs }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
          resolve({ status: response.statusCode, data, setCookie: response.headers['set-cookie'] || [] });
        });
        response.on('error', () => reject(new AppError('AUTH_UNAVAILABLE', '网站服务暂不可用', 503)));
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => reject(new AppError('AUTH_UNAVAILABLE', '网站服务暂不可用', 503)));
      request.end(payload || undefined);
    });
  }

  function failFor(result) {
    if (result.status === 401) return new AppError('UNAUTHORIZED', '请先登录 API 网站', 401);
    if (result.status === 403) return new AppError('FORBIDDEN', result.data?.error || '无权访问', 403);
    if (result.status === 404) return new AppError('NOT_FOUND', 'API 记录不存在或无法访问', 404);
    return new AppError('VAULT_ERROR', result.data?.error || '网站服务暂不可用', 502);
  }

  async function me(cookie) {
    const result = await call('GET', '/api/auth/me', cookie);
    if (result.status !== 200 || !result.data?.id) throw failFor(result.status === 200 ? { status: 502 } : result);
    if (result.data.mustChangePassword) throw new AppError('FORBIDDEN', '请先在 API 网站修改初始密码', 403);
    return result.data;
  }

  async function listAccounts(cookie) {
    const items = [];
    for (let page = 1; page <= 50; page++) {
      const result = await call('GET', `/api/accounts?page=${page}`, cookie);
      if (result.status !== 200 || !Array.isArray(result.data?.items)) throw failFor(result);
      items.push(...result.data.items);
      const { total = 0, pageSize = 24 } = result.data;
      if (page * pageSize >= total) break;
    }
    return items;
  }

  async function getAccount(cookie, id) {
    const result = await call('GET', `/api/accounts/${encodeURIComponent(id)}`, cookie);
    if (result.status !== 200 || !result.data?.id) throw failFor(result);
    return result.data;
  }

  // Reads the decrypted key through Vault's own CSRF-protected endpoint.
  async function readKey(cookie, id) {
    const csrf = await call('GET', '/api/auth/csrf', cookie);
    if (csrf.status !== 200 || typeof csrf.data?.token !== 'string') throw failFor(csrf);
    const merged = mergeCookies(cookie, csrf.setCookie);
    const result = await call('POST', `/api/accounts/${encodeURIComponent(id)}/key`, merged, { 'x-csrf-token': csrf.data.token });
    if (result.status !== 200 || typeof result.data?.value !== 'string') throw failFor(result);
    return result.data.value;
  }

  // Grants an admin lent to this user. Older Vault builds answer 404: treat as none.
  async function listGrants(cookie) {
    const result = await call('GET', '/api/chat/grants', cookie);
    if (result.status === 404) return [];
    if (result.status !== 200 || !Array.isArray(result.data?.grants)) throw failFor(result);
    return result.data.grants;
  }

  async function bridge(path, body) {
    if (!bridgeSecret) throw new AppError('GRANT_UNAVAILABLE', '授权功能未启用', 503);
    const result = await call('POST', `/api/internal/chat/${path}`, '', { 'x-chat-bridge': bridgeSecret }, body);
    if (result.status >= 200 && result.status < 300) return result.data;
    const message = result.data?.error;
    if (result.status === 403 && message === 'forbidden') throw new AppError('GRANT_UNAVAILABLE', '授权功能暂不可用', 503);
    throw new AppError(result.status === 404 ? 'NOT_FOUND' : 'GRANT', message || '授权暂不可用', result.status === 404 ? 404 : result.status === 409 ? 409 : 403);
  }

  // kind: 'models' | 'chat' | 'image'. Returns the owner's endpoint + key for one request; Vault enforces quota.
  const acquireGrant = (grantId, userId, kind, model = '') => bridge('acquire', { grantId, userId, kind, model });
  const reportUsage = (record) => bridge('report', record);

  // Liveness only: any answer below 500 (401 without a session) means Vault is up.
  async function ping() {
    try { return (await call('GET', '/api/auth/me', '')).status < 500; } catch { return false; }
  }

  return { me, listAccounts, getAccount, readKey, listGrants, acquireGrant, reportUsage, ping, grantsEnabled: Boolean(bridgeSecret) };
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}

export function mergeCookies(header, setCookies) {
  const jar = parseCookies(header);
  for (const line of setCookies) {
    const pair = line.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}
