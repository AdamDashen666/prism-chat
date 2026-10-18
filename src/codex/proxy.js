// The OpenAI-compatible endpoint of Codex 转发: /chat/codex/v1/{models,chat/completions,responses}.
// Callers authenticate with an sk-codex-… key made on the admin page (not with the site
// session); the ChatGPT login behind it never leaves the server.
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { AppError } from '../vault.js';
import { json, readBody } from '../http.js';
import { decoded, readText, sseEvents } from '../upstream.js';
import { chatToResponses, createChatTranslator, createResponsesCollector, modelObject, normalizeResponses } from './translate.js';

export const CODEX_PREFIX = '/chat/codex/v1';
const MAX_BODY = 22 * 1024 * 1024;
const PER_KEY_CONCURRENT = 6;
const TOTAL_CONCURRENT = 16;
const PER_MINUTE = 120;
const BAD_PER_MINUTE = 30;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'x-codex-proxy-ignored, retry-after' };

function fail(res, status, message, type = 'invalid_request_error', code = null, extra = {}) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra });
  res.end(JSON.stringify({ error: { message, type, param: null, code } }));
}

const typeOf = (status) => (status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error');

/** Upstream error body -> the message to show, plus a status the client can act on. */
function upstreamProblem(status, text, headers) {
  let message = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  let code = null;
  try {
    const j = JSON.parse(text);
    const e = j.error && typeof j.error === 'object' ? j.error : null;
    message = e?.message || (typeof j.detail === 'string' ? j.detail : j.detail?.message) || (typeof j.error === 'string' ? j.error : '') || j.message || message;
    code = e?.code || e?.type || j.code || null;
    if (e?.resets_in_seconds) message += `（约 ${Math.ceil(e.resets_in_seconds / 60)} 分钟后重置）`;
  } catch { /* plain text */ }
  const mapped = status === 429 ? 429 : status === 404 || status === 400 || status === 413 || status === 422 ? 400 : 502;
  const extra = status === 429 && headers['retry-after'] ? { 'Retry-After': headers['retry-after'] } : {};
  const prefix = status === 401 || status === 403 ? `ChatGPT 拒绝了请求（${status}）：` : '';
  return { status: mapped, message: `${prefix}${message || `上游返回 ${status}`}`, code, extra };
}

function presented(req, url) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1];
  return bearer || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '') || (typeof req.headers['api-key'] === 'string' ? req.headers['api-key'] : '');
}

export function createCodexProxy({ codex, keys, clientAddress = (req) => req.socket.remoteAddress, idleMs = 300000 }) {
  const active = new Map();
  let running = 0;
  const minute = new Map();
  const bad = new Map();
  const tick = (map, k) => {
    const t = Date.now();
    const e = map.get(k);
    if (!e || t - e.start > 60000) { map.set(k, { start: t, n: 1 }); if (map.size > 5000) map.delete(map.keys().next().value); return 1; }
    return ++e.n;
  };

  async function models(res) {
    const list = await codex.modelList();
    const created = Math.floor((list.fetchedAt || Date.now()) / 1000);
    const visible = list.items.filter((m) => m.visible !== false);
    const items = visible.length ? visible : list.items;
    json(res, 200, { object: 'list', data: items.map((m) => modelObject(m, created)) });
    return items;
  }

  async function oneModel(res, id) {
    const list = await codex.modelList();
    const m = list.items.find((x) => x.id === id);
    if (!m) return fail(res, 404, `模型 ${id} 不存在`, 'invalid_request_error', 'model_not_found');
    return json(res, 200, modelObject(m, Math.floor(list.fetchedAt / 1000)));
  }

  /** POST /responses upstream; resolves { upstream } or answers the client with the error and resolves null. */
  async function open(request, res, signal, record) {
    const upstream = await codex.backend('/responses', {
      body: Buffer.from(JSON.stringify(request)), signal, idleMs,
      headers: { accept: 'text/event-stream', session_id: typeof request.prompt_cache_key === 'string' && request.prompt_cache_key ? request.prompt_cache_key : crypto.randomUUID() },
    });
    if (upstream.statusCode >= 200 && upstream.statusCode < 300) return upstream;
    const text = await readText(decoded(upstream));
    const p = upstreamProblem(upstream.statusCode, text, upstream.headers);
    if (upstream.statusCode >= 500 || upstream.statusCode === 401 || upstream.statusCode === 403) codex.record('proxy', `上游 ${upstream.statusCode}：${p.message}`);
    record(false);
    fail(res, p.status, p.message, typeOf(p.status), p.code, p.extra);
    return null;
  }

  const SSE = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS };
  const ignoredHeader = (dropped) => (dropped.length ? { 'x-codex-proxy-ignored': dropped.join(',') } : {});

  async function chat(req, res, signal, record) {
    const { request, stream, includeUsage, dropped } = chatToResponses(await readBody(req, MAX_BODY));
    const upstream = await open(request, res, signal, record);
    if (!upstream) return;
    const t = createChatTranslator({ model: request.model, includeUsage });
    let wrote = false;
    const write = (obj) => { if (!res.writableEnded) res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`); };
    try {
      if (stream) { res.writeHead(200, { ...SSE, ...ignoredHeader(dropped) }); wrote = true; }
      for await (const payload of sseEvents(decoded(upstream), idleMs)) {
        if (payload === '[DONE]') break;
        for (const c of t.push(payload)) if (stream) write(c);
        if (t.failed || signal.aborted) break;
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = error?.message === 'IDLE_TIMEOUT' ? '上游长时间没有输出' : '与上游的连接中断';
      codex.record('proxy', message);
      record(false);
      if (stream && wrote) { write({ error: { message, type: 'upstream_error', code: null } }); write('[DONE]'); res.end(); return; }
      return fail(res, 502, message, 'server_error');
    }
    if (t.failed) {
      codex.record('proxy', t.failed.message);
      record(false);
      if (stream) { write({ error: t.failed }); write('[DONE]'); res.end(); return; }
      return fail(res, 502, t.failed.message, 'server_error', t.failed.code);
    }
    record(true);
    if (stream) { for (const c of t.finish()) write(c); write('[DONE]'); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...ignoredHeader(dropped) });
    res.end(JSON.stringify(t.completion()));
  }

  async function responses(req, res, signal, record) {
    const { request, stream, dropped } = normalizeResponses(await readBody(req, MAX_BODY));
    const upstream = await open(request, res, signal, record);
    if (!upstream) return;
    if (stream) {
      // Events pass through untouched (the Codex backend already speaks Responses).
      res.writeHead(200, { ...SSE, ...ignoredHeader(dropped) });
      record(true);
      pipeline(decoded(upstream), res, () => {});
      return;
    }
    const collector = createResponsesCollector();
    try {
      for await (const payload of sseEvents(decoded(upstream), idleMs)) {
        if (payload === '[DONE]') break;
        collector.push(payload);
        if (collector.failed || signal.aborted) break;
      }
    } catch (error) {
      if (signal.aborted) return;
      codex.record('proxy', '与上游的连接中断');
      record(false);
      return fail(res, 502, '与上游的连接中断', 'server_error');
    }
    if (collector.failed) { codex.record('proxy', collector.failed.message); record(false); return fail(res, 502, collector.failed.message, 'server_error', collector.failed.code); }
    record(true);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...ignoredHeader(dropped) });
    res.end(JSON.stringify(collector.result()));
  }

  return async function handle(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || 'authorization, content-type, x-api-key').slice(0, 500), 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const address = clientAddress(req);
    const prior = bad.get(address);
    if (prior && Date.now() - prior.start < 60000 && prior.n >= BAD_PER_MINUTE) { req.resume(); return fail(res, 429, 'Key 错误次数过多，请稍后再试', 'rate_limit_error'); }
    const key = keys.resolve(presented(req, url));
    if (!key) { tick(bad, address); req.resume(); return fail(res, 401, 'Key 无效或已撤销（在 API 网站的 Codex 转发页面创建）', 'authentication_error', 'invalid_api_key'); }
    if (tick(minute, key.id) > PER_MINUTE) { req.resume(); return fail(res, 429, `每个 Key 每分钟最多 ${PER_MINUTE} 次请求`, 'rate_limit_error'); }
    const path = url.pathname.slice(CODEX_PREFIX.length).replace(/\/+$/, '') || '/';
    const route = `${req.method} ${path}`;
    const modelPath = /^\/models\/(.+)$/.exec(path);
    const known = ['GET /models', 'POST /chat/completions', 'POST /responses'].includes(route) || (req.method === 'GET' && modelPath);
    if (!known) { req.resume(); return fail(res, 404, 'Codex 转发只支持 /v1/models、/v1/chat/completions 和 /v1/responses', 'invalid_request_error', 'unsupported_endpoint'); }
    if ((active.get(key.id) || 0) >= PER_KEY_CONCURRENT || running >= TOTAL_CONCURRENT) { req.resume(); return fail(res, 429, '同时进行的请求过多，请稍后重试', 'rate_limit_error'); }

    active.set(key.id, (active.get(key.id) || 0) + 1);
    running++;
    const controller = new AbortController();
    let done = false;
    let counted = false;
    const record = (ok) => { if (!counted) { counted = true; keys.touch(key, ok); } };
    const finish = () => {
      if (done) return;
      done = true;
      running--;
      const n = (active.get(key.id) || 1) - 1;
      if (n <= 0) active.delete(key.id); else active.set(key.id, n);
      if (!counted) keys.touch(key, res.statusCode < 400);
    };
    res.on('close', () => { if (!res.writableEnded) controller.abort(); finish(); });
    try {
      if (route === 'GET /models') return await models(res);
      if (modelPath) return await oneModel(res, decodeURIComponent(modelPath[1]));
      if (route === 'POST /chat/completions') return await chat(req, res, controller.signal, record);
      return await responses(req, res, controller.signal, record);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof AppError) {
        const status = error.status >= 400 && error.status < 600 ? error.status : 400;
        record(false);
        return fail(res, status, error.message, typeOf(status), error.code);
      }
      codex.record('proxy', '转发出错');
      record(false);
      return fail(res, 500, '转发出错，请稍后重试', 'server_error');
    }
  };
}
