// API 中转: lets a user call one of their saved APIs through this server with a
// relay key of its own (sk-prism-...). Useful when the upstream is unreachable
// from the user's network but reachable from here.
//
// The upstream endpoint and key are stored sealed with a key derived from the
// relay key itself (AES-256-GCM, HKDF); lookups use the relay key's sha256. The
// relay key is kept too, encrypted with a server key (relay.key next to the
// state file), so the owner can copy it again like a saved API key. If the
// original key changes in Vault, "重置密钥" re-reads it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { AppError } from './vault.js';
import { safeLookup, validateBaseUrl } from './net.js';
import { writeAtomic } from './util.js';

export const RELAY_PREFIX = '/chat/relay';
const TOKEN_PREFIX = 'sk-prism-';
const TOKEN = /^sk-prism-[A-Za-z0-9_-]{32}$/;
const MAX_PER_USER = 20;
const MAX_BODY = 64 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 10 * 60 * 1000; // non-streaming reasoning answers can take minutes
const IDLE_MS = 10 * 60 * 1000;
const PER_RELAY = 8; // concurrent requests per relay
const TOTAL = 40; // concurrent relay requests on the whole server
const PER_MINUTE = 300; // requests per relay and minute
const BAD_PER_MINUTE = 30; // failed key checks per client address and minute

// Request headers a client may pass on; everything else (cookies, auth, proxy headers) is dropped.
const FORWARD = new Set(['content-type', 'accept', 'accept-encoding', 'accept-language', 'user-agent', 'anthropic-version', 'anthropic-beta',
  'openai-beta', 'x-goog-api-client', 'idempotency-key', 'x-stainless-retry-count', 'x-stainless-timeout', 'cache-control']);
// Response headers passed back.
const PASS_BACK = /^(content-type|content-encoding|content-length|retry-after|request-id|x-request-id|openai-processing-ms|openai-version|anthropic-ratelimit-.*|x-ratelimit-.*|x-goog-.*)$/i;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const userKey = (userId) => sha256(String(userId)).slice(0, 32);
const sealKey = (token, id) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), Buffer.from(id), Buffer.from('prism-relay-v1'), 32));

function seal(token, id, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(token, id), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unseal(token, id, sealed) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(token, id), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
}

const newToken = () => TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');

function boxToken(key, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unboxToken(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Upstream URL for a relay request: `rest` (the path after /chat/relay, with
 * query) is appended to the saved base URL. A base saved as a whole endpoint
 * (…/v1/messages, …/chat/completions) is cut back to its root, and a version
 * segment the client repeats (/v1 + /v1/models) is not doubled.
 */
export function relayTarget(baseUrl, rest) {
  let base;
  try { base = validateBaseUrl(String(baseUrl || '').trim().replace(/\/+$/, '')); }
  catch (error) { throw new AppError('UNSAFE_ADDRESS', error.message, 400); }
  const restUrl = new URL(rest || '/', 'http://relay.invalid');
  let basePath = base.pathname.replace(/\/+$/, '').replace(/\/(messages|chat\/completions|responses)$/i, '');
  let restPath = restUrl.pathname.replace(/\/{2,}/g, '/');
  if (restPath.split('/').some((s) => s === '..' || s === '.')) throw new AppError('INVALID_PATH', '路径无效', 400);
  const version = /\/(v\d+(?:alpha|beta)?\d*)$/i.exec(basePath)?.[1];
  if (version && (restPath === `/${version}` || restPath.startsWith(`/${version}/`))) restPath = restPath.slice(version.length + 1);
  const url = new URL(base.origin);
  url.pathname = (basePath + (restPath === '/' ? '' : restPath)) || '/';
  url.search = restUrl.search;
  return url;
}

// `key`: 32-byte server key that encrypts the stored relay keys (a random one
// when not given, which is fine in memory-only use).
export function createRelayStore({ dir = null, key = crypto.randomBytes(32), log = () => {} } = {}) {
  const file = dir ? path.join(dir, 'relays.json') : null;
  const relays = new Map(); // id -> record
  const byHash = new Map(); // sha256(token) -> id
  let saveTimer = null;

  if (file) {
    try {
      for (const r of JSON.parse(fs.readFileSync(file, 'utf8')).relays || []) {
        relays.set(r.id, r);
        byHash.set(r.keyHash, r.id);
      }
    } catch (error) { if (error.code !== 'ENOENT') log({ event: 'relays_unreadable', code: error?.code }); }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!file) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(file, JSON.stringify({ relays: [...relays.values()] }));
  }
  // Counters change on every request; write them at most every 30 s.
  const saveSoon = () => { if (file && !saveTimer) { saveTimer = setTimeout(saveNow, 30000); saveTimer.unref(); } };

  const view = (r) => ({
    id: r.id, name: r.name, accountId: r.accountId, host: r.host, enabled: !r.disabled, keyTail: r.keyTail, canCopy: Boolean(r.tokenBox),
    createdAt: r.createdAt, rotatedAt: r.rotatedAt || null, lastUsedAt: r.lastUsedAt || null, requests: r.requests || 0, errors: r.errors || 0,
  });
  const own = (userId, id) => {
    const r = relays.get(String(id));
    if (!r || r.user !== userKey(userId)) throw new AppError('NOT_FOUND', '中转不存在', 404);
    return r;
  };
  const issue = (r, secret) => {
    const token = newToken();
    if (r.keyHash) byHash.delete(r.keyHash);
    r.keyHash = sha256(token);
    r.keyTail = token.slice(-4);
    r.sealed = seal(token, r.id, secret);
    r.tokenBox = boxToken(key, token);
    byHash.set(r.keyHash, r.id);
    return token;
  };

  return {
    list: (userId) => [...relays.values()].filter((r) => r.user === userKey(userId)).sort((a, b) => b.createdAt - a.createdAt).map(view),
    /** secret: { baseUrl, header: [name, value], key, custom } */
    create(userId, { accountId, name, host }, secret) {
      if ([...relays.values()].filter((r) => r.user === userKey(userId)).length >= MAX_PER_USER) {
        throw new AppError('TOO_MANY', `每个账号最多 ${MAX_PER_USER} 个中转`, 409);
      }
      const r = { id: crypto.randomBytes(8).toString('hex'), user: userKey(userId), accountId, name, host, createdAt: Date.now(), requests: 0, errors: 0 };
      const token = issue(r, secret);
      relays.set(r.id, r);
      saveNow();
      return { relay: view(r), token };
    },
    rotate(userId, id, secret, host) {
      const r = own(userId, id);
      const token = issue(r, secret);
      r.rotatedAt = Date.now();
      if (host) r.host = host;
      saveNow();
      return { relay: view(r), token };
    },
    update(userId, id, { name, enabled }) {
      const r = own(userId, id);
      if (typeof name === 'string') r.name = name;
      if (typeof enabled === 'boolean') r.disabled = !enabled;
      saveNow();
      return view(r);
    },
    remove(userId, id) {
      const r = own(userId, id);
      relays.delete(r.id);
      byHash.delete(r.keyHash);
      saveNow();
    },
    get: (userId, id) => own(userId, id),
    /** The relay key again, for the owner's 复制密钥. */
    token(userId, id) {
      const r = own(userId, id);
      if (!r.tokenBox) throw new AppError('NO_KEY', '这个中转创建于旧版本，密钥没有保存。点“重置密钥”生成新密钥后即可随时复制。', 409);
      try { return unboxToken(key, r.tokenBox); }
      catch { throw new AppError('NO_KEY', '中转密钥无法解密（服务器密钥已变更），请点“重置密钥”。', 409); }
    },
    /** { relay, secret } for a relay key, or null. */
    resolve(token) {
      if (!TOKEN.test(token)) return null;
      const id = byHash.get(sha256(token));
      const r = id && relays.get(id);
      if (!r) return null;
      try { return { relay: r, secret: unseal(token, r.id, r.sealed) }; } catch { return null; }
    },
    touch(r, ok) {
      r.requests = (r.requests || 0) + 1;
      if (!ok) r.errors = (r.errors || 0) + 1;
      r.lastUsedAt = Date.now();
      saveSoon();
    },
    get count() { return relays.size; },
    close: saveNow,
  };
}

/** The relay key a client sent, and how (so the upstream gets the same style). */
export function relayCredential(req, url) {
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  const candidates = [
    ['bearer', bearer], ['x-api-key', req.headers['x-api-key']], ['x-goog-api-key', req.headers['x-goog-api-key']],
    ['api-key', req.headers['api-key']], ['query', url.searchParams.get('key')],
  ];
  for (const [style, value] of candidates) if (typeof value === 'string' && value.startsWith(TOKEN_PREFIX)) return { style, token: value.trim() };
  for (const [style, value] of candidates) if (typeof value === 'string' && value) return { style, token: value.trim() };
  return { style: 'bearer', token: '' };
}

/** Auth headers for the upstream, mirroring how the client authenticated. */
export function upstreamAuth(secret, style, target) {
  const official = /(^|\.)anthropic\.com$/i.test(target.hostname);
  if (secret.custom) return { [secret.header[0]]: secret.header[1] };
  if (style === 'x-api-key' || official) return { 'x-api-key': secret.key };
  if (style === 'x-goog-api-key') return { 'x-goog-api-key': secret.key };
  if (style === 'api-key') return { 'api-key': secret.key };
  if (style === 'query') { target.searchParams.set('key', secret.key); return {}; }
  return { [secret.header[0]]: secret.header[1] };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'request-id, x-request-id, retry-after',
};

function apiError(res, status, message, type = 'relay_error') {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify({ type: 'error', error: { type, message, code: type } }));
}

/** The proxy itself: everything under /chat/relay/. No cookies, no CSRF; the relay key is the credential. */
export function createRelayProxy({ store, lookup = safeLookup, agent, clientAddress = (req) => req.socket.remoteAddress }) {
  const active = new Map(); // relay id -> count
  let running = 0;
  const minute = new Map(); // relay id -> { start, n }
  const bad = new Map(); // address -> { start, n }
  const tick = (map, key) => {
    const now = Date.now();
    const e = map.get(key);
    if (!e || now - e.start > 60000) { map.set(key, { start: now, n: 1 }); if (map.size > 5000) map.delete(map.keys().next().value); return 1; }
    return ++e.n;
  };

  return async function relay(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta').slice(0, 1000),
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    const address = clientAddress(req);
    const badSoFar = bad.get(address);
    if (badSoFar && Date.now() - badSoFar.start < 60000 && badSoFar.n >= BAD_PER_MINUTE) return apiError(res, 429, '密钥错误次数过多，请稍后再试', 'rate_limit_error');
    const { style, token } = relayCredential(req, url);
    const found = token ? store.resolve(token) : null;
    if (!found) { tick(bad, address); req.resume(); return apiError(res, 401, '中转密钥无效（在 API 网站的 API 中转 页面创建）', 'authentication_error'); }
    const { relay: r, secret } = found;
    if (r.disabled) { req.resume(); return apiError(res, 403, '这个中转已停用', 'permission_error'); }
    if (tick(minute, r.id) > PER_MINUTE) { req.resume(); return apiError(res, 429, `每个中转每分钟最多 ${PER_MINUTE} 次请求`, 'rate_limit_error'); }
    if ((active.get(r.id) || 0) >= PER_RELAY || running >= TOTAL) { req.resume(); return apiError(res, 429, '同时进行的中转请求过多，请稍后重试', 'rate_limit_error'); }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) { req.resume(); return apiError(res, 413, '请求体过大（上限 64 MB）', 'request_too_large'); }

    let target;
    try {
      const rest = url.pathname.slice(RELAY_PREFIX.length) + url.search;
      target = relayTarget(secret.baseUrl, rest);
      if (style === 'query') target.searchParams.delete('key');
    } catch (error) { req.resume(); return apiError(res, 400, error instanceof AppError ? error.message : '目标地址无效', 'invalid_request_error'); }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (FORWARD.has(k) && typeof v === 'string') headers[k] = v;
    Object.assign(headers, upstreamAuth(secret, style, target));
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    else if (req.headers['transfer-encoding']) headers['transfer-encoding'] = 'chunked';

    active.set(r.id, (active.get(r.id) || 0) + 1);
    running++;
    let finished = false;
    const done = (ok) => {
      if (finished) return;
      finished = true;
      running--;
      const n = (active.get(r.id) || 1) - 1;
      if (n <= 0) active.delete(r.id); else active.set(r.id, n);
      store.touch(r, ok);
    };

    const lib = target.protocol === 'http:' ? http : https;
    const upstream = lib.request(target, { method: req.method, headers, lookup, agent: lib === https ? agent : undefined });
    const headTimer = setTimeout(() => upstream.destroy(new Error('CONNECT_TIMEOUT')), HEAD_TIMEOUT_MS);
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(new Error('ABORTED')); done(res.writableEnded); });
    upstream.on('response', (up) => {
      clearTimeout(headTimer);
      up.setTimeout?.(IDLE_MS, () => up.destroy(new Error('IDLE_TIMEOUT')));
      upstream.setTimeout(IDLE_MS, () => upstream.destroy(new Error('IDLE_TIMEOUT')));
      const out = { ...CORS, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
      for (const [k, v] of Object.entries(up.headers)) if (PASS_BACK.test(k) && v !== undefined) out[k] = v;
      res.writeHead(up.statusCode || 502, out);
      res.flushHeaders();
      up.on('data', (chunk) => { if (!res.write(chunk)) { up.pause(); res.once('drain', () => up.resume()); } });
      up.on('end', () => { res.end(); done(up.statusCode < 400); });
      up.on('error', () => { res.destroy(); done(false); });
    });
    upstream.on('error', (error) => {
      clearTimeout(headTimer);
      const message = error?.code === 'NON_PUBLIC_ADDRESS' ? '目标解析到了非公网地址，已拒绝' : error?.message === 'CONNECT_TIMEOUT' ? '上游响应超时' : error?.message === 'ABORTED' ? '已取消' : '无法连接上游接口';
      if (!res.writableEnded) apiError(res, 502, message, 'upstream_error');
      done(false);
    });
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { upstream.destroy(new Error('TOO_LARGE')); apiError(res, 413, '请求体过大（上限 64 MB）', 'request_too_large'); req.destroy(); return; }
      if (!upstream.write(chunk)) { req.pause(); upstream.once('drain', () => req.resume()); }
    });
    req.on('end', () => upstream.end());
    req.on('error', () => upstream.destroy(new Error('ABORTED')));
  };
}
