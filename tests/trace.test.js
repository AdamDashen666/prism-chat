// ModelTrace page: runner (independent agents), routes, grant billing, bank auto-update.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatServer } from '../src/server.js';
import { createVaultClient } from '../src/vault.js';
import { safeLookup } from '../src/net.js';
import { createTraceBank, validateBank, selfTest } from '../src/trace/bank.js';
import { generateChallenges, minimumNumbers } from '../src/trace/challenges.js';
import { analyzeGlobalOutputs, parseNumbers } from '../src/trace/fingerprint-core.js';
import { PELICAN_PROMPT, createPelicanStore, extractHtml } from '../src/trace/pelican.js';

const PELICAN_HTML = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Pelican</title></head><body>'
  + '<svg viewBox="0 0 400 300"><g id="bike"><circle cx="100" cy="220" r="40"/><animateTransform attributeName="transform" type="rotate" from="0 100 220" to="360 100 220" dur="1s" repeatCount="indefinite"/></g></svg>'
  + '</body></html>';

const ORIGIN = 'https://qiuzhang.xyz';
const HOST = 'trace.upstream.example';
const SESSION = '__Host-PrismVault=owner-session';
const KEY = 'sk-trace-owner';
const MANUAL_KEY = 'sk-manual-typed';
const BRIDGE = 'bridge-secret-for-trace-tests-0123456789';
const BUNDLED = fileURLToPath(new URL('../data/modeltrace/', import.meta.url));
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures-trace.json', import.meta.url), 'utf8'));
const OPUS = FIX['claude-opus-5-5'];

let tmp, agent, upstream, upstreamPort, vault, vaultPort, chat, chatPort, pelicanStore;
const calls = [];
const bridgeLog = [];
let answerIndex = 0;

function openssl() {
  for (const c of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']) { try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ } }
  throw new Error('openssl is required for tests');
}

// Upstream behaves per model name:
//  opus     -> streams real claude-opus-5-5 reference outputs
//  short    -> first answer too short, later ones fine
//  flaky    -> 503 on the first call
//  claude-* on /v1/messages only (chat/completions 404) -> Anthropic format
//  denied   -> 401
function startUpstream(key, cert) {
  return https.createServer({ key, cert }, async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'], body });
    const okKey = [`Bearer ${KEY}`, `Bearer ${MANUAL_KEY}`].includes(req.headers.authorization);
    if (!okKey) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"invalid api key"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"opus"},{"id":"gpt-x"}]}'); }
    const next = () => OPUS[answerIndex++ % OPUS.length].text;
    if (body.messages?.[0]?.content === PELICAN_PROMPT) {
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ content: [{ type: 'text', text: '```html\n' + PELICAN_HTML + '\n```' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 700 } }));
      }
      if (body.model === 'anthropic-only') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"not found"}}'); }
      if (body.model === 'denied') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"model not allowed"}}'); }
      if (body.model === 'capped' && body.max_tokens > 8192) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"max_tokens: 32000 > 8192, which is the maximum allowed"}}'); }
      const answer = `好的，下面是完整代码：\n\n\`\`\`html\n${PELICAN_HTML}\n\`\`\`\n直接用浏览器打开即可。`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of answer.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 650 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.url === '/v1/messages') {
      if (body.model === 'anthropic-sse') {
        // Real Anthropic streaming shape (what `stream: true` gets from api.anthropic.com).
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { usage: { input_tokens: 50, output_tokens: 1 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (const part of next().match(/[\s\S]{1,60}/g)) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
        ev('ping', {});
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900 } });
        ev('message_stop', {});
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content: [{ type: 'text', text: next() }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 900 } }));
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    if (body.model === 'anthropic-only') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"not found"}}'); }
    if (body.model === 'denied') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"model not allowed"}}'); }
    if (body.model === 'flaky' && !calls.some((c) => c.flaked)) { calls.at(-1).flaked = true; res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"busy"}}'); }
    let text = next();
    if (body.model === 'short' && !calls.some((c) => c.shorted)) { calls.at(-1).shorted = true; text = '12, 44, 300'; }
    if (body.model === 'slow') await new Promise((r) => setTimeout(r, 3000));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of text.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 800 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function startVault() {
  return http.createServer(async (req, res) => {
    const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(d === undefined ? '' : JSON.stringify(d)); };
    const url = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie || '';
    if (url.pathname.startsWith('/api/internal/chat/')) {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      bridgeLog.push({ path: url.pathname, body });
      if (req.headers['x-chat-bridge'] !== BRIDGE) return send(403, { error: 'forbidden' });
      if (url.pathname.endsWith('/report')) return send(204);
      if (body.grantId !== 'gtrace' || body.userId !== 'u1') return send(404, { error: '授权不存在或已被收回。' });
      const acquires = bridgeLog.filter((x) => x.path.endsWith('/acquire')).length;
      if (acquires > 4) return send(403, { error: '今日次数已用完' });
      return send(200, { accountId: 'owner-acc', baseUrl: `https://${HOST}:${upstreamPort}/v1`, protocolProfileId: 'openai', customProtocolProfile: null, models: ['opus'], allowedModels: [], apiKey: KEY });
    }
    const admin = cookie.includes('admin-session');
    if (!cookie.includes('owner-session') && !admin) return send(401);
    if (url.pathname === '/api/auth/me') return send(200, { id: 'u1', userName: admin ? 'Boss' : 'Alice', mustChangePassword: false, isAdmin: admin });
    if (url.pathname === '/api/auth/csrf') return send(200, { token: 't' });
    if (url.pathname === '/api/chat/grants') return send(200, { grants: [{ id: 'gtrace', label: '借用', allowedModels: [], usage: {}, blockedReason: null }] });
    if (url.pathname === '/api/accounts') return send(200, { items: [{ id: 'acc1', displayName: 'Relay', baseUrl: `https://${HOST}:${upstreamPort}/v1`, models: ['opus'], hasApiKey: true, isEnabled: true }], total: 1, page: 1, pageSize: 24 });
    if (url.pathname === '/api/accounts/acc1') return send(200, { id: 'acc1', baseUrl: `https://${HOST}:${upstreamPort}/v1`, models: ['opus'], hasApiKey: true, protocolProfileId: 'openai' });
    if (url.pathname === '/api/accounts/acc1/key') return send(200, { value: KEY });
    return send(404);
  });
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const lookup = (hostname, options, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (hostname === HOST) return options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  return safeLookup(hostname, options, cb);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-trace-'));
  const keyFile = path.join(tmp, 'key.pem');
  const certFile = path.join(tmp, 'cert.pem');
  execFileSync(openssl(), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  const cert = fs.readFileSync(certFile);
  upstream = startUpstream(fs.readFileSync(keyFile), cert);
  upstreamPort = await listen(upstream);
  vault = startVault();
  vaultPort = await listen(vault);
  agent = new https.Agent({ ca: cert });
  chat = createChatServer({
    vault: createVaultClient({ port: vaultPort, bridgeSecret: BRIDGE }), origin: ORIGIN, lookup, agent,
    csrfKey: Buffer.alloc(32, 2), jobDir: path.join(tmp, 'jobs'),
    traceBank: createTraceBank({ dir: path.join(tmp, 'bank'), fetchBuffer: async () => { throw new Error('offline'); }, log: () => {} }),
    pelicanStore: pelicanStore = createPelicanStore({ dir: path.join(tmp, 'pelican'), lookup, agent, perHour: 100 }),
  });
  chatPort = await listen(chat);
});

after(() => {
  pelicanStore?.close();
  chat?.closeAllConnections?.(); chat?.close(); upstream?.close(); vault?.close(); agent?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method, route, { cookie = SESSION, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: chatPort, method, path: route, headers: {
      cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
async function post(route, body, cookie = SESSION) {
  const csrf = (await request('GET', '/api/chat/session', { cookie })).json.csrf;
  return request('POST', route, { cookie, body, headers: { origin: ORIGIN, 'x-chat-csrf': csrf } });
}
async function runToEnd(body, cookie = SESSION) {
  const started = await post('/api/chat/trace/runs', body, cookie);
  assert.equal(started.status, 202, started.text);
  const events = [];
  for (let i = 0; i < 40; i++) {
    const r = await request('GET', `/api/chat/trace/runs/${started.json.runId}/events?after=${events.length}`, { cookie });
    assert.equal(r.status, 200, r.text);
    events.push(...r.json.events);
    if (r.json.status !== 'running' && events.some((e) => e.type === 'done')) return { runId: started.json.runId, status: r.json.status, events };
  }
  throw new Error('run did not finish');
}

test('bundled bank is valid and the JS port reproduces upstream accuracy on reference outputs', () => {
  const bank = validateBank(JSON.parse(fs.readFileSync(path.join(BUNDLED, 'unified_bank.json'), 'utf8')));
  assert.ok(bank.models.length >= 17);
  assert.ok(selfTest(bank, JSON.parse(fs.readFileSync(path.join(BUNDLED, 'selftest.json'), 'utf8'))) >= 2);
  for (const [model, outputs] of Object.entries(FIX)) {
    const r = analyzeGlobalOutputs(outputs.slice(3, 6).map((o) => ({ text: o.text, expected_count: o.expected })), bank);
    assert.equal(r.prediction, model);
  }
});

test('challenges match ModelTrace: unique lengths 292..332, no tools, numbers parse', () => {
  const list = generateChallenges(6);
  const lengths = list.map((c) => c.expected_count);
  assert.equal(new Set(lengths).size, 6);
  for (const c of list) {
    assert.ok(c.expected_count >= 292 && c.expected_count <= 332);
    assert.match(c.prompt, new RegExp(`${c.expected_count} 个 1 到 355`));
    assert.match(c.prompt, /禁止调用或借助任何工具/);
  }
  assert.equal(minimumNumbers(300), 165);
  assert.deepEqual(parseNumbers('答案：12, 400, 7 abc 1 2'), [12, 7]);
});

test('saved API: three independent single-turn agents, attributed to the right model', async () => {
  calls.length = 0;
  const r = await runToEnd({ source: 'saved', accountId: 'acc1', model: 'opus' });
  assert.equal(r.status, 'done', JSON.stringify(r.events.filter((e) => e.type === 'error')));
  const probes = calls.filter((c) => c.path === '/v1/chat/completions');
  assert.equal(probes.length, 3);
  // Each agent: own fresh prompt, no shared history, no system prompt.
  for (const p of probes) {
    assert.equal(p.body.messages.length, 1);
    assert.equal(p.body.messages[0].role, 'user');
    assert.equal(p.auth, `Bearer ${KEY}`);
  }
  assert.equal(new Set(probes.map((p) => p.body.messages[0].content)).size, 3);
  const result = r.events.find((e) => e.type === 'result').result;
  assert.equal(result.prediction, 'claude-opus-5-5');
  assert.equal(result.usedOutputs, 3);
  assert.ok(result.probability > 0.5);
  assert.equal(r.events.filter((e) => e.type === 'agent' && e.state === 'done').length, 3);
  assert.ok(!JSON.stringify(r.events).includes(KEY), 'key never appears in events');
});

test('an unusable answer gets a brand-new prompt; transient 503 is retried', async () => {
  calls.length = 0;
  const r = await runToEnd({ source: 'saved', accountId: 'acc1', model: 'short' });
  assert.equal(r.status, 'done');
  const invalid = r.events.find((e) => e.type === 'agent' && e.state === 'invalid');
  assert.ok(invalid, 'short answer flagged');
  const agentCalls = r.events.filter((e) => e.type === 'agent' && e.index === invalid.index && e.state === 'working');
  assert.equal(agentCalls.length, 2);
  assert.notEqual(agentCalls[0].expected, agentCalls[1].expected, 'replacement uses a different prompt');
  calls.length = 0;
  const f = await runToEnd({ source: 'saved', accountId: 'acc1', model: 'flaky' });
  assert.equal(f.status, 'done');
  assert.ok(f.events.some((e) => e.type === 'agent' && e.state === 'error' && /503/.test(e.message)));
  assert.equal(f.events.find((e) => e.type === 'result').result.usedOutputs, 3);
});

test('manual API: typed key is used for the run only, falls back to Anthropic Messages', async () => {
  calls.length = 0;
  const r = await runToEnd({ source: 'manual', baseUrl: `https://${HOST}:${upstreamPort}/v1`, apiKey: MANUAL_KEY, model: 'anthropic-only' });
  assert.equal(r.status, 'done', JSON.stringify(r.events.filter((e) => e.type !== 'agent')));
  const messages = calls.filter((c) => c.path === '/v1/messages');
  assert.equal(messages.length, 3);
  assert.equal(messages[0].xkey, MANUAL_KEY);
  assert.equal(messages[0].body.max_tokens, 4096);
  assert.ok(!JSON.stringify(r.events).includes(MANUAL_KEY));
  const listed = await post('/api/chat/trace/models', { baseUrl: `https://${HOST}:${upstreamPort}/v1`, apiKey: MANUAL_KEY });
  assert.deepEqual(listed.json.models, ['gpt-x', 'opus']);
  // Anthropic requests are streamed so Cloudflare-fronted relays do not cut them (524).
  assert.equal(messages[0].body.stream, true);
  calls.length = 0;
  const sse = await runToEnd({ source: 'manual', baseUrl: `https://${HOST}:${upstreamPort}/v1`, apiKey: MANUAL_KEY, model: 'anthropic-sse', apiFormat: 'anthropic' });
  assert.equal(sse.status, 'done', JSON.stringify(sse.events.filter((e) => e.type !== 'agent')));
  assert.equal(sse.events.find((e) => e.type === 'result').result.prediction, 'claude-opus-5-5');
});

test('manual API rejects private addresses and missing keys', async () => {
  const local = await post('/api/chat/trace/runs', { source: 'manual', baseUrl: 'https://127.0.0.1/v1', apiKey: 'k', model: 'm' });
  assert.equal(local.status, 400);
  const plain = await post('/api/chat/trace/runs', { source: 'manual', baseUrl: 'http://api.example.com/v1', apiKey: 'k', model: 'm' });
  assert.equal(plain.status, 400);
  const nokey = await post('/api/chat/trace/runs', { source: 'manual', baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' });
  assert.equal(nokey.status, 400);
});

test('fatal upstream errors stop all agents quickly', async () => {
  calls.length = 0;
  const r = await runToEnd({ source: 'saved', accountId: 'acc1', model: 'denied' });
  assert.equal(r.status, 'failed');
  assert.match(r.events.find((e) => e.type === 'error').message, /model not allowed/);
  assert.ok(calls.filter((c) => c.path === '/v1/chat/completions').length <= 3);
});

test('admin grant: each probe is acquired and billed separately through the bridge', async () => {
  bridgeLog.length = 0;
  const r = await runToEnd({ source: 'saved', accountId: 'g_gtrace', model: 'opus' });
  assert.equal(r.status, 'done', JSON.stringify(r.events.filter((e) => e.type !== 'agent')));
  const acquires = bridgeLog.filter((x) => x.path.endsWith('/acquire'));
  assert.equal(acquires.length, 3);
  for (const a of acquires) assert.deepEqual(a.body, { grantId: 'gtrace', userId: 'u1', kind: 'chat', model: 'opus' });
  for (let i = 0; i < 20 && bridgeLog.filter((x) => x.path.endsWith('/report')).length < 3; i++) await new Promise((res) => setTimeout(res, 50));
  const reports = bridgeLog.filter((x) => x.path.endsWith('/report'));
  assert.equal(reports.length, 3);
  for (const rep of reports) { assert.equal(rep.body.status, 'completed'); assert.equal(rep.body.outputTokens, 800); }
  // Quota runs out mid-run (fake Vault allows 4 acquires in total): run fails with the quota message, nothing more billed.
  const again = await runToEnd({ source: 'saved', accountId: 'g_gtrace', model: 'opus' });
  assert.ok(again.events.some((e) => e.type === 'agent' && /今日次数已用完/.test(e.message || '')));
});

test('runs are private, need CSRF, one at a time per user, and can be cancelled', async () => {
  const noCsrf = await request('POST', '/api/chat/trace/runs', { body: { source: 'saved', accountId: 'acc1', model: 'opus' }, headers: { origin: ORIGIN } });
  assert.equal(noCsrf.status, 403);
  const started = await post('/api/chat/trace/runs', { source: 'saved', accountId: 'acc1', model: 'slow' });
  assert.equal(started.status, 202);
  const second = await post('/api/chat/trace/runs', { source: 'saved', accountId: 'acc1', model: 'slow' });
  assert.equal(second.status, 429);
  const other = await request('GET', `/api/chat/trace/runs/${started.json.runId}/events`, { cookie: '__Host-PrismVault=admin-session' });
  assert.equal(other.status, 200, 'same user id in fake vault');
  const stranger = await request('GET', `/api/chat/trace/runs/${crypto.randomUUID()}/events`);
  assert.equal(stranger.status, 404);
  const cancel = await post(`/api/chat/trace/runs/${started.json.runId}/cancel`, {});
  assert.equal(cancel.status, 200);
  let status = 'running';
  for (let i = 0; i < 20 && status === 'running'; i++) {
    status = (await request('GET', `/api/chat/trace/runs/${started.json.runId}/events`)).json.status;
    if (status === 'running') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status, 'stopped');
});

test('page, assets and bank info are served; manual bank check is admin-only', async () => {
  const page = await request('GET', '/chat/trace');
  assert.equal(page.status, 200);
  assert.match(page.text, /模型检测/);
  assert.equal((await request('GET', '/chat/trace.js')).status, 200);
  assert.equal((await request('GET', '/chat/trace', { cookie: '' })).status, 401);
  const bank = await request('GET', '/api/chat/trace/bank');
  assert.equal(bank.status, 200);
  assert.ok(bank.json.modelCount >= 17);
  assert.equal(bank.json.canCheck, false);
  assert.equal(bank.json.update.lastError, undefined, 'errors hidden from non-admins');
  assert.equal((await post('/api/chat/trace/bank/check', {})).status, 403);
  const admin = await post('/api/chat/trace/bank/check', {}, '__Host-PrismVault=admin-session');
  assert.equal(admin.status, 200);
  assert.equal(admin.json.update.lastResult, 'error');
  assert.match(admin.json.update.lastError, /offline/);
});

// ---------- pelican test ----------
async function pelicanToEnd(body, cookie = SESSION) {
  const started = await post('/api/chat/trace/pelican', body, cookie);
  assert.equal(started.status, 202, started.text);
  let job = started.json;
  for (let i = 0; i < 40 && job.status === 'running'; i++) {
    const r = await request('GET', `/api/chat/trace/pelican/${job.id}?version=${job.version}`, { cookie });
    assert.equal(r.status, 200, r.text);
    job = r.json;
  }
  return job;
}

test('extractHtml: fenced blocks, bare documents and raw SVG', () => {
  const fenced = extractHtml(`说明\n\`\`\`css\nbody{}\n\`\`\`\n\`\`\`html\n${PELICAN_HTML}\n\`\`\``);
  assert.equal(fenced.html, PELICAN_HTML);
  assert.deepEqual(fenced.checks, { svg: true, animation: true, complete: true, document: true });
  assert.equal(extractHtml(`这是代码 ${PELICAN_HTML} 结束`).html, PELICAN_HTML);
  const svg = extractHtml('<svg><circle r="3"/></svg>');
  assert.match(svg.html, /^<!DOCTYPE html>[\s\S]*<svg><circle r="3"\/><\/svg>[\s\S]*<\/html>$/);
  assert.equal(svg.checks.animation, false);
  const cut = extractHtml('```html\n<!DOCTYPE html><html><body><svg><g>');
  assert.equal(cut.checks.complete, false);
});

test('pelican: fixed prompt, one-time download, file deleted right after', async () => {
  calls.length = 0;
  const job = await pelicanToEnd({ source: 'saved', accountId: 'acc1', model: 'claude-x' });
  assert.equal(job.status, 'done', job.error);
  const probe = calls.filter((c) => c.path === '/v1/chat/completions');
  assert.equal(probe.length, 1);
  assert.deepEqual(probe[0].body.messages, [{ role: 'user', content: PELICAN_PROMPT }]);
  assert.equal(probe[0].body.max_tokens, 32000, 'non-OpenAI models get a large output budget');
  assert.equal(job.file, 'ready');
  assert.equal(job.checks.svg, true);
  assert.equal(job.checks.animation, true);
  assert.equal(job.checks.truncated, false);
  assert.ok(job.expiresAt - job.generatedAt === 5 * 60 * 1000);
  const file = path.join(tmp, 'pelican', `${job.id}.html`);
  assert.ok(fs.existsSync(file));
  // Another user cannot fetch it.
  const stranger = await request('GET', `/api/chat/trace/pelican/${job.id}/download`, { cookie: '__Host-PrismVault=nobody' });
  assert.equal(stranger.status, 401);
  const dl = await request('GET', `/api/chat/trace/pelican/${job.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.text, PELICAN_HTML);
  assert.match(dl.headers['content-disposition'], /attachment; filename="pelican-claude-x-\d{8}T\d{6}\.html"/);
  assert.equal(dl.headers['content-type'], 'application/octet-stream');
  assert.match(dl.headers['content-security-policy'], /sandbox/);
  for (let i = 0; i < 20 && fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(!fs.existsSync(file), 'deleted after download');
  const again = await request('GET', `/api/chat/trace/pelican/${job.id}/download`);
  assert.equal(again.status, 410);
  assert.equal((await request('GET', `/api/chat/trace/pelican/${job.id}`)).json.file, 'downloaded');
  assert.ok(!JSON.stringify(job).includes(KEY));
});

test('pelican: manual key + Anthropic fallback; capped max_tokens is lowered; grants billed', async () => {
  calls.length = 0;
  const manual = await pelicanToEnd({ source: 'manual', baseUrl: `https://${HOST}:${upstreamPort}/v1`, apiKey: MANUAL_KEY, model: 'anthropic-only' });
  assert.equal(manual.status, 'done', manual.error);
  const msg = calls.find((c) => c.path === '/v1/messages');
  assert.equal(msg.xkey, MANUAL_KEY);
  assert.equal(msg.body.max_tokens, 32000);
  calls.length = 0;
  const capped = await pelicanToEnd({ source: 'saved', accountId: 'acc1', model: 'capped' });
  assert.equal(capped.status, 'done', capped.error);
  assert.deepEqual(calls.filter((c) => c.path === '/v1/chat/completions').map((c) => c.body.max_tokens), [32000, 8192]);
  calls.length = 0;
  const gpt = await pelicanToEnd({ source: 'saved', accountId: 'acc1', model: 'gpt-x' });
  assert.equal(gpt.status, 'done');
  assert.equal(calls[0].body.max_tokens, undefined, 'OpenAI models are unlimited when omitted');
  bridgeLog.length = 0;
  const grant = await pelicanToEnd({ source: 'saved', accountId: 'g_gtrace', model: 'opus' });
  assert.equal(grant.status, 'done', grant.error);
  for (let i = 0; i < 20 && !bridgeLog.some((x) => x.path.endsWith('/report')); i++) await new Promise((r) => setTimeout(r, 50));
  const report = bridgeLog.find((x) => x.path.endsWith('/report'));
  assert.equal(report.body.status, 'completed');
  assert.equal(report.body.outputTokens, 650);
  const denied = await pelicanToEnd({ source: 'saved', accountId: 'acc1', model: 'denied' });
  assert.equal(denied.status, 'failed');
  assert.match(denied.error, /model not allowed/);
  assert.equal(denied.file, '');
});

test('pelican: undownloaded files expire on their own', async () => {
  const dir = path.join(tmp, 'pelican-ttl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stale.html'), 'old'); // left over from a previous process
  const store = createPelicanStore({ dir, lookup, agent, ttlMs: 300 });
  assert.ok(!fs.existsSync(path.join(dir, 'stale.html')), 'leftovers removed on start');
  const job = store.start({ userId: 'u9', model: 'claude-x', apiFormat: 'auto', connect: async () => ({ baseUrl: `https://${HOST}:${upstreamPort}/v1`, header: ['Authorization', `Bearer ${KEY}`] }) });
  for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.status, 'done', job.error);
  assert.equal(fs.readdirSync(dir).length, 1);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(store.view(job).file, 'expired');
  assert.equal(store.take(job), null);
  store.close();
});

// ---------- bank auto-update ----------
function fakeGithub(files) {
  const hits = [];
  return {
    hits,
    fetchBuffer: async (url) => {
      hits.push(url);
      if (url.endsWith('/commits/main')) return Buffer.from(files.sha);
      if (/\/commits\/[0-9a-f]{40}$/.test(url)) return Buffer.from(JSON.stringify({ commit: { committer: { date: files.date }, message: 'new models' } }));
      const m = /raw\.githubusercontent\.com\/xqy2006\/ModelTrace\/[0-9a-f]{40}\/(.+)$/.exec(url);
      if (m && files[m[1]] !== undefined) return Buffer.from(files[m[1]]);
      throw new Error(`unexpected ${url}`);
    },
  };
}

function bankWithNewModel() {
  const bank = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'unified_bank.json'), 'utf8'));
  const src = bank.models.find((m) => m.id === 'gpt-5.4');
  const index = bank.models.indexOf(src);
  bank.models.push({ ...src, id: 'gpt-7-test', display_name: 'gpt-7-test' });
  bank.robust.hellinger.centroids.push(bank.robust.hellinger.centroids[index].map((v) => v * 0.2));
  bank.robust.ordered_blocks.centroids.push(bank.robust.ordered_blocks.centroids[index].map((v) => v * 0.2));
  for (const env of bank.robust.ordered_blocks.environment_centroids) env.push(env[index].map((v) => v * 0.2));
  return bank;
}

test('auto-update: new valid bank from GitHub replaces the active one and survives restart', async () => {
  const dir = path.join(tmp, 'upd1');
  const source = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'source.json'), 'utf8'));
  const gh = fakeGithub({ sha: 'a'.repeat(40), date: '2099-01-01T00:00:00Z', 'data/unified_bank.json': JSON.stringify(bankWithNewModel()) });
  const tb = createTraceBank({ dir, fetchBuffer: gh.fetchBuffer, log: () => {} });
  const before = tb.current().summary.modelCount;
  const status = await tb.check();
  assert.equal(status.lastResult, 'updated', status.lastError);
  assert.deepEqual(status.lastAdded, ['gpt-7-test']);
  assert.equal(tb.current().summary.modelCount, before + 1);
  assert.equal(tb.current().summary.source.sha, 'a'.repeat(40));
  // algorithm files were missing upstream in the fake -> flagged, not executed
  assert.deepEqual(status.algorithmChanged.sort(), Object.keys(source.algorithm).sort());
  const reloaded = createTraceBank({ dir, fetchBuffer: gh.fetchBuffer, log: () => {} });
  assert.equal(reloaded.current().origin, 'github');
  assert.equal(reloaded.current().summary.modelCount, before + 1);
  assert.equal(reloaded.status().lastResult, 'updated');
  // second check: same sha -> nothing downloaded
  gh.hits.length = 0;
  assert.equal((await reloaded.check()).lastResult, 'current');
  assert.equal(gh.hits.length, 1);
});

test('auto-update: broken or self-test-failing banks are rejected and the old bank stays', async () => {
  const dir = path.join(tmp, 'upd2');
  const bad = createTraceBank({ dir, log: () => {}, fetchBuffer: fakeGithub({ sha: 'b'.repeat(40), date: '2099-01-01T00:00:00Z', 'data/unified_bank.json': '{"schema":"other"}' }).fetchBuffer });
  const s1 = await bad.check();
  assert.equal(s1.lastResult, 'error');
  assert.match(s1.lastError, /格式不兼容/);
  assert.equal(bad.current().origin, 'bundled');
  // Valid shape but scrambled centroids -> self-test on real outputs fails.
  const scrambled = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'unified_bank.json'), 'utf8'));
  scrambled.robust.hellinger.centroids.reverse();
  scrambled.robust.ordered_blocks.centroids.reverse();
  for (const env of scrambled.robust.ordered_blocks.environment_centroids) env.reverse();
  const wrong = createTraceBank({ dir, log: () => {}, fetchBuffer: fakeGithub({ sha: 'c'.repeat(40), date: '2099-01-01T00:00:00Z', 'data/unified_bank.json': JSON.stringify(scrambled) }).fetchBuffer });
  const s2 = await wrong.check();
  assert.equal(s2.lastResult, 'error');
  assert.match(s2.lastError, /自检失败/);
  assert.equal(wrong.current().origin, 'bundled');
  assert.ok(!fs.existsSync(path.join(dir, 'unified_bank.json')));
});

test('auto-update: a newer commit with identical fingerprints is treated as current', async () => {
  const dir = path.join(tmp, 'upd3');
  const raw = fs.readFileSync(path.join(BUNDLED, 'unified_bank.json'));
  const source = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'source.json'), 'utf8'));
  const files = { sha: 'd'.repeat(40), date: '2099-01-01T00:00:00Z', 'data/unified_bank.json': raw };
  // Unchanged algorithm files upstream -> no drift flagged.
  const repo = fileURLToPath(new URL('../../.scratch/mt/ModelTrace/', import.meta.url));
  if (fs.existsSync(repo)) for (const f of Object.keys(source.algorithm)) files[f] = execFileSync('git', ['-C', repo, 'cat-file', 'blob', `HEAD:${f}`]);
  const tb = createTraceBank({ dir, log: () => {}, fetchBuffer: fakeGithub(files).fetchBuffer });
  const s = await tb.check();
  assert.equal(s.lastResult, 'current', s.lastError);
  assert.equal(tb.current().summary.source.sha, 'd'.repeat(40));
  if (fs.existsSync(repo)) assert.deepEqual(s.algorithmChanged, []);
});
