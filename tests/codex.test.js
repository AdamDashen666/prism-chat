// Codex 转发: admin-only login (paste the callback address), token refresh and rotation,
// API keys, and the OpenAI-compatible endpoint, against a fake OpenAI auth server and a
// fake Codex backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createChatServer } from '../src/server.js';
import { createVaultClient } from '../src/vault.js';
import { safeLookup } from '../src/net.js';
import { createCodexStore, decryptState } from '../src/codex/store.js';
import { chatToResponses, createChatTranslator, normalizeResponses } from '../src/codex/translate.js';
import { claimsOf, decodeJwt, generatePkce, parseModels } from '../src/codex/auth.js';
import { completeOnce } from '../src/trace/runner.js';
import { Readable } from 'node:stream';

const ORIGIN = 'https://qiuzhang.xyz';
const HOST = 'openai.fake.example';
const ADMIN = '__Host-PrismVault=admin-session';
const USER = '__Host-PrismVault=user-session';
const ACCOUNT = 'acct-1234567890abcdef';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const versionLess = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

let upstream, upstreamPort, vaultServer, vaultPort, chat, chatPort, agent, tmp, codexDir, codexKey, store;
// What the fakes saw and how they behave; tests reset it with resetFake().
const fx = {};
function resetFake() {
  Object.assign(fx, {
    refreshToken: 'rt-1', refreshCount: 0, accessTtl: 3600, accessTokens: new Set(), refreshMode: 'ok', refreshDelay: 0,
    tokenCalls: [], revokeCalls: [], backendCalls: [], reject401Once: false, exchange: null, challenge: '',
    minVersion: '0.0.0', // clients older than this only get the hidden model, like the real backend does
  });
}
resetFake();

function issue(ttl = fx.accessTtl) {
  const access = jwt({ exp: now() + ttl, jti: crypto.randomUUID(), 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus' } });
  fx.accessTokens.add(access);
  return access;
}

const sse = (res, list, status = 200, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/event-stream', ...headers });
  for (const e of list) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const usage = { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } };
const completed = { type: 'response.completed', response: { id: 'resp_1', usage } };
const textStream = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.reasoning_summary_part.added', summary_index: 0 },
  { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
  { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', role: 'assistant' } },
  { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo' },
  { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } },
  completed,
];
const toolStream = [
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city"' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':"Paris"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' } },
  completed,
];

function startUpstream(key, cert) {
  return https.createServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const type = String(req.headers['content-type'] || '');
    let body = {};
    try { body = type.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { /* not a body */ }
    const url = new URL(req.url, 'https://x');
    const send = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };

    if (url.pathname === '/oauth/token') {
      fx.tokenCalls.push({ type, body });
      if (body.grant_type === 'authorization_code') {
        fx.exchange = body;
        const challenge = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url');
        if (body.code === 'used-code') return send(400, { error: 'invalid_grant', error_description: 'Code already used' });
        if (body.code !== 'good-code' || challenge !== fx.challenge) return send(400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
        return send(200, {
          id_token: jwt({ email: 'owner@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: ACCOUNT, chatgpt_user_id: 'user-1' } }),
          access_token: issue(), refresh_token: fx.refreshToken,
        });
      }
      if (body.grant_type === 'refresh_token') {
        if (fx.refreshDelay) await new Promise((r) => setTimeout(r, fx.refreshDelay));
        if (fx.refreshMode === 'transient') return send(503, { error: 'temporarily_unavailable' });
        if (fx.refreshMode === 'reused' || body.refresh_token !== fx.refreshToken) return send(401, { error: { code: 'refresh_token_reused', message: 'used' } });
        fx.refreshCount++;
        fx.refreshToken = `rt-${fx.refreshCount + 1}`;
        return send(200, { access_token: issue(), refresh_token: fx.refreshToken }); // no id_token: allowed
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/oauth/revoke') { fx.revokeCalls.push(body); return send(200, {}); }

    if (url.pathname.startsWith('/backend-api/codex/')) {
      fx.backendCalls.push({ path: url.pathname, query: url.search, headers: req.headers, body });
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization))?.[1];
      if (fx.reject401Once) { fx.reject401Once = false; return send(401, { detail: 'token expired' }); }
      if (!fx.accessTokens.has(bearer)) return send(401, { detail: 'unknown token' });
      if (url.pathname.endsWith('/models')) {
        if (versionLess(url.searchParams.get('client_version') || '0', fx.minVersion)) {
          return send(200, { models: [{ slug: 'codex-auto-review', display_name: 'Auto review', visibility: 'hide' }] });
        }
        return send(200, { models: [
          { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', description: 'coding', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
          { slug: 'old-model', display_name: 'Old', visibility: 'hide' },
        ] });
      }
      if (url.pathname.endsWith('/responses')) {
        const rate = { 'x-codex-primary-used-percent': '37.5', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1900000000', 'x-codex-secondary-used-percent': '10' };
        if (body.model === 'gpt-busy') {
          fx.busyCalls = (fx.busyCalls || 0) + 1;
          if (fx.busyCalls === 1) return send(503, { detail: 'busy' });
        }
        if (body.model === 'gpt-files') {
          const args = JSON.stringify({ path: 'note.txt', content: 'hi' });
          return sse(res, (body.input || []).some((i) => i.type === 'function_call_output') ? textStream : [
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'write_file', arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_9', delta: args },
            { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'write_file', arguments: args } },
            completed], 200, rate);
        }
        if (body.model === 'gpt-limit') return send(429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 1800 } }, { 'retry-after': '1800' });
        if (body.model === 'gpt-bad') return send(400, { detail: 'Unsupported model' });
        if (body.model === 'gpt-fail') return sse(res, [{ type: 'response.output_item.added', item: { type: 'message', id: 'm' } }, { type: 'response.output_text.delta', delta: 'par' }, { type: 'response.failed', response: { error: { message: 'model overloaded', code: 'server_error' } } }]);
        return sse(res, body.model === 'gpt-tools' ? toolStream : textStream, 200, rate);
      }
    }
    return send(404, {});
  });
}

// Fake Vault.Web: just the session check, with an admin and a normal user.
function startVault() {
  return http.createServer((req, res) => {
    const cookie = req.headers.cookie || '';
    const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(d === undefined ? '' : JSON.stringify(d)); };
    if (req.url.split('?')[0] === '/api/accounts') return send(200, { items: [], total: 0, page: 1, pageSize: 24 });
    if (req.url.split('?')[0] === '/api/auth/me') {
      if (cookie.includes('admin-session')) return send(200, { id: 'admin1', userName: 'Boss', isAdmin: true, mustChangePassword: false });
      if (cookie.includes('user-session')) return send(200, { id: 'user1', userName: 'Bob', isAdmin: false, mustChangePassword: false });
      return send(401);
    }
    return send(404);
  });
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-codex-'));
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
  const openssl = candidates.find((c) => { try { execFileSync(c, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '1',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(tmp, 'c.pem'));
  upstream = startUpstream(fs.readFileSync(path.join(tmp, 'k.pem')), cert);
  upstreamPort = await listen(upstream);
  vaultServer = startVault();
  vaultPort = await listen(vaultServer);
  agent = new https.Agent({ ca: cert });
  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (hostname === HOST) return options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    return safeLookup(hostname, options, cb);
  };
  codexDir = path.join(tmp, 'codex');
  codexKey = crypto.randomBytes(32);
  store = createCodexStore({ dir: codexDir, key: codexKey });
  chat = createChatServer({
    vault: createVaultClient({ port: vaultPort }), origin: ORIGIN, lookup, agent, csrfKey: Buffer.alloc(32, 1), jobDir: path.join(tmp, 'jobs'),
    retryDelays: [5, 5, 5, 5], codexStore: store, codexConfig: { issuer: `https://${HOST}:${upstreamPort}`, backend: `https://${HOST}:${upstreamPort}/backend-api/codex` },
  });
  chatPort = await listen(chat);
});

after(() => {
  chat?.closeAllConnections?.(); chat?.close(); upstream?.close(); vaultServer?.close(); agent?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function raw(method, route, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: chatPort, method, path: route, headers: {
      ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const csrf = async (cookie) => JSON.parse((await raw('GET', '/api/chat/session', { cookie })).text).csrf;
const get = (route, cookie = ADMIN) => raw('GET', route, { cookie });
const post = async (route, body = {}, cookie = ADMIN) => raw('POST', route, { cookie, body, headers: { origin: ORIGIN, 'x-chat-csrf': await csrf(cookie) } });
const api = (route, key, body, extra = {}) => raw(body === undefined ? 'GET' : 'POST', `/chat/codex/v1${route}`, { body, headers: { authorization: `Bearer ${key}`, ...extra } });
const sseData = (text) => text.split('\n\n').map((b) => b.replace(/^data: /, '').trim()).filter(Boolean);
const status = async () => (await get('/api/chat/codex')).json();

async function login() {
  resetFake();
  const start = (await post('/api/chat/codex/login/start')).json();
  fx.challenge = new URL(start.login.url).searchParams.get('code_challenge');
  const state = new URL(start.login.url).searchParams.get('state');
  const done = await post('/api/chat/codex/login/complete', { url: `http://localhost:1455/auth/callback?code=good-code&state=${state}` });
  assert.equal(done.status, 200, done.text);
  return start;
}

test('only admins reach Codex 转发; everyone else gets 403, anonymous 401', async () => {
  assert.equal((await get('/api/chat/codex', USER)).status, 403);
  assert.equal((await post('/api/chat/codex/login/start', {}, USER)).status, 403);
  assert.equal((await post('/api/chat/codex/keys', { name: 'x' }, USER)).status, 403);
  assert.equal((await get('/chat/codex', USER)).status, 403);
  assert.equal((await get('/chat/codex', ADMIN)).status, 200);
  assert.equal((await get('/api/chat/codex', '')).status, 401);
  assert.equal((await raw('POST', '/api/chat/codex/login/start', { cookie: ADMIN, body: {} })).status, 403, 'CSRF and origin are still required');
});

test('login: authorize link with PKCE, paste the callback address, tokens stay on the server', async () => {
  assert.equal((await status()).state, 'disconnected');
  const start = (await post('/api/chat/codex/login/start')).json();
  const u = new URL(start.login.url);
  assert.equal(u.origin + u.pathname, `https://${HOST}:${upstreamPort}/oauth/authorize`);
  const q = u.searchParams;
  assert.equal(q.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.match(q.get('scope'), /offline_access/);
  assert.equal(q.get('codex_cli_simplified_flow'), 'true');
  assert.ok(start.pending && start.pending.expiresAt > Date.now());
  fx.challenge = q.get('code_challenge');

  // a wrong state, a used code and garbage are rejected without losing nothing important
  const state = q.get('state');
  assert.equal((await post('/api/chat/codex/login/complete', { url: `http://localhost:1455/auth/callback?code=good-code&state=other` })).status, 400);
  assert.equal((await post('/api/chat/codex/login/complete', { url: 'not an address' })).status, 400);
  const ok = await post('/api/chat/codex/login/complete', { url: `http://localhost:1455/auth/callback?code=good-code&state=${state}&scope=openid` });
  assert.equal(ok.status, 200, ok.text);
  const s = ok.json();
  assert.equal(s.state, 'connected');
  assert.equal(s.account.email, 'owner@example.com');
  assert.equal(s.account.plan, 'plus');
  assert.equal(s.account.accountId, `${ACCOUNT.slice(0, 8)}…`);
  assert.equal(fx.exchange.redirect_uri, 'http://localhost:1455/auth/callback');
  assert.equal(fx.exchange.grant_type, 'authorization_code');
  assert.ok(fx.tokenCalls.at(-1).type.includes('x-www-form-urlencoded'));
  // Nothing secret reaches the browser.
  assert.ok(!(await get('/api/chat/codex')).text.match(/rt-1|access_token|refresh_token|eyJ/));
  assert.equal(s.pending, null);
});

test('the state file is encrypted and survives a restart', async () => {
  const file = fs.readFileSync(path.join(codexDir, 'codex.json'), 'utf8');
  assert.ok(!file.includes('rt-1') && !file.includes('owner@example.com') && !file.includes(ACCOUNT), 'no plaintext');
  const plain = decryptState(codexKey, JSON.parse(file));
  assert.equal(plain.tokens.refresh_token, 'rt-1');
  assert.equal(createCodexStore({ dir: codexDir, key: codexKey }).state.info.email, 'owner@example.com');
  // A different key must not be able to open it, and must not overwrite it.
  const wrong = createCodexStore({ dir: codexDir, key: crypto.randomBytes(32) });
  assert.match(wrong.loadError, /解密/);
  wrong.save();
  assert.equal(fs.readFileSync(path.join(codexDir, 'codex.json'), 'utf8'), file);
});

test('API keys: create, copy again, rename, revoke; the endpoint needs a valid key', async () => {
  const created = (await post('/api/chat/codex/keys', { name: '我的客户端' })).json();
  assert.match(created.token, /^sk-codex-[A-Za-z0-9_-]{32}$/);
  assert.equal(created.base, `${ORIGIN}/chat/codex/v1`);
  const id = created.key.id;
  assert.equal((await post(`/api/chat/codex/keys/${id}/key`)).json().value, created.token);
  assert.equal((await post(`/api/chat/codex/keys/${id}/key`, {}, USER)).status, 403);
  assert.ok(!(await get('/api/chat/codex')).text.includes(created.token), 'the list never shows full keys');

  assert.equal((await api('/models', 'sk-codex-wrong')).status, 401);
  assert.equal((await raw('GET', '/chat/codex/v1/models')).status, 401);
  const models = await api('/models', created.token);
  assert.equal(models.status, 200, models.text);
  assert.deepEqual(models.json().data.map((m) => m.id), ['gpt-5-codex'], 'hidden models are not listed');
  const query = fx.backendCalls.at(-1);
  assert.match(query.query, /client_version=/);
  assert.equal(query.headers['chatgpt-account-id'], ACCOUNT);

  await post(`/api/chat/codex/keys/${id}/update`, { name: '改名' });
  assert.equal((await status()).keys[0].name, '改名');
  await post(`/api/chat/codex/keys/${id}/delete`);
  assert.equal((await api('/models', created.token)).status, 401, 'revoked');
  assert.equal((await status()).keys.length, 0);
});

test('chat completions: request translation, streamed chunks, usage', async () => {
  const key = (await post('/api/chat/codex/keys', { name: 'c' })).json().token;
  fx.backendCalls.length = 0;
  const res = await api('/chat/completions', key, {
    model: 'gpt-5-codex', stream: true, stream_options: { include_usage: true }, temperature: 0.2, max_tokens: 100, reasoning_effort: 'high',
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'earlier', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_0', content: 'result' }, { role: 'user', content: 'go' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    response_format: { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object' }, strict: true } },
  }, { origin: 'https://app.example' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.headers['x-codex-proxy-ignored'], 'max_tokens,temperature');

  const call = fx.backendCalls.find((c) => c.path.endsWith('/responses'));
  const h = call.headers;
  assert.match(h.authorization, /^Bearer eyJ|^Bearer ey/);
  assert.ok(!h.authorization.includes(key), 'the client key is never sent upstream');
  assert.equal(h['chatgpt-account-id'], ACCOUNT);
  assert.equal(h.originator, 'codex_cli_rs');
  assert.equal(h['openai-beta'], 'responses=experimental');
  assert.equal(h.accept, 'text/event-stream');
  assert.ok(h.session_id);
  const b = call.body;
  assert.equal(b.store, false);
  assert.equal(b.stream, true);
  assert.equal(b.instructions, 'Be brief.');
  assert.equal(b.temperature, undefined);
  assert.equal(b.max_output_tokens, undefined);
  assert.deepEqual(b.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(b.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });
  assert.deepEqual(b.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier' }] });
  assert.deepEqual(b.input[2], { type: 'function_call', call_id: 'call_0', name: 'f', arguments: '{}' });
  assert.deepEqual(b.input[3], { type: 'function_call_output', call_id: 'call_0', output: 'result' });
  assert.equal(b.tools[0].name, 'get_weather');
  assert.deepEqual(b.text.format, { type: 'json_schema', name: 'r', schema: { type: 'object' }, strict: true });

  const events = sseData(res.text);
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content || '').join(''), 'Hello');
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.reasoning_content || '').join(''), 'Thinking');
  const final = chunks.find((c) => c.choices[0]?.finish_reason);
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } });
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'gpt-5-codex'));
});

test('chat completions without streaming, with tool calls', async () => {
  const key = (await post('/api/chat/codex/keys', { name: 't' })).json().token;
  const res = await api('/chat/completions', key, { model: 'gpt-tools', messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }] });
  assert.equal(res.status, 200, res.text);
  const c = res.json();
  assert.equal(c.object, 'chat.completion');
  assert.equal(c.choices[0].finish_reason, 'tool_calls');
  assert.equal(c.choices[0].message.content, null);
  assert.deepEqual(c.choices[0].message.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
  assert.equal(c.usage.total_tokens, 17);

  // Streamed tool call: id and name first, argument pieces after.
  const s = await api('/chat/completions', key, { model: 'gpt-tools', stream: true, messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }] });
  const chunks = sseData(s.text).slice(0, -1).map((e) => JSON.parse(e));
  const tc = chunks.flatMap((x) => x.choices[0]?.delta?.tool_calls || []);
  assert.deepEqual(tc[0], { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } });
  assert.equal(tc.slice(1).map((x) => x.function.arguments).join(''), '{"city":"Paris"}');
  assert.equal(chunks.find((x) => x.choices[0]?.finish_reason).choices[0].finish_reason, 'tool_calls');
});

test('responses endpoint: stateless request fixes, streamed pass-through and collected JSON', async () => {
  const key = (await post('/api/chat/codex/keys', { name: 'r' })).json().token;
  fx.backendCalls.length = 0;
  const json = await api('/responses', key, { model: 'gpt-5-codex', input: 'hello', max_output_tokens: 50, temperature: 1 });
  assert.equal(json.status, 200, json.text);
  const sent = fx.backendCalls.find((c) => c.path.endsWith('/responses')).body;
  assert.deepEqual(sent.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.ok(sent.instructions);
  assert.equal(sent.max_output_tokens, undefined);
  const r = json.json();
  assert.equal(r.object, 'response');
  assert.equal(r.output_text, 'Hello');
  assert.equal(r.output.length, 1);
  assert.equal(r.usage.output_tokens, 5);

  const stream = await api('/responses', key, { model: 'gpt-5-codex', stream: true, input: [{ type: 'message', role: 'user', content: 'x' }] });
  assert.match(stream.headers['content-type'], /text\/event-stream/);
  assert.match(stream.text, /response\.output_text\.delta/);
  assert.match(stream.text, /response\.completed/);
  assert.equal((await api('/responses', key, { model: 'gpt-5-codex', previous_response_id: 'resp_x', input: 'x' })).status, 400);
  assert.equal((await api('/embeddings', key, { model: 'x', input: 'x' })).status, 404);
});

test('upstream errors reach the client in OpenAI shape; the key counters track results', async () => {
  const created = (await post('/api/chat/codex/keys', { name: 'e' })).json();
  const key = created.token;
  const limited = await api('/chat/completions', key, { model: 'gpt-limit', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '1800');
  assert.equal(limited.json().error.type, 'rate_limit_error');
  assert.match(limited.json().error.message, /usage limit.*30 分钟/);
  const badModel = await api('/chat/completions', key, { model: 'gpt-bad', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(badModel.status, 400);
  assert.match(badModel.json().error.message, /Unsupported model/);
  // A failure inside the stream becomes an error event, then [DONE]; non-streamed it is a 502.
  const failed = await api('/chat/completions', key, { model: 'gpt-fail', stream: true, messages: [{ role: 'user', content: 'x' }] });
  const events = sseData(failed.text);
  assert.equal(events.at(-1), '[DONE]');
  assert.match(JSON.parse(events.at(-2)).error.message, /overloaded/);
  assert.equal((await api('/chat/completions', key, { model: 'gpt-fail', messages: [{ role: 'user', content: 'x' }] })).status, 502);
  assert.equal((await api('/chat/completions', key, { model: '', messages: [] })).status, 400);
  const mine = (await status()).keys.find((k) => k.id === created.key.id);
  assert.equal(mine.requests, 5);
  assert.equal(mine.errors, 5);
  assert.ok((await status()).errors.some((e) => e.kind === 'proxy'), 'server-side failures are logged on the page');
});

test('usage windows reported by the backend are shown', async () => {
  const key = (await post('/api/chat/codex/keys', { name: 'l' })).json().token;
  await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] });
  const { limits } = await status();
  assert.equal(limits.primary.usedPercent, 37.5);
  assert.equal(limits.primary.windowMinutes, 300);
  assert.equal(limits.secondary.usedPercent, 10);
});

test('refresh: expiring tokens are refreshed once for concurrent calls, rotated and persisted', async () => {
  await login();
  fx.accessTtl = 60; // a minute left: inside the refresh window
  const key = (await post('/api/chat/codex/keys', { name: 'rot' })).json().token;
  fx.accessTtl = 3600;
  // make the stored token look about to expire
  store.state.tokens.access_token = issue(60);
  fx.refreshDelay = 80;
  fx.backendCalls.length = 0;
  const results = await Promise.all([1, 2, 3, 4].map(() => api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] })));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.text).join('|'));
  assert.equal(fx.refreshCount, 1, 'one refresh for four concurrent calls');
  assert.equal(fx.refreshToken, 'rt-2');
  const refreshCall = fx.tokenCalls.find((c) => c.body.grant_type === 'refresh_token');
  assert.ok(refreshCall.type.includes('application/json'));
  assert.equal(refreshCall.body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
  // The rotated token is on disk already, and the id_token info survived a response without one.
  const saved = decryptState(codexKey, JSON.parse(fs.readFileSync(path.join(codexDir, 'codex.json'), 'utf8')));
  assert.equal(saved.tokens.refresh_token, 'rt-2');
  assert.equal(saved.info.email, 'owner@example.com');
  assert.ok((await status()).lastRefreshAt > 0);
});

test('a 401 from the backend triggers one refresh and a retry', async () => {
  await login();
  store.state.lastRefresh = Date.now() - 3600_000; // not "just refreshed"
  const key = (await post('/api/chat/codex/keys', { name: '401' })).json().token;
  fx.reject401Once = true;
  fx.refreshCount = 0;
  const res = await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200, res.text);
  assert.equal(fx.refreshCount, 1);
});

test('a lost login (refresh token reused/revoked) is reported and needs a new login; a hiccup is not', async () => {
  await login();
  const key = (await post('/api/chat/codex/keys', { name: 'lost' })).json().token;
  store.state.tokens.access_token = issue(30);
  fx.refreshMode = 'transient';
  // The old token still works for 30 s: a failed refresh does not break the request.
  assert.equal((await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] })).status, 200);
  assert.equal((await status()).state, 'connected');
  assert.ok((await status()).errors.some((e) => e.kind === 'refresh'));

  fx.refreshMode = 'reused';
  assert.equal((await post('/api/chat/codex/refresh')).status, 503);
  const s = await status();
  assert.equal(s.state, 'needs_login');
  assert.match(s.needsLogin, /已被使用过/);
  const res = await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 503);
  assert.match(res.json().error.message, /重新登录/);
  // Signing in again fixes it, and the API keys are still valid.
  await login();
  assert.equal((await status()).state, 'connected');
  assert.equal((await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] })).status, 200);
});

test('importing ~/.codex/auth.json rotates the tokens at once', async () => {
  resetFake();
  await post('/api/chat/codex/disconnect');
  assert.equal((await post('/api/chat/codex/import', { json: 'nope' })).status, 400);
  assert.equal((await post('/api/chat/codex/import', { json: JSON.stringify({ OPENAI_API_KEY: 'sk-x' }) })).status, 400);
  const file = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    id_token: jwt({ email: 'win@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: ACCOUNT } }),
    access_token: issue(), refresh_token: 'rt-1', account_id: ACCOUNT }, last_refresh: new Date().toISOString() });
  const res = await post('/api/chat/codex/import', { json: file });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json().account.email, 'win@example.com');
  assert.equal(res.json().account.plan, 'pro');
  assert.equal(fx.refreshToken, 'rt-2', 'rotated: the copy on the Windows PC is now stale');
  assert.equal(store.state.tokens.refresh_token, 'rt-2');
  // A stale copy (already rotated) is refused and leaves the current login alone.
  const stale = await post('/api/chat/codex/import', { json: file });
  assert.equal(stale.status, 400);
  assert.match(stale.json().error, /无法使用/);
  assert.equal((await status()).state, 'connected');
});

test('disconnect revokes the refresh token and clears the login but keeps the API keys', async () => {
  await login();
  await post('/api/chat/codex/keys', { name: 'kept' });
  const before = (await status()).keys.length;
  const res = await post('/api/chat/codex/disconnect');
  assert.equal(res.status, 200);
  assert.equal(res.json().revoked, true);
  assert.equal(fx.revokeCalls[0].token, 'rt-1');
  assert.equal(fx.revokeCalls[0].token_type_hint, 'refresh_token');
  const s = await status();
  assert.equal(s.state, 'disconnected');
  assert.equal(s.keys.length, before);
  assert.equal(s.account, null);
  const key = (await post('/api/chat/codex/keys', { name: 'x' })).json().token;
  const call = await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(call.status, 503);
  assert.match(call.json().error.message, /尚未登录/);
});

test('login errors: used code, expired link, denied access', async () => {
  resetFake();
  const start = (await post('/api/chat/codex/login/start', { redirect: 'loopback' })).json();
  assert.equal(new URL(start.login.url).searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  fx.challenge = new URL(start.login.url).searchParams.get('code_challenge');
  const used = await post('/api/chat/codex/login/complete', { url: 'code=used-code' });
  assert.equal(used.status, 400);
  assert.match(used.json().error, /Code already used/);
  assert.equal((await status()).pending, null, 'a failed exchange ends the attempt');
  assert.equal((await post('/api/chat/codex/login/complete', { url: 'code=x' })).status, 409);

  const again = (await post('/api/chat/codex/login/start')).json();
  const state = new URL(again.login.url).searchParams.get('state');
  const denied = await post('/api/chat/codex/login/complete', { url: `http://localhost:1455/auth/callback?error=access_denied&error_description=missing_codex_entitlement&state=${state}` });
  assert.equal(denied.status, 400);
  assert.match(denied.json().error, /没有开通 Codex/);
  const third = (await post('/api/chat/codex/login/start')).json();
  store.state.pending.createdAt -= 11 * 60 * 1000;
  assert.ok(third.pending);
  assert.equal((await status()).pending, null, 'expired links disappear');
  assert.equal((await post('/api/chat/codex/login/complete', { url: 'code=x' })).status, 409);
  assert.equal((await post('/api/chat/codex/login/cancel')).status, 200);
});

test('connection test reports problems inline', async () => {
  await login();
  const ok = (await post('/api/chat/codex/test')).json();
  assert.equal(ok.ok, true);
  assert.match(ok.message, /可用模型 1 个/);
  assert.equal(ok.models.items.length, 2, 'the hidden model is kept in the list');
  await post('/api/chat/codex/disconnect');
  const bad = (await post('/api/chat/codex/test')).json();
  assert.equal(bad.ok, false);
  assert.match(bad.message, /尚未登录/);
});

test('health shows Codex state without secrets', async () => {
  const h = (await raw('GET', '/health')).json();
  assert.ok(h.codex && typeof h.codex.keys === 'number');
  assert.ok(!JSON.stringify(h).match(/rt-|sk-codex|eyJ/));
});

test('translation helpers', () => {
  const { verifier, challenge } = generatePkce();
  assert.equal(verifier.length, 86);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const tokenClaims = claimsOf(jwt({ 'https://api.openai.com/profile': { email: 'p@example.com' }, 'https://api.openai.com/auth': { chatgpt_account_id: 'a1', chatgpt_plan_type: 'team', user_id: 'u9' } }), '');
  assert.deepEqual(tokenClaims, { email: 'p@example.com', plan: 'team', accountId: 'a1', userId: 'u9' });
  assert.equal(decodeJwt('garbage'), null);

  assert.throws(() => chatToResponses({ model: 'm', messages: [{ role: 'user', content: 'x' }], n: 2 }), /n=1/);
  assert.throws(() => chatToResponses({ model: 'm', messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }), /Codex 只接受文本和图片/);
  assert.equal(chatToResponses({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).request.instructions, 'You are a helpful assistant.');
  assert.deepEqual(chatToResponses({ model: 'm', messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'function', function: { name: 'f' } }, tools: [{ type: 'function', function: { name: 'f' } }] }).request.tool_choice, { type: 'function', name: 'f' });
  assert.equal(normalizeResponses({ model: 'm', input: 'x', instructions: '  ' }).request.instructions, 'You are a helpful assistant.');

  const t = createChatTranslator({ model: 'm', includeUsage: false });
  t.push({ type: 'response.output_text.delta', delta: 'a' });
  t.push({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage } });
  assert.equal(t.completion().choices[0].finish_reason, 'length');
  assert.equal(t.finish().length, 1, 'no usage chunk unless asked for');
});

test('a Responses stream without finished items still yields the text', async () => {
  const { createResponsesCollector } = await import('../src/codex/translate.js');
  const c = createResponsesCollector();
  for (const e of [{ type: 'response.output_text.delta', delta: 'He' }, { type: 'response.output_text.delta', delta: 'llo' }, { type: 'response.completed', response: { id: 'r', usage } }]) c.push(e);
  const r = c.result();
  assert.equal(r.output_text, 'Hello');
  assert.deepEqual(r.output, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }]);
  assert.equal(r.usage.output_tokens, 5);
});


test('a backend that only lists hidden models for an old client version is asked again as a newer client', async () => {
  await login();
  fx.minVersion = '1.0.0'; // the configured Codex version (0.163.0) is "too old"
  fx.backendCalls.length = 0;
  const res = (await post('/api/chat/codex/test')).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.message, /可用模型 1 个/);
  const asked = fx.backendCalls.filter((c) => c.path.endsWith('/models')).map((c) => new URL(c.path + c.query, 'https://x').searchParams.get('client_version'));
  assert.deepEqual(asked, ['0.163.0', '99.0.0']);
  assert.equal(res.clientVersion, '99.0.0');
  // The version that worked is used from now on, also by the Responses requests.
  const key = (await post('/api/chat/codex/keys', { name: 'v' })).json().token;
  fx.backendCalls.length = 0;
  await api('/chat/completions', key, { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(fx.backendCalls.find((c) => c.path.endsWith('/responses')).headers.version, '99.0.0');
});

test('when no version helps, the hidden model is reported, listed anyway, and models can be added by hand', async () => {
  await login();
  fx.minVersion = '1000.0.0';
  const key = (await post('/api/chat/codex/keys', { name: 'h' })).json().token;
  const res = (await post('/api/chat/codex/test')).json();
  assert.equal(res.ok, false);
  assert.match(res.message, /只返回了未列出的模型（codex-auto-review）/);
  assert.equal(res.models.debug.entries, 1);
  assert.equal(res.models.debug.visible, 0);
  assert.ok(res.models.debug.versions.includes('99.0.0'), 'the newest-client version was tried (the earlier test already made it the default)');
  assert.ok(res.errors.some((e) => e.kind === 'models' && /未列出/.test(e.message)));
  // Nothing visible: the OpenAI-style list still shows what exists, instead of nothing.
  assert.deepEqual((await api('/models', key)).json().data.map((m) => m.id), ['codex-auto-review']);

  const added = await post('/api/chat/codex/models/custom', { models: 'gpt-5-codex, gpt-5.1-codex  gpt-5-codex' });
  assert.equal(added.status, 200, added.text);
  assert.deepEqual(added.json().customModels, ['gpt-5-codex', 'gpt-5.1-codex']);
  assert.deepEqual((await api('/models', key)).json().data.map((m) => m.id), ['gpt-5-codex', 'gpt-5.1-codex'], 'hand-added ids are listed');
  assert.equal((await api('/models/gpt-5.1-codex', key)).status, 200);
  assert.equal((await post('/api/chat/codex/models/custom', { models: 'bad id!' })).status, 400);
  assert.equal((await post('/api/chat/codex/models/custom', { models: 'x' }, USER)).status, 403);
  // They survive a disconnect (the login goes, the settings stay) and an empty list clears them.
  await post('/api/chat/codex/disconnect');
  assert.deepEqual((await status()).customModels, ['gpt-5-codex', 'gpt-5.1-codex']);
  assert.deepEqual((await post('/api/chat/codex/models/custom', { models: '' })).json().customModels, []);
});

test('model lists are read however the backend wraps them', () => {
  assert.deepEqual(parseModels({ models: [{ slug: 'a', display_name: 'A', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }, { slug: 'b', visibility: 'hide' }] }).items.map((m) => [m.id, m.visible]), [['a', true], ['b', false]]);
  assert.deepEqual(parseModels({ data: [{ id: 'x' }, { id: 'x' }, { model: 'y' }] }).items.map((m) => m.id), ['x', 'y']);
  assert.deepEqual(parseModels([{ name: 'n1' }, 'plain']).items.map((m) => m.id), ['n1', 'plain']);
  assert.deepEqual(parseModels({}).items, []);
  assert.equal(parseModels({ models: [{ slug: 'a' }] }).items[0].visible, true, 'no visibility means shown');
});


// ---------- Codex 转发 as an API account of 模型对话 / 模型检测 ----------

const ndjson = (text) => text.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type !== 'ping');
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const CHAT_CONV = '8f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const lastResponses = () => fx.backendCalls.filter((c) => c.path.endsWith('/responses')).at(-1);

test('admins see Codex 转发 among their APIs (once logged in), everyone else does not', async () => {
  await login();
  const models = await post('/api/chat/models', { accountId: 'codex' });
  assert.equal(models.status, 200, models.text);
  assert.deepEqual(models.json().models, ['gpt-5-codex'], 'visible models only');
  const mine = (await get('/api/chat/accounts')).json().accounts.find((a) => a.id === 'codex');
  assert.deepEqual({ name: mine.name, usable: mine.usable, codex: mine.codex, models: mine.models }, { name: 'Codex 转发', usable: true, codex: true, models: ['gpt-5-codex'] });
  assert.ok(!JSON.stringify(mine).match(/sk-|eyJ|rt-/), 'no secrets in the account view');
  assert.equal((await get('/api/chat/accounts', USER)).json().accounts.some((a) => a.id === 'codex'), false);
  assert.equal((await post('/api/chat/models', { accountId: 'codex' }, USER)).status, 403);
  await post('/api/chat/codex/disconnect');
  assert.equal((await get('/api/chat/accounts')).json().accounts.find((a) => a.id === 'codex').usable, false, 'not offered while logged out');
  const out = ndjson((await post('/api/chat/completions', { accountId: 'codex', model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.match(out.find((e) => e.type === 'error').message, /还没有登录/);
  await login();
});

test('模型对话 through Codex: Responses request without sampling params, streamed thinking and usage', async () => {
  fx.backendCalls.length = 0;
  const res = await post('/api/chat/completions', {
    accountId: 'codex', model: 'gpt-5-codex', effort: 'high', temperature: 0.7, maxTokens: 100, system: 'Be brief.',
    messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'look', images: [PNG_URL] }],
  });
  assert.equal(res.status, 200, res.text);
  const events = ndjson(res.text);
  assert.ok(!events.some((e) => e.type === 'error'), res.text);
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  assert.equal(events.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), 'Thinking');
  assert.deepEqual(events.filter((e) => e.type === 'usage').at(-1).usage, { input: 12, output: 5, reasoning: 2, cacheRead: 4 });
  assert.equal(events.at(-1).type, 'done');

  const sent = lastResponses();
  assert.equal(sent.headers['chatgpt-account-id'], ACCOUNT);
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.instructions, 'Be brief.');
  assert.equal(sent.body.temperature, undefined);
  assert.equal(sent.body.max_output_tokens, undefined);
  assert.deepEqual(sent.body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(sent.body.input.map((i) => i.role), ['user', 'assistant', 'user']);
  assert.deepEqual(sent.body.input[2].content.map((c) => c.type), ['input_text', 'input_image']);
  assert.equal(sent.body.tools, undefined, 'no tools unless file tools are on');
  // Usage lands on the 用量统计 page under Codex 转发.
  const usageRows = (await get('/api/chat/usage?days=1')).json();
  assert.ok(usageRows.rows.some((r) => r.accountId === 'codex' && r.kind === 'chat' && r.model === 'gpt-5-codex'));
  assert.equal(usageRows.names.codex, 'Codex 转发');
});

test('模型对话 through Codex: file tools work and the tool results go back as Responses items', async () => {
  fx.backendCalls.length = 0;
  const res = await post('/api/chat/completions', { accountId: 'codex', model: 'gpt-files', conversationId: CHAT_CONV, fileTools: true, messages: [{ role: 'user', content: 'write a note' }] });
  const events = ndjson(res.text);
  assert.ok(!events.some((e) => e.type === 'error'), res.text);
  assert.equal(events.find((e) => e.type === 'file')?.file.path, 'note.txt');
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'done' && e.label === '写入 note.txt'));
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  const calls = fx.backendCalls.filter((c) => c.path.endsWith('/responses'));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.tools.some((t) => t.name === 'write_file' && t.type === 'function'));
  const second = calls[1].body.input;
  assert.deepEqual(second.at(-2), { type: 'function_call', call_id: 'call_9', name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'hi' }) });
  assert.equal(second.at(-1).type, 'function_call_output');
  assert.equal(second.at(-1).call_id, 'call_9');
  await post('/api/chat/files/clear', { conversationId: CHAT_CONV });
});

test('模型对话 through Codex: busy backend is retried, a used-up plan is not', async () => {
  fx.busyCalls = 0;
  const busy = ndjson((await post('/api/chat/completions', { accountId: 'codex', model: 'gpt-busy', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.ok(busy.some((e) => e.type === 'notice' && e.transient && /上游繁忙/.test(e.message)));
  assert.equal(busy.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  assert.ok(!busy.some((e) => e.type === 'error'));

  fx.backendCalls.length = 0;
  const limited = ndjson((await post('/api/chat/completions', { accountId: 'codex', model: 'gpt-limit', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.match(limited.find((e) => e.type === 'error').message, /usage limit.*订阅的用量限制/);
  assert.equal(fx.backendCalls.filter((c) => c.path.endsWith('/responses')).length, 1, 'not retried');
  const rejected = ndjson((await post('/api/chat/completions', { accountId: 'codex', model: 'gpt-bad', effort: 'max', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.match(rejected.find((e) => e.type === 'error').message, /Unsupported model.*思考强度：最高/);
});

test('Codex 转发 is refused where it makes no sense, and for non-admins', async () => {
  const body = { accountId: 'codex', model: 'gpt-5-codex', prompt: 'a cat' };
  const image = await post('/api/chat/images', body);
  assert.equal(image.status, 400);
  assert.match(image.json().error, /不支持图片生成/);
  const relay = await post('/api/chat/relays', { accountId: 'codex' });
  assert.equal(relay.status, 400);
  assert.match(relay.json().error, /本身就是一个 API/);
  const denied = ndjson((await post('/api/chat/completions', { accountId: 'codex', model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }] }, USER)).text);
  assert.match(denied.find((e) => e.type === 'error').message, /只有管理员/);
});

test('模型检测 / 鹈鹕测试 calls go through the Codex backend as single-turn Responses requests', async () => {
  const calls = [];
  const events = (list) => Object.assign(Readable.from([Buffer.from(list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))]), { statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
  const conn = { codex: { backend: async (route, opts) => { calls.push({ route, body: JSON.parse(opts.body), headers: opts.headers }); return events(textStream); } }, bill: null };
  const r = await completeOnce(conn, { format: 'openai', model: 'gpt-5-codex', prompt: 'probe', temperature: 0.4, chatMaxTokens: 100 });
  assert.equal(r.text, 'Hello');
  assert.deepEqual(r.usage, { input: 12, output: 5, reasoning: 2, cacheRead: 4 });
  assert.equal(calls[0].route, '/responses');
  assert.deepEqual(calls[0].body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'probe' }] }]);
  assert.equal(calls[0].body.temperature, undefined);
  assert.equal(calls[0].body.max_tokens, undefined);
  assert.equal(calls[0].body.store, false);
  assert.ok(calls[0].body.instructions);
  // A failure inside the stream is reported, not swallowed.
  const broken = { codex: { backend: async () => events([{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }]) } };
  await assert.rejects(completeOnce(broken, { format: 'openai', model: 'm', prompt: 'p' }), /model overloaded/);
});
