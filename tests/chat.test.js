import { test, before, after } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createChatServer } from '../src/server.js';
import { createVaultClient, mergeCookies } from '../src/vault.js';
import { isPublicIp, validateBaseUrl, safeLookup } from '../src/net.js';
import { allowedMaxTokens, buildPayload, imageRequest, inlineImageFilter, learnedCap, modelKinds, normalize, openaiUsage, sseEvents, thinkTagFilter } from '../src/upstream.js';
import { anthropicHeaders, anthropicMessagesUrl, anthropicStream } from '../src/anthropic.js';
import { createUsageStore, usageDay } from '../src/usage.js';
import { loadOrCreateKey } from '../src/util.js';
import { createFileStore, cleanPath } from '../src/files.js';
import { createRelayStore, relayTarget } from '../src/relay.js';

const ORIGIN = 'https://qiuzhang.xyz';
const HOST = 'api.upstream.example';
const SESSION = '__Host-PrismVault=owner-session';
const KEY = 'sk-test-secret-123';
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;
let upstream, upstreamPort, vaultServer, vaultPort, chat, chatPort, agent, tmp, testLookup;
const seen = [];
const bridgeLog = [];
const busyCount = new Map();
const FAST_RETRY = [5, 5, 5, 5];
const BRIDGE = 'bridge-secret-for-tests-0123456789abcdef';
// Grants as returned by Vault GET /api/chat/grants (UserGrantView).
const GRANTS = {
  gopen: { id: 'gopen', label: '借用 Relay', allowedModels: [], dailyRequests: 20, monthlyRequests: null, monthlyTokens: null, monthlyImages: 5, expiresAt: null,
    usage: { dayRequests: 3, monthRequests: 9, monthTokens: 100, monthImages: 1 }, blockedReason: null },
  gonly: { id: 'gonly', label: '只能用 gpt-test', allowedModels: ['gpt-test', 'plain'], dailyRequests: null, monthlyRequests: null, monthlyTokens: null, monthlyImages: null, expiresAt: null,
    usage: { dayRequests: 0, monthRequests: 0, monthTokens: 0, monthImages: 0 }, blockedReason: null },
  gdone: { id: 'gdone', label: '用完了', allowedModels: [], dailyRequests: 1, monthlyRequests: null, monthlyTokens: null, monthlyImages: null, expiresAt: null,
    usage: { dayRequests: 1, monthRequests: 1, monthTokens: 0, monthImages: 0 }, blockedReason: '今日次数已用完' },
};

function openssl() {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
  for (const c of candidates) { try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ } }
  throw new Error('openssl is required for tests');
}

// Fake Vault.Web: session auth, owner-scoped accounts, CSRF-guarded key read.
function startVault() {
  const accounts = {
    acc1: { id: 'acc1', displayName: 'Relay', baseUrl: `https://${HOST}:PORT/v1`, models: ['gpt-test', 'gpt-alt'], hasApiKey: true, isEnabled: true, protocolProfileId: 'openai' },
    nokey: { id: 'nokey', displayName: 'Empty', baseUrl: `https://${HOST}:PORT/v1`, models: [], hasApiKey: false, isEnabled: true },
    local: { id: 'local', displayName: 'Local', baseUrl: 'https://127.0.0.1/v1', models: [], hasApiKey: true, isEnabled: true },
    anth: { id: 'anth', displayName: 'Anthropic', baseUrl: `https://${HOST}:PORT/anthropic`, models: [], hasApiKey: true, isEnabled: true, protocolProfileId: 'openai' },
    anthMsg: { id: 'anthMsg', displayName: 'Anthropic endpoint', baseUrl: `https://${HOST}:PORT/anthropic/v1/messages`, models: [], hasApiKey: true, isEnabled: true, protocolProfileId: 'openai' },
  };
  return http.createServer(async (req, res) => {
    const cookie = req.headers.cookie || '';
    const send = (s, d, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(d === undefined ? '' : JSON.stringify(d)); };
    const url = new URL(req.url, 'http://x');
    // Bridge: no cookie, shared secret; mirrors ChatGrantService.AcquireAsync / ReportAsync.
    if (url.pathname.startsWith('/api/internal/chat/')) {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      bridgeLog.push({ path: url.pathname, cookie, body });
      if (req.headers['x-chat-bridge'] !== BRIDGE) return send(403, { error: 'forbidden' });
      if (url.pathname.endsWith('/report')) return send(204);
      const g = GRANTS[body.grantId];
      if (!g || body.userId !== 'owner1') return send(404, { error: '授权不存在或已被收回。' });
      if (g.blockedReason && body.kind !== 'models') return send(403, { error: g.blockedReason });
      if (body.kind !== 'models' && g.allowedModels.length && !g.allowedModels.includes(body.model)) return send(403, { error: '该授权不能使用这个模型。' });
      return send(200, { accountId: 'owner-acc', baseUrl: `https://${HOST}:${upstreamPort}/v1`, protocolProfileId: 'openai', customProtocolProfile: null,
        models: g.allowedModels.length ? g.allowedModels : ['gpt-test'], allowedModels: g.allowedModels, apiKey: KEY });
    }
    if (!cookie.includes('owner-session')) return send(401);
    if (url.pathname === '/api/chat/grants') return send(200, { grants: Object.values(GRANTS).map(({ allowedModels, ...g }) => ({ ...g, allowedModels })) });
    const fix = (a) => ({ ...a, baseUrl: a.baseUrl.replace('PORT', upstreamPort) });
    if (url.pathname === '/api/auth/me') return send(200, { id: 'owner1', userName: 'QiuZhang', mustChangePassword: false });
    if (url.pathname === '/api/auth/csrf') return send(200, { token: 'vault-csrf' }, { 'set-cookie': ['.AspNetCore.Antiforgery.x=af; path=/; httponly'] });
    if (url.pathname === '/api/accounts') return send(200, { items: Object.values(accounts).map(fix), total: 3, page: 1, pageSize: 24 });
    const m = url.pathname.match(/^\/api\/accounts\/([^/]+)(\/key)?$/);
    if (m && accounts[m[1]]) {
      if (!m[2] && req.method === 'GET') return send(200, fix(accounts[m[1]]));
      if (m[2] && req.method === 'POST') {
        if (req.headers['x-csrf-token'] !== 'vault-csrf' || !cookie.includes('.AspNetCore.Antiforgery.x=af')) return send(400, { error: 'csrf' });
        return send(200, { value: KEY });
      }
    }
    return send(404);
  });
}

function startUpstream(key, cert) {
  return https.createServer({ key, cert }, async (req, res) => {
    let body = '';
    for await (const c of req) body += c.toString('latin1');
    let json;
    try { json = body && String(req.headers['content-type']).includes('json') ? JSON.parse(Buffer.from(body, 'latin1').toString('utf8')) : undefined; } catch { json = undefined; }
    seen.push({ path: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: json });
    // Public file host: must never receive the API key.
    if (req.url.startsWith('/files/')) {
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(req.url === '/files/cat.png' ? PNG : '<html>not an image</html>');
    }
    // Anthropic-style API: x-api-key + anthropic-version only, Bearer keys rejected.
    if (req.url.startsWith('/anthropic/')) {
      const fail = (status, type, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type, message } })); };
      if (req.headers['x-api-key'] !== KEY) return fail(401, 'authentication_error', 'invalid x-api-key');
      if (!req.headers['anthropic-version']) return fail(400, 'invalid_request_error', 'anthropic-version: header is required');
      if (req.url === '/anthropic/v1/models?limit=1000') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-b' }, { type: 'model', id: 'claude-a' }], has_more: false }));
      }
      if (req.url !== '/anthropic/v1/messages') return fail(404, 'not_found_error', 'Not found');
      if (json.model === 'claude-old' && json.thinking?.type === 'adaptive') return fail(400, 'invalid_request_error', '"thinking.type.adaptive" is not supported for this model.');
      if (json.model === 'claude-notemp' && json.temperature !== undefined) return fail(400, 'invalid_request_error', 'temperature is deprecated for this model.');
      if (json.model === 'claude-64k' && json.max_tokens > 64000) return fail(400, 'invalid_request_error', `max_tokens: ${json.max_tokens} > 64000, which is the maximum allowed number of output tokens for claude-64k`);
      const sse = (list) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of list) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
      const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } };
      const textBlock = (index, text) => [
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index },
      ];
      const stopWith = (reason, output = 5) => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: output } }, { type: 'message_stop' }];
      const lastUser = json.messages.at(-1);
      // 529 Overloaded before anything streams, once per conversation text.
      if (json.model === 'claude-busy') {
        const key = JSON.stringify(json.messages[0]);
        busyCount.set(key, (busyCount.get(key) || 0) + 1);
        if (busyCount.get(key) === 1) return fail(529, 'overloaded_error', 'Overloaded');
        return sse([start, ...textBlock(0, 'calm now'), ...stopWith('end_turn')]);
      }
      // Overloaded in the middle of the stream; the continuation finishes the reply.
      if (json.model === 'claude-drop') {
        if (typeof lastUser.content === 'string' && lastUser.content.includes('中断')) return sse([start, ...textBlock(0, 'part two.'), ...stopWith('end_turn')]);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const e of [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part one, ' } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
        return res.end();
      }
      // A file tool round trip with thinking (the signed thinking block must come back unchanged).
      if (json.model === 'claude-tools') {
        if (!json.tools?.some((t) => t.name === 'write_file' && t.input_schema && t.eager_input_streaming)) return fail(400, 'invalid_request_error', 'expected tools');
        const results = Array.isArray(lastUser.content) ? lastUser.content.filter((b) => b.type === 'tool_result') : [];
        if (results.length) return sse([start, ...textBlock(0, `Saved: ${results[0].content}`), ...stopWith('end_turn')]);
        const input = JSON.stringify({ path: 'site/index.html', content: '<h1>你好</h1>' });
        return sse([start,
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'write it' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG1' } },
          { type: 'content_block_stop', index: 0 },
          ...textBlock(1, 'Writing the file.'),
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: input.slice(0, 15) } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: input.slice(15) } },
          { type: 'content_block_stop', index: 2 },
          ...stopWith('tool_use')]);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const think = json.thinking?.type === 'adaptive' || json.thinking?.type === 'enabled';
      const stream = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30, output_tokens: 1 } } },
        { type: 'ping' },
        ...(think ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQB' } },
          { type: 'content_block_stop', index: 0 },
        ] : []),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' there' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
        { type: 'message_stop' },
      ];
      for (const e of stream) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] })); }
    if (req.url === '/v1/chat/completions') {
      if (json.model === 'claude-capped' && json.max_tokens > 64000) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(`{"error":{"message":"max_tokens: ${json.max_tokens} > 64000, which is the maximum allowed number of output tokens"}}`); }
      if (json.model === 'deepseek-mute' && json.max_tokens) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Invalid max_tokens value"}}'); }
      if (json.model === 'strict-temp' && json.temperature !== undefined) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Unsupported parameter: temperature"}}'); }
      if (json.model === 'strict-model' && json.reasoning_effort) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Unknown parameter: reasoning_effort"}}'); }
      if (json.model.endsWith('-cf-timeout')) { res.writeHead(524, { 'content-type': 'text/html' }); return res.end('<html><body>A timeout occurred. The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.</body></html>'); }
      if (json.model === 'claude-ctx' && JSON.stringify(json.messages).includes('HUGE')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}'); }
      if (json.model === 'stall-body') {
        // Headers and a little gzip data, then silence.
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        const gz = zlib.createGzip();
        gz.pipe(res);
        gz.write('{"choices":');
        return gz.flush();
      }
      if (json.model === 'r1-tags') {
        // Reasoning marked only by inline tags, split across chunks; cache hits DeepSeek style.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const part of ['  <thi', 'nk>pla', 'n</th', 'ink>\n\nAns', 'wer']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (json.model === 'gpt-tools') {
        const tool = json.messages.filter((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = tool.length >= 2
          ? [{ choices: [{ delta: { content: `zipped: ${tool.at(-1).content}` }, finish_reason: 'stop' }] }]
          : tool.length === 1
            ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'create_zip', arguments: '{"path":"bundle"}' } }] }, finish_reason: 'tool_calls' }] }]
            : [
              { choices: [{ delta: { content: 'ok ' } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt",' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hello"}' } }] }, finish_reason: 'tool_calls' }] },
            ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (json.model === 'no-tools' && json.tools) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"tools is not supported for this model"}}'); }
      if (json.model === 'broken') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"upstream exploded"}}'); }
      if (json.model === 'plain') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })); }
      if (json.model === 'gemini-image') {
        // new-api style: image as markdown data URL inside the text stream, split across chunks.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const text = `Here you go! ![image](data:image/png;base64,${PNG.toString('base64')}) Done.`;
        for (const part of text.match(/[\s\S]{1,7}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: `https://${HOST}:${upstreamPort}/files/cat.png` } }] }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = [
        { choices: [{ delta: { reasoning_content: 'think ' } }] },
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 } } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.url === '/v1/images/generations') {
      if (json.model === 'no-size' && json.size) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"size not allowed"}}'); }
      if (json.model === 'stall-image') { res.writeHead(200, { 'content-type': 'application/json' }); return res.write('{"data":['); }
      if (json.model === 'edits-only' && json.image) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"image is not supported here"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      const count = json.n || 1;
      const data = json.model === 'url-model'
        ? [{ url: `https://${HOST}:${upstreamPort}/files/cat.png` }, { url: `https://${HOST}:${upstreamPort}/files/fake.png` }]
        : Array.from({ length: count }, () => ({ b64_json: PNG.toString('base64'), revised_prompt: json.model === 'revise' ? 'a better cat' : undefined }));
      return res.end(JSON.stringify({ created: 1, data, usage: { input_tokens: 9, output_tokens: 99 } }));
    }
    if (req.url === '/v1/images/edits') {
      seen.at(-1).multipart = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    }
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.reasoning_summary_text.delta', delta: 'plan' },
        { type: 'response.output_text.delta', delta: 'Resp' },
        { type: 'response.output_text.delta', delta: 'onse' },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
      ];
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      return res.end();
    }
    res.writeHead(404); res.end();
  });
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-chat-'));
  const keyFile = path.join(tmp, 'key.pem');
  const certFile = path.join(tmp, 'cert.pem');
  execFileSync(openssl(), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  const key = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile);
  upstream = startUpstream(key, cert);
  upstreamPort = await listen(upstream);
  vaultServer = startVault();
  vaultPort = await listen(vaultServer);
  agent = new https.Agent({ ca: cert });
  // Test lookup: resolve the fake upstream host to loopback, everything else via the real safe lookup.
  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (hostname === HOST) return options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    return safeLookup(hostname, options, cb);
  };
  testLookup = lookup;
  chat = createChatServer({ vault: createVaultClient({ port: vaultPort, bridgeSecret: BRIDGE }), origin: ORIGIN, lookup, agent, csrfKey: Buffer.alloc(32, 1), jobDir: path.join(tmp, 'jobs'), retryDelays: FAST_RETRY });
  chatPort = await listen(chat);
});

after(() => {
  chat?.closeAllConnections?.(); chat?.close(); upstream?.close(); vaultServer?.close(); agent?.destroy();
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function csrf() {
  const r = await request('GET', '/api/chat/session');
  return JSON.parse(r.text).csrf;
}

const postRaw = (...args) => post(...args);
async function post(route, body, extra = {}) {
  return request('POST', route, { body, headers: { origin: ORIGIN, 'x-chat-csrf': await csrf(), ...extra } });
}

const events = (text) => text.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type !== 'ping');

function getRaw(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: chatPort, path: route, method: 'GET', headers: { cookie: SESSION, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Starts an image job and follows it to completion; images come back as data URLs.
async function imageJob(body) {
  const start = await post('/api/chat/images', body);
  if (start.status !== 202) return { status: start.status, text: start.text, list: [] };
  const { jobId } = JSON.parse(start.text);
  const list = [];
  let after = 0;
  for (let i = 0; i < 50; i++) {
    const r = JSON.parse((await request('GET', `/api/chat/jobs/${jobId}/events?after=${after}`)).text);
    for (const e of r.events) {
      if (e.type === 'image') {
        const file = await getRaw(`/api/chat/jobs/${jobId}/images/${e.index}`);
        list.push({ ...e, url: `data:${file.headers['content-type']};base64,${file.body.toString('base64')}` });
      } else list.push(e);
    }
    after = r.next;
    if (r.status !== 'running') return { status: 202, jobId, jobStatus: r.status, list, text: JSON.stringify(list) };
  }
  throw new Error('job did not finish');
}

test('page and APIs require a Vault session', async () => {
  const page = await request('GET', '/chat', { cookie: '' });
  assert.equal(page.status, 401);
  assert.match(page.text, /请先登录/);
  const api = await request('GET', '/api/chat/accounts', { cookie: 'other=1' });
  assert.equal(api.status, 401);
  const ok = await request('GET', '/chat');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-security-policy'], /default-src 'self'/);
});

test('account list hides secrets and flags unusable entries', async () => {
  const r = await request('GET', '/api/chat/accounts');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(KEY));
  const { accounts } = JSON.parse(r.text);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  assert.equal(byId.acc1.usable, true);
  assert.deepEqual(byId.acc1.models, ['gpt-test', 'gpt-alt']);
  assert.equal(byId.nokey.usable, false);
  assert.equal('baseUrl' in byId.acc1, false);
});

test('writes require same origin and CSRF token', async () => {
  const body = { accountId: 'acc1' };
  assert.equal((await request('POST', '/api/chat/models', { body, headers: { origin: 'https://evil.example', 'x-chat-csrf': await csrf() } })).status, 403);
  assert.equal((await request('POST', '/api/chat/models', { body, headers: { origin: ORIGIN, 'x-chat-csrf': 'nope' } })).status, 403);
  assert.equal((await request('POST', '/api/chat/models', { body, headers: { origin: ORIGIN } })).status, 403);
});

test('models are fetched live with the stored key', async () => {
  const r = await post('/api/chat/models', { accountId: 'acc1' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text).models, ['a-model', 'z-model']);
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
});

test('models of an Anthropic API are fetched with x-api-key and /v1', async () => {
  const r = await post('/api/chat/models', { accountId: 'anth' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text).models, ['claude-a', 'claude-b']);
  assert.deepEqual(seen.slice(-2).map((s) => s.path), ['/anthropic/models', '/anthropic/v1/models?limit=1000']);
});

test('an Anthropic API saved as its /v1/messages endpoint still lists models', async () => {
  const r = await post('/api/chat/models', { accountId: 'anthMsg' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text).models, ['claude-a', 'claude-b']);
  assert.deepEqual(seen.slice(-2).map((s) => s.path), ['/anthropic/v1/messages/models', '/anthropic/v1/models?limit=1000']);
});

test('streams chat completions with reasoning, usage and effort', async () => {
  const r = await post('/api/chat/completions', {
    accountId: 'acc1', model: 'gpt-test', effort: 'high', system: 'be brief', temperature: 0.3, maxTokens: 50,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(KEY));
  const list = events(r.text);
  assert.equal(list.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  assert.equal(list.find((e) => e.type === 'reasoning').text, 'think ');
  assert.deepEqual(list.find((e) => e.type === 'usage').usage, { input: 5, output: 7, reasoning: 2 });
  assert.equal(list.at(-1).type, 'done');
  const sent = seen.at(-1).body;
  assert.equal(sent.reasoning_effort, 'high');
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.temperature, 0.3);
  assert.equal(sent.max_tokens, 50);
  assert.equal(sent.stream, true);
});

test('a rejected thinking level is reported, never silently dropped; Max is sent as-is', async () => {
  const before = seen.length;
  const r = await post('/api/chat/completions', { accountId: 'acc1', model: 'strict-model', effort: 'low', messages: [{ role: 'user', content: 'hi' }] });
  const list = events(r.text);
  const error = list.find((e) => e.type === 'error');
  assert.match(error.message, /reasoning_effort/);
  assert.match(error.message, /思考强度：低/);
  assert.ok(!list.some((e) => e.type === 'delta'));
  assert.ok(seen.slice(before).every((s) => s.body.reasoning_effort === 'low'), 'every attempt kept the chosen level');
  // Without a thinking level the old fallback (strip optional params) still applies.
  const temp = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'strict-temp', temperature: 0.5, messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.ok(temp.some((e) => e.type === 'notice' && /temperature/.test(e.message)));
  assert.equal(temp.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', effort: 'max', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.at(-1).body.reasoning_effort, 'max');
});

test('output is unlimited by default: huge cap, shrunk to what the upstream allows', async () => {
  // Chat Completions behavior (auto mode would try Claude's native API first).
  const post = (route, body) => postRaw(route, { apiType: 'chat', ...body });
  const r = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-fable-5-1', effort: 'xhigh', messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.equal(seen.at(-1).body.max_tokens, 128000);
  assert.equal(seen.at(-1).body.reasoning_effort, 'xhigh');
  assert.ok(!r.some((e) => e.type === 'notice'));
  // upstream states its maximum: retried with exactly that, effort kept, no notice
  const before = seen.length;
  const capped = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-capped', effort: 'high', messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.equal(capped.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  assert.deepEqual(seen.slice(before).map((s) => s.body.max_tokens), [128000, 64000]);
  assert.equal(seen.at(-1).body.reasoning_effort, 'high');
  assert.ok(!capped.some((e) => e.type === 'notice'));
  // learned: the next request goes straight to the allowed maximum
  const again = seen.length;
  await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-capped', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(seen.slice(again).map((s) => s.body.max_tokens), [64000]);
  // upstream rejects without a number: dropped silently, effort kept
  const mute = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'deepseek-mute', effort: 'high', messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.equal(seen.at(-1).body.max_tokens, undefined);
  assert.equal(seen.at(-1).body.reasoning_effort, 'high');
  assert.ok(!mute.some((e) => e.type === 'notice'));
  // explicit user limit is respected; OpenAI models are unlimited when omitted
  await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-x', maxTokens: 500, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.at(-1).body.max_tokens, 500);
  await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.at(-1).body.max_tokens, undefined);
});

test('Claude via its native Messages API: summarized thinking, effort, automatic caching, cache hits', async () => {
  const r = await post('/api/chat/completions', {
    accountId: 'anth', model: 'claude-opus-5-5', effort: 'xhigh', system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }],
  });
  assert.equal(r.status, 200);
  const list = events(r.text);
  assert.equal(list.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), 'Let me think.');
  assert.equal(list.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hi there');
  assert.deepEqual(list.filter((e) => e.type === 'usage').at(-1).usage, { input: 1050, output: 40, cacheRead: 1000, cacheWrite: 30 });
  assert.equal(list.find((e) => e.type === 'finish').reason, 'stop');
  assert.ok(!list.some((e) => e.type === 'error' || e.type === 'notice'));
  const sent = seen.at(-1);
  assert.equal(sent.path, '/anthropic/v1/messages');
  assert.equal(sent.xkey, KEY);
  assert.equal(sent.version, '2023-06-01');
  assert.deepEqual(sent.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(sent.body.output_config, { effort: 'xhigh' });
  assert.deepEqual(sent.body.cache_control, { type: 'ephemeral' });
  assert.equal(sent.body.system, 'be brief');
  assert.equal(sent.body.max_tokens, 128000);
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.messages.map((m) => [m.role, m.content]), [['user', 'hi'], ['assistant', 'yo'], ['user', 'again']]);
  // Off sends no thinking parameter at all.
  await post('/api/chat/completions', { accountId: 'anth', model: 'claude-opus-5-5', effort: 'none', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.at(-1).body.thinking, undefined);
  assert.equal(seen.at(-1).body.output_config, undefined);
});

test('older Claude models get a thinking budget; rejected temperature and max_tokens are handled and learned', async () => {
  let before = seen.length;
  const old = events((await post('/api/chat/completions', { accountId: 'anth', model: 'claude-old', effort: 'high', messages: [{ role: 'user', content: 'hi' }] })).text);
  const bodies = seen.slice(before).map((s) => s.body);
  assert.deepEqual(bodies.map((b) => b.thinking?.type), ['adaptive', 'enabled']);
  assert.equal(bodies[1].thinking.budget_tokens, 16000);
  assert.equal(bodies[1].output_config, undefined);
  assert.equal(old.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), 'Let me think.');
  assert.ok(!old.some((e) => e.type === 'error'));
  before = seen.length;
  await post('/api/chat/completions', { accountId: 'anth', model: 'claude-old', effort: 'high', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(seen.slice(before).map((s) => s.body.thinking?.type), ['enabled'], 'learned: no second adaptive attempt');
  await post('/api/chat/completions', { accountId: 'anth', model: 'claude-old', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.at(-1).body.thinking, undefined, 'Default on a model without adaptive thinking: none');
  const temp = events((await post('/api/chat/completions', { accountId: 'anth', model: 'claude-notemp', temperature: 0.5, messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.ok(temp.some((e) => e.type === 'notice' && /温度/.test(e.message)));
  assert.equal(seen.at(-1).body.temperature, undefined);
  assert.equal(temp.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hi there');
  before = seen.length;
  await post('/api/chat/completions', { accountId: 'anth', model: 'claude-64k', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(seen.slice(before).map((s) => s.body.max_tokens), [128000, 64000]);
  before = seen.length;
  await post('/api/chat/completions', { accountId: 'anth', model: 'claude-64k', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(seen.slice(before).map((s) => s.body.max_tokens), [64000]);
});

test('auto mode: a relay without /v1/messages falls back to Chat Completions and remembers it', async () => {
  let before = seen.length;
  const r = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-relay', messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.deepEqual(seen.slice(before).map((s) => s.path), ['/v1/messages', '/v1/chat/completions']);
  assert.equal(r.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello');
  assert.ok(!r.some((e) => e.type === 'error'));
  before = seen.length;
  await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-relay', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(seen.slice(before).map((s) => s.path), ['/v1/chat/completions']);
  // Forced formats never probe; a forced native request reports the failure.
  before = seen.length;
  await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-other', apiType: 'chat', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(seen.slice(before).map((s) => s.path), ['/v1/chat/completions']);
  const forced = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', apiType: 'anthropic', messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.match(forced.find((e) => e.type === 'error').message, /404/);
});

test('inline <think> tags become thinking; DeepSeek cache hits are reported', async () => {
  const list = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'r1-tags', messages: [{ role: 'user', content: 'hi' }] })).text);
  assert.equal(list.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), 'plan');
  assert.equal(list.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Answer');
  assert.deepEqual(list.find((e) => e.type === 'usage').usage, { input: 100, output: 5, cacheRead: 64 });
});

test('reasoning and cache fields across providers', () => {
  const run = (chunks) => {
    const f = thinkTagFilter();
    const out = [...chunks.flatMap((c) => f.push(c)), ...f.flush()];
    const join = (t) => out.filter((e) => e.type === t).map((e) => e.text).join('');
    return [join('reasoning'), join('delta')];
  };
  assert.deepEqual(run(['<thought>a<', '/thought>b']), ['a', 'b']);
  assert.deepEqual(run(['<', 'table> x']), ['', '<table> x']);
  assert.deepEqual(run(['Use <think> tags']), ['', 'Use <think> tags'], 'only a leading tag counts');
  assert.deepEqual(run(['<think>never closed']), ['never closed', '']);
  assert.deepEqual(openaiUsage({ prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } }), { input: 50, output: 3, cacheRead: 40 });
  assert.deepEqual(openaiUsage({ input_tokens: 50, output_tokens: 3, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } }), { input: 50, output: 3, reasoning: 2, cacheRead: 10 });
  assert.deepEqual(openaiUsage({ input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 }), { input: 100, output: 3, cacheRead: 90, cacheWrite: 5 });
  assert.deepEqual(openaiUsage({ prompt_tokens: 10, completion_tokens: 1, cached_tokens: 8 }), { input: 10, output: 1, cacheRead: 8 });
  const openrouter = normalize('chat', { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'r1' }, { type: 'reasoning.encrypted', data: 'x' }] } }] });
  assert.deepEqual(openrouter, [{ type: 'reasoning', text: 'r1' }]);
  const both = normalize('chat', { choices: [{ delta: { reasoning: 'once', reasoning_details: [{ type: 'reasoning.text', text: 'once' }] } }] });
  assert.deepEqual(both, [{ type: 'reasoning', text: 'once' }], 'no duplicate when both are sent');
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com/v1/messages').href, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicMessagesUrl('https://relay.example/api').href, 'https://relay.example/api/v1/messages');
  assert.equal(anthropicMessagesUrl('https://relay.example/v1/chat/completions').href, 'https://relay.example/v1/messages');
  assert.equal(anthropicHeaders('https://api.anthropic.com/v1', ['Authorization', 'Bearer k'], 'k').Authorization, undefined);
  assert.equal(anthropicHeaders('https://relay.example/v1', ['Authorization', 'Bearer k'], 'k').Authorization, 'Bearer k');
  const parse = anthropicStream();
  parse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  assert.deepEqual(parse({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }), [{ type: 'reasoning', text: '\n\n' }]);
  assert.deepEqual(parse({ type: 'message_delta', delta: { stop_reason: 'refusal' } }), [{ type: 'finish', reason: 'refusal' }]);
  assert.match(parse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })[0].message, /Overloaded/);
});

test('reads allowed max_tokens from upstream errors', () => {
  assert.equal(allowedMaxTokens('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-x', 128000), 64000);
  assert.equal(allowedMaxTokens('This model supports at most 16,384 completion tokens', 128000), 16384);
  assert.equal(allowedMaxTokens('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]', 128000), 8192);
  assert.equal(allowedMaxTokens('input length and `max_tokens` exceed context limit: 150000 + 128000 > 200000', 128000), 49744);
  assert.equal(allowedMaxTokens('max_tokens is too large', 128000), undefined);
  assert.equal(allowedMaxTokens('Unknown parameter: reasoning_effort', 128000), undefined);
});

test('reports upstream errors and non-streaming JSON replies', async () => {
  const bad = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'broken', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.ok(bad.some((e) => e.type === 'error' && /500.*upstream exploded/.test(e.message)));
  const plain = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'plain', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.equal(plain.find((e) => e.type === 'delta').text, 'whole answer');
});

test('Cloudflare 524 from a relay is explained, with what the user can change', async () => {
  const gpt = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-x-cf-timeout', effort: 'high', messages: [{ role: 'user', content: 'x' }] })).text);
  const msg = gpt.find((e) => e.type === 'error').message;
  assert.match(msg, /^上游返回 524：中转站前面的 Cloudflare/);
  assert.match(msg, /不是本站超时/);
  assert.match(msg, /调低思考强度/);
  assert.match(msg, /Responses/);
  assert.ok(!/Proxy Read Timeout/.test(msg), 'raw English boilerplate replaced');
  const other = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-cf-timeout', messages: [{ role: 'user', content: 'x' }] })).text);
  const m2 = other.find((e) => e.type === 'error').message;
  assert.ok(!/思考强度|Responses/.test(m2), m2);
});

test('supports the Responses API', async () => {
  const r = await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', apiType: 'responses', effort: 'medium', messages: [{ role: 'user', content: 'x' }] });
  const list = events(r.text);
  assert.equal(list.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Response');
  assert.equal(list.find((e) => e.type === 'reasoning').text, 'plan');
  assert.deepEqual(seen.at(-1).body.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(seen.at(-1).path, '/v1/responses');
});

test('rejects invalid input, keyless and private-address accounts', async () => {
  assert.equal((await post('/api/chat/completions', { accountId: 'acc1', model: 'm', messages: [] })).status, 400);
  assert.equal((await post('/api/chat/completions', { accountId: 'acc1', model: 'm', effort: 'turbo', messages: [{ role: 'user', content: 'x' }] })).status, 400);
  assert.equal((await post('/api/chat/completions', { accountId: '../x', model: 'm', messages: [{ role: 'user', content: 'x' }] })).status, 400);
  const nokey = events((await post('/api/chat/completions', { accountId: 'nokey', model: 'm', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.ok(nokey.some((e) => e.type === 'error' && /密钥/.test(e.message)));
  const local = events((await post('/api/chat/completions', { accountId: 'local', model: 'm', messages: [{ role: 'user', content: 'x' }] })).text);
  assert.ok(local.some((e) => e.type === 'error' && /非公网|本机/.test(e.message)));
  const missing = await post('/api/chat/models', { accountId: 'someone-else' });
  assert.equal(missing.status, 404);
});

test('sends attached images to vision chat models', async () => {
  const r = await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', messages: [{ role: 'user', content: 'what is this', images: [PNG_URL] }] });
  assert.equal(r.status, 200, r.text);
  const content = seen.at(-1).body.messages[0].content;
  assert.deepEqual(content[0], { type: 'text', text: 'what is this' });
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, PNG_URL);
  const responses = await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', apiType: 'responses', messages: [{ role: 'user', content: '', images: [PNG_URL] }] });
  assert.equal(responses.status, 200);
  assert.deepEqual(seen.at(-1).body.input[0].content, [{ type: 'input_image', image_url: PNG_URL }]);
  // Non-images and disguised files are rejected before any upstream call.
  const bad = await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', messages: [{ role: 'user', content: 'x', images: ['data:image/png;base64,PGh0bWw+'] }] });
  assert.equal(bad.status, 400);
  const notData = await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', messages: [{ role: 'user', content: 'x', images: ['https://example.com/a.png'] }] });
  assert.equal(notData.status, 400);
});

test('lifts inline images out of chat replies (Gemini image models)', async () => {
  const r = await post('/api/chat/completions', { accountId: 'acc1', model: 'gemini-image', messages: [{ role: 'user', content: 'draw' }] });
  const list = events(r.text);
  const text = list.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(text, 'Here you go!  Done.');
  const images = list.filter((e) => e.type === 'image');
  assert.equal(images.length, 2);
  assert.ok(images.every((e) => e.url === PNG_URL), 'remote image URL is downloaded and inlined');
});

test('generates images through the Images API', async () => {
  const r = await imageJob({ accountId: 'acc1', model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024', quality: 'high', n: 2 });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.jobStatus, 'done');
  assert.ok(!r.text.includes(KEY));
  const list = r.list;
  assert.ok(list.filter((e) => e.type === 'image').every((e) => e.url === PNG_URL));
  assert.equal(list.filter((e) => e.type === 'image').length, 2);
  assert.deepEqual(list.find((e) => e.type === 'usage').usage, { input: 9, output: 99 });
  assert.equal(list.at(-1).type, 'done');
  const sent = seen.at(-1);
  assert.equal(sent.path, '/v1/images/generations');
  assert.deepEqual(sent.body, { model: 'gpt-image-2', prompt: 'a cat', n: 2, size: '1024x1024', quality: 'high' });
});

test('image jobs survive disconnects: events can be re-read, downloads resume with Range, owner-only', async () => {
  const r = await imageJob({ accountId: 'acc1', model: 'gpt-image-2', prompt: 'x' });
  // Re-reading from the start returns the same events (page reload).
  const again = JSON.parse((await request('GET', `/api/chat/jobs/${r.jobId}/events?after=0`)).text);
  assert.equal(again.status, 'done');
  assert.deepEqual(again.events.map((e) => e.type), r.list.map((e) => e.type));
  // Partial download then resume from an offset.
  const head = await getRaw(`/api/chat/jobs/${r.jobId}/images/0`, { range: 'bytes=0-9' });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-range'], `bytes 0-9/${PNG.length}`);
  const rest = await getRaw(`/api/chat/jobs/${r.jobId}/images/0`, { range: 'bytes=10-' });
  assert.equal(rest.status, 206);
  assert.ok(Buffer.concat([head.body, rest.body]).equals(PNG));
  // Without a session, or for another user's job, nothing is exposed.
  const anon = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: chatPort, path: `/api/chat/jobs/${r.jobId}/images/0` }, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(anon, 401);
  assert.equal((await request('GET', '/api/chat/jobs/00000000-0000-4000-8000-000000000000/events')).status, 404);
  assert.equal((await request('GET', '/api/chat/jobs/../../etc/events')).status, 404);
  assert.equal((await getRaw(`/api/chat/jobs/${r.jobId}/images/7`)).status, 404);
});

test('image generation downloads URLs safely and retries without unsupported params', async () => {
  const urls = (await imageJob({ accountId: 'acc1', model: 'url-model', prompt: 'x' })).list;
  assert.equal(urls.filter((e) => e.type === 'image').length, 1);
  assert.equal(urls.find((e) => e.type === 'image').url, PNG_URL);
  assert.ok(urls.some((e) => e.type === 'notice' && /不是图片/.test(e.message)));
  const strip = (await imageJob({ accountId: 'acc1', model: 'no-size', prompt: 'x', size: '1024x1024', n: 1 })).list;
  assert.ok(strip.some((e) => e.type === 'image'));
  assert.equal(seen.at(-1).body.size, undefined);
  const revised = (await imageJob({ accountId: 'acc1', model: 'revise', prompt: 'x' })).list;
  assert.ok(revised.some((e) => e.type === 'notice' && /a better cat/.test(e.message)));
  assert.equal((await post('/api/chat/images', { accountId: 'acc1', model: 'm', prompt: '' })).status, 400);
  assert.equal((await post('/api/chat/images', { accountId: 'acc1', model: 'm', prompt: 'x', size: '1024x1024;rm' })).status, 400);
  assert.equal((await post('/api/chat/images', { accountId: 'acc1', model: 'm', prompt: 'x', n: 9 })).status, 400);
});

test('reference images use /images/edits multipart, falling back from generations', async () => {
  const edit = (await imageJob({ accountId: 'acc1', model: 'gpt-image-2', prompt: 'make it blue', images: [PNG_URL] })).list;
  assert.ok(edit.some((e) => e.type === 'image'));
  const sent = seen.at(-1);
  assert.equal(sent.path, '/v1/images/edits');
  assert.match(sent.multipart, /name="prompt"\r\n\r\nmake it blue/);
  assert.match(sent.multipart, /name="image"; filename="image-1.png"\r\nContent-Type: image\/png/);
  assert.ok(Buffer.from(sent.multipart, 'latin1').includes(PNG));
});

const waitFor = async (check) => { for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('admin grants are listed as accounts without any endpoint or key', async () => {
  const { accounts } = JSON.parse((await request('GET', '/api/chat/accounts')).text);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  assert.equal(byId.acc1.usable, true, 'own APIs still listed');
  assert.equal(byId.g_gopen.usable, true);
  assert.equal(byId.g_gopen.name, '借用 Relay');
  assert.match(byId.g_gopen.grant.quota, /今日 3\/20 次/);
  assert.equal(byId.g_gonly.grant.restricted, true);
  assert.deepEqual(byId.g_gonly.models, ['gpt-test', 'plain']);
  assert.equal(byId.g_gdone.usable, false);
  assert.equal(byId.g_gdone.grant.blocked, '今日次数已用完');
  const grantsText = JSON.stringify(accounts.filter((a) => a.grant));
  assert.ok(!grantsText.includes(KEY) && !grantsText.includes(HOST), 'grants leak neither the key nor the owner endpoint');
  assert.ok(!JSON.stringify(accounts).includes(KEY));
});

test('grant chat uses the bridge, the owner key, and reports usage once', async () => {
  bridgeLog.length = 0;
  const r = await post('/api/chat/completions', { accountId: 'g_gopen', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  assert.ok(events(r.text).some((e) => e.type === 'done'));
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
  await waitFor(() => bridgeLog.some((x) => x.path.endsWith('/report')));
  const acquire = bridgeLog.find((x) => x.path.endsWith('/acquire'));
  assert.deepEqual(acquire.body, { grantId: 'gopen', userId: 'owner1', kind: 'chat', model: 'gpt-test' });
  assert.equal(acquire.cookie, '', 'bridge calls never forward the user cookie');
  const reports = bridgeLog.filter((x) => x.path.endsWith('/report'));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.status, 'completed');
  assert.equal(reports[0].body.inputTokens, 5);
  assert.equal(reports[0].body.outputTokens, 7);
  assert.equal(reports[0].body.reasoningTokens, 2);
  assert.equal(reports[0].body.kind, 'chat');
});

test('grant upstream errors are reported as failed (not billed by Vault)', async () => {
  bridgeLog.length = 0;
  const r = await post('/api/chat/completions', { accountId: 'g_gopen', model: 'broken', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(events(r.text).some((e) => e.type === 'error'));
  await waitFor(() => bridgeLog.some((x) => x.path.endsWith('/report')));
  assert.equal(bridgeLog.find((x) => x.path.endsWith('/report')).body.status, 'failed');
});

test('grant model restriction and quota are enforced by Vault and shown to the user', async () => {
  const listed = await post('/api/chat/models', { accountId: 'g_gonly' });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(JSON.parse(listed.text), { models: ['gpt-test', 'plain'], kinds: {}, allowCustom: false });
  const wrong = await post('/api/chat/completions', { accountId: 'g_gonly', model: 'gpt-alt', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(events(wrong.text).some((e) => e.type === 'error' && /不能使用这个模型/.test(e.message)), wrong.text);
  const spent = await post('/api/chat/completions', { accountId: 'g_gdone', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(events(spent.text).some((e) => e.type === 'error' && /今日次数已用完/.test(e.message)), spent.text);
  const gone = await post('/api/chat/completions', { accountId: 'g_nope', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(events(gone.text).some((e) => e.type === 'error' && /授权不存在/.test(e.message)), gone.text);
});

test('grant image jobs bill delivered images', async () => {
  bridgeLog.length = 0;
  const r = await imageJob({ accountId: 'g_gopen', model: 'gpt-image-1', prompt: 'a cat', n: 2 });
  assert.equal(r.jobStatus, 'done', r.text);
  await waitFor(() => bridgeLog.some((x) => x.path.endsWith('/report')));
  const acquire = bridgeLog.find((x) => x.path.endsWith('/acquire'));
  assert.equal(acquire.body.kind, 'image');
  const report = bridgeLog.find((x) => x.path.endsWith('/report')).body;
  assert.equal(report.kind, 'image');
  assert.equal(report.images, 2);
  assert.equal(report.status, 'completed');
});

test('without a bridge secret grants are hidden and own APIs keep working', async () => {
  const plain = createChatServer({ vault: createVaultClient({ port: vaultPort }), origin: ORIGIN, csrfKey: Buffer.alloc(32, 1), jobDir: path.join(tmp, 'jobs2') });
  const port = await listen(plain);
  try {
    const text = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/chat/accounts', headers: { cookie: SESSION } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t));
      }).on('error', reject);
    });
    const ids = JSON.parse(text).accounts.map((a) => a.id);
    assert.ok(ids.includes('acc1'));
    assert.ok(!ids.some((id) => id.startsWith('g_')));
  } finally { plain.close(); }
});

test('network policy', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '172.86.85.134', '2606:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
  assert.throws(() => validateBaseUrl('http://api.example.com/v1'));
  assert.throws(() => validateBaseUrl('https://user@api.example.com/v1'));
  assert.throws(() => validateBaseUrl('https://localhost/v1'));
  assert.throws(() => validateBaseUrl('https://10.0.0.1/v1'));
  assert.equal(validateBaseUrl('https://api.example.com/v1').host, 'api.example.com');
});

test('payload helpers', () => {
  const thinking = buildPayload({ model: 'm', messages: [{ role: 'user', content: 'x' }], effort: 'none', effortFormat: 'thinking' });
  assert.deepEqual(thinking.thinking, { type: 'disabled' });
  assert.equal(thinking.reasoning_effort, undefined);
  const stripped = buildPayload({ model: 'm', messages: [{ role: 'user', content: 'x' }], effort: 'high', temperature: 1 }, true);
  assert.equal(stripped.reasoning_effort, undefined);
  assert.equal(stripped.temperature, undefined);
  assert.equal(stripped.stream_options, undefined);
  assert.deepEqual(normalize('chat', { choices: [{ delta: { reasoning: 'r' } }] }), [{ type: 'reasoning', text: 'r' }]);
  assert.equal(mergeCookies('a=1; b=2', ['b=3; path=/', 'c=4']), 'a=1; b=3; c=4');
});

test('image helpers', () => {
  const ark = imageRequest('https://ark.cn-beijing.volces.com/api/v3', { model: 'doubao-seedream-5-0', prompt: 'p', size: '2K', images: [{ url: PNG_URL }] }, { mode: 'gen-ref', n: 3 });
  assert.equal(ark.url.href, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.equal(ark.body.watermark, false);
  assert.equal(ark.body.image, PNG_URL);
  assert.equal(ark.body.n, undefined);
  assert.deepEqual(ark.body.sequential_image_generation_options, { max_images: 3 });
  const kinds = modelKinds({ data: [
    { id: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
    { id: 'wan2.7-t2v', supported_endpoint_types: ['openai-video'] },
    { id: 'gemini-3-pro-image', supported_endpoint_types: ['gemini'] },
    { id: 'doubao-seedream-5-0', domain: 'ImageGeneration' },
    { id: 'gpt-5', supported_endpoint_types: ['openai'] },
  ] });
  assert.deepEqual(kinds, { 'gpt-image-2': 'image', 'wan2.7-t2v': 'video', 'doubao-seedream-5-0': 'image' });
  // Inline filter keeps ordinary "!" text and holds back split markers.
  const f = inlineImageFilter();
  const out = [...f.push('Wow! nice '), ...f.push('![a'), ...f.push(`](data:image/png;base64,${PNG.toString('base64')}`), ...f.push(') end'), ...f.flush()];
  assert.equal(out.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Wow! nice  end');
  assert.deepEqual(out.filter((e) => e.type === 'image').map((e) => e.url), [PNG_URL]);
  const g = inlineImageFilter();
  assert.equal([...g.push('see ![chart](https://x.y/a.png)'), ...g.flush()].map((e) => e.text).join(''), 'see ![chart](https://x.y/a.png)');
  assert.throws(() => validateBaseUrl('http://example.com/a.png?x=1'));
  assert.equal(validateBaseUrl('http://example.com/a.png?x=1#f', { allowQuery: true, allowHttp: true }).href, 'http://example.com/a.png?x=1');
});

// ---------- fixes from the 2026-10 review ----------

test('a context overflow does not cap later requests; only model limits are remembered', async () => {
  const huge = events((await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-ctx', messages: [{ role: 'user', content: 'HUGE' }] })).text);
  assert.ok(huge.some((e) => e.type === 'error' && /prompt is too long/.test(e.message)), JSON.stringify(huge));
  await post('/api/chat/completions', { accountId: 'acc1', model: 'claude-ctx', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen.at(-1).body.max_tokens, 128000, 'the next, normal request still asks for the full output');
  assert.equal(learnedCap('prompt is too long: 210000 tokens > 200000 maximum', undefined), undefined);
  assert.equal(learnedCap('input length and `max_tokens` exceed context limit: 150000 + 128000 > 200000', 49744), undefined);
  assert.equal(learnedCap('max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens', 64000), 64000);
  assert.equal(learnedCap('Invalid max_tokens value', undefined), 0);
  assert.equal(learnedCap('invalid api token', undefined), undefined);
  // OpenAI's context error: the room left after the prompt, not the prompt size.
  const openai = "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens (2000 in the messages, 128000 in the completion).";
  assert.equal(allowedMaxTokens(openai, 128000), 125744);
  assert.equal(learnedCap(openai, 125744), undefined);
});

test('SSE parsing: mixed line ends, chunk splits and huge events', async () => {
  const parse = async (chunks) => {
    const out = [];
    for await (const p of sseEvents(Readable.from(chunks.map((c) => Buffer.from(c))))) out.push(p);
    return out;
  };
  assert.deepEqual(await parse(['data: {"a":1}\r\n\ndata: {"b":2}\n\n']), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(await parse(['data: {"a":1}\r', '\n\r', '\ndata: {"b":2}\r\r']), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(await parse(['event: x\ndata: {"a":', '1}\n\ndata: [DONE]\n\n']), [{ a: 1 }, '[DONE]']);
  assert.deepEqual(await parse(['data: {"tail":true}']), [{ tail: true }], 'last event without a blank line');
  const big = 'x'.repeat(3 * 1024 * 1024);
  const text = `data: ${JSON.stringify({ big })}\n\n`;
  const began = Date.now();
  const [one] = await parse(text.match(/[\s\S]{1,16384}/g));
  assert.equal(one.big.length, big.length);
  assert.ok(Date.now() - began < 3000, 'linear, not quadratic');
});

test('requests other than chat and image jobs have a small body limit', async () => {
  const r = await post('/api/chat/models', { accountId: 'acc1', pad: 'x'.repeat(100 * 1024) });
  assert.equal(r.status, 413);
});

test('CSRF key survives restarts', () => {
  const file = path.join(tmp, 'state', 'csrf.key');
  const a = loadOrCreateKey(file);
  const b = loadOrCreateKey(file);
  assert.equal(a.length, 32);
  assert.ok(a.equals(b));
});

test('a stalled upstream is cut after the idle timeout (gzip too); image slots are freed', async () => {
  const quick = createChatServer({ vault: createVaultClient({ port: vaultPort }), origin: ORIGIN, lookup: testLookup, agent, csrfKey: Buffer.alloc(32, 1), idleMs: 400, jobDir: path.join(tmp, 'jobs-idle'), retryDelays: FAST_RETRY });
  const port = await listen(quick);
  let csrfToken = '';
  const call = (method, route, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: {
      cookie: SESSION, ...(payload ? { origin: ORIGIN, 'x-chat-csrf': csrfToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    req.on('error', reject);
    req.end(payload);
  });
  csrfToken = JSON.parse((await call('GET', '/api/chat/session')).text).csrf;
  try {
    const began = Date.now();
    const r = await call('POST', '/api/chat/completions', { accountId: 'acc1', model: 'stall-body', messages: [{ role: 'user', content: 'x' }] });
    assert.ok(events(r.text).some((e) => e.type === 'error' && /超时/.test(e.message)), r.text);
    assert.ok(Date.now() - began < 5000);
    for (let i = 0; i < 3; i++) { // more jobs than the 2 image slots: each must end and free its slot
      const start = await call('POST', '/api/chat/images', { accountId: 'acc1', model: 'stall-image', prompt: 'x' });
      assert.equal(start.status, 202, start.text);
      const { jobId } = JSON.parse(start.text);
      let state;
      const seenEvents = [];
      for (let k = 0, after = 0; k < 40; k++) {
        state = JSON.parse((await call('GET', `/api/chat/jobs/${jobId}/events?after=${after}`)).text);
        seenEvents.push(...state.events);
        after = state.next;
        if (state.status !== 'running') break;
      }
      assert.equal(state.status, 'failed');
      assert.ok(seenEvents.some((e) => e.type === 'error' && /超时/.test(e.message)), JSON.stringify(seenEvents));
    }
  } finally { quick.closeAllConnections(); quick.close(); }
});

test('an unreadable image file ends that download instead of crashing the server', async () => {
  const r = await imageJob({ accountId: 'acc1', model: 'gpt-image-2', prompt: 'x' });
  const file = path.join(tmp, 'jobs', `${r.jobId}-0.img`);
  fs.rmSync(file);
  fs.mkdirSync(file); // stat works, reading fails (EISDIR)
  await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: chatPort, path: `/api/chat/jobs/${r.jobId}/images/0`, headers: { cookie: SESSION } }, (res) => {
      res.on('data', () => {}); res.on('end', resolve); res.on('error', resolve); res.on('aborted', resolve);
    }).on('error', resolve);
  });
  assert.equal((await request('GET', '/health')).status, 200, 'still serving');
  fs.rmSync(file, { recursive: true });
});

test('usage is counted per day, API and model; names come from the current account list', async () => {
  const sum = (data, kind, model) => data.rows.filter((r) => r.kind === kind && r.accountId === 'acc1' && r.model === model)
    .reduce((s, r) => ({ requests: s.requests + r.requests, input: s.input + r.input, output: s.output + r.output, images: s.images + r.images, failed: s.failed + r.failed }),
      { requests: 0, input: 0, output: 0, images: 0, failed: 0 });
  const before = JSON.parse((await request('GET', '/api/chat/usage?days=7')).text);
  await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  await post('/api/chat/completions', { accountId: 'acc1', model: 'broken', messages: [{ role: 'user', content: 'hi' }] });
  await imageJob({ accountId: 'acc1', model: 'gpt-image-2', prompt: 'a cat', n: 2 });
  const after = JSON.parse((await request('GET', '/api/chat/usage?days=7')).text);
  assert.equal(after.today, usageDay(Date.now()));
  assert.equal(after.names.acc1, 'Relay');
  const chatNow = sum(after, 'chat', 'gpt-test');
  const chatThen = sum(before, 'chat', 'gpt-test');
  assert.equal(chatNow.requests - chatThen.requests, 1);
  assert.equal(chatNow.input - chatThen.input, 5);
  assert.equal(chatNow.output - chatThen.output, 7);
  assert.equal(sum(after, 'chat', 'broken').failed - sum(before, 'chat', 'broken').failed, 1);
  assert.equal(sum(after, 'image', 'gpt-image-2').images - sum(before, 'image', 'gpt-image-2').images, 2);
  assert.ok(!JSON.stringify(after).includes(KEY) && !JSON.stringify(after).includes(HOST), 'no key or endpoint');
  assert.equal((await request('GET', '/api/chat/usage', { cookie: '' })).status, 401);
});

test('usage store: persisted per user, pruned after the retention window', () => {
  const dir = path.join(tmp, 'usage');
  let clock = Date.parse('2026-10-06T10:00:00Z');
  const store = createUsageStore({ dir, now: () => clock, retentionDays: 3 });
  store.record({ userId: 'u1', kind: 'chat', accountId: 'a', label: 'A', model: 'm', status: 'completed', usage: { input: 3, output: 4 }, ms: 10 });
  store.record({ userId: 'u1', kind: 'chat', accountId: 'a', model: 'm', status: 'failed' });
  store.record({ userId: 'u2', kind: 'image', accountId: 'b', model: 'img', status: 'completed', images: 2 });
  store.close();
  assert.equal(fs.readdirSync(dir).length, 2, 'one file per user');
  const again = createUsageStore({ dir, now: () => clock, retentionDays: 3 });
  const q = again.query('u1', { days: 7 });
  assert.deepEqual(q.rows.map(({ day, requests, failed, input, output }) => ({ day, requests, failed, input, output })),
    [{ day: '2026-10-06', requests: 2, failed: 1, input: 3, output: 4 }]);
  assert.equal(q.labels.a, 'A');
  assert.equal(again.query('u2').rows[0].images, 2);
  clock += 5 * 24 * 3600 * 1000;
  again.record({ userId: 'u1', kind: 'chat', accountId: 'a', model: 'm', status: 'completed' });
  assert.deepEqual(again.query('u1', { days: 30 }).rows.map((r) => r.day), ['2026-10-11']);
  again.close();
  // Asia/Shanghai days: 23:30 UTC is already the next day there.
  assert.equal(usageDay(Date.parse('2026-10-06T23:30:00Z')), '2026-10-07');
});

test('health: loopback details for deploy checks, public liveness without details', async () => {
  const h = JSON.parse((await request('GET', '/health', { cookie: '' })).text);
  assert.equal(h.status, 'ok');
  assert.equal(typeof h.release, 'string');
  assert.ok(h.trace.models > 0);
  assert.equal(typeof h.uptimeS, 'number');
  const pub = await request('GET', '/chat/healthz', { cookie: '' });
  assert.equal(pub.status, 200);
  assert.deepEqual(JSON.parse(pub.text), { status: 'ok' });
});

// ---------- busy upstreams, interrupted replies, file tools, API relay ----------

const textOf = (list) => list.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const CONV = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

test('529 Overloaded before the reply starts is retried automatically', async () => {
  const r = await post('/api/chat/completions', { accountId: 'anth', model: 'claude-busy', messages: [{ role: 'user', content: 'busy test' }] });
  const list = events(r.text);
  assert.ok(list.some((e) => e.type === 'notice' && /Overloaded/.test(e.message) && e.transient), r.text);
  assert.equal(textOf(list), 'calm now');
  assert.ok(!list.some((e) => e.type === 'error'), r.text);
  assert.equal(list.at(-1).type, 'done');
});

test('a reply cut off by an Overloaded stream error is continued from where it stopped', async () => {
  const before = seen.length;
  const r = await post('/api/chat/completions', { accountId: 'anth', model: 'claude-drop', messages: [{ role: 'user', content: 'write a lot' }] });
  const list = events(r.text);
  assert.equal(textOf(list), 'Part one, part two.', r.text);
  assert.ok(list.some((e) => e.type === 'notice' && /断点续写/.test(e.message)), r.text);
  assert.ok(!list.some((e) => e.type === 'error'), r.text);
  const second = seen.slice(before).filter((s) => s.body?.model === 'claude-drop')[1].body;
  assert.deepEqual(second.messages.at(-2), { role: 'assistant', content: [{ type: 'text', text: 'Part one, ' }] });
  assert.match(second.messages.at(-1).content, /中断/);
  // The cut-off turn's output is still counted (estimated), plus the continuation.
  assert.ok(list.filter((e) => e.type === 'usage').at(-1).usage.output >= 5);
});

test('file tools (Anthropic): signed thinking replayed, file saved, downloadable by the owner only', async () => {
  const before = seen.length;
  const r = await post('/api/chat/completions', { accountId: 'anth', model: 'claude-tools', conversationId: CONV, fileTools: true, messages: [{ role: 'user', content: 'make a page' }] });
  const list = events(r.text);
  assert.ok(!list.some((e) => e.type === 'error'), r.text);
  const file = list.find((e) => e.type === 'file')?.file;
  assert.equal(file.path, 'site/index.html');
  assert.ok(list.some((e) => e.type === 'tool' && e.status === 'done' && e.label === '写入 site/index.html'), r.text);
  assert.match(textOf(list), /^Writing the file\.\n\nSaved: OK: site\/index\.html/);
  const second = seen.slice(before).filter((s) => s.body?.model === 'claude-tools')[1].body;
  const assistant = second.messages.at(-2);
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'write it', signature: 'SIG1' });
  assert.deepEqual(assistant.content.at(-1), { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'site/index.html', content: '<h1>你好</h1>' } });
  assert.equal(second.messages.at(-1).content[0].tool_use_id, 'toolu_1');

  const dl = await getRaw(`/api/chat/files/${file.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.toString('utf8'), '<h1>你好</h1>');
  assert.match(dl.headers['content-disposition'], /^attachment; filename="index.html"/);
  assert.match(dl.headers['content-security-policy'], /sandbox/);
  assert.equal((await getRaw(`/api/chat/files/${file.id}`, { cookie: '' })).status, 401);
  assert.equal((await getRaw(`/api/chat/files/${'0'.repeat(32)}`)).status, 404);
  const listed = JSON.parse((await request('GET', `/api/chat/files?conversation=${CONV}`)).text);
  assert.deepEqual(listed.files.map((f) => f.path), ['site/index.html']);
  assert.equal((await post('/api/chat/files/clear', { conversationId: CONV })).status, 200);
  assert.equal((await getRaw(`/api/chat/files/${file.id}`)).status, 404);
});

test('file tools (Chat Completions): streamed tool calls, results as role tool, zip bundle', async () => {
  const conv = '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
  const before = seen.length;
  const r = await post('/api/chat/completions', { accountId: 'acc1', model: 'gpt-tools', conversationId: conv, fileTools: true, messages: [{ role: 'user', content: 'files please' }] });
  const list = events(r.text);
  assert.ok(!list.some((e) => e.type === 'error'), r.text);
  const files = list.filter((e) => e.type === 'file').map((e) => e.file.path);
  assert.deepEqual(files, ['a.txt', 'bundle.zip']);
  const calls = seen.slice(before).filter((s) => s.body?.model === 'gpt-tools').map((s) => s.body);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].tools[0].type, 'function');
  assert.deepEqual(calls[1].messages.at(-2), { role: 'assistant', content: 'ok ', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hello"}' } }] });
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  const zip = list.filter((e) => e.type === 'file')[1].file;
  const body = (await getRaw(`/api/chat/files/${zip.id}`)).body;
  assert.equal(body.readUInt32LE(0), 0x04034b50);
  assert.ok(body.includes(Buffer.from('a.txt')));
});

test('a model that rejects tools is retried without them', async () => {
  const r = await post('/api/chat/completions', { accountId: 'acc1', model: 'no-tools', conversationId: CONV, fileTools: true, messages: [{ role: 'user', content: 'hi' }] });
  const list = events(r.text);
  assert.ok(list.some((e) => e.type === 'notice' && /不支持工具调用/.test(e.message)), r.text);
  assert.equal(textOf(list), 'Hello');
});

test('file store: path rules, quotas and expiry', async () => {
  assert.equal(cleanPath('./a//b/c.txt'), 'a/b/c.txt');
  for (const bad of ['../x', 'a/../b', '', 'a:b', 'x\u0000y']) assert.throws(() => cleanPath(bad));
  const dir = fs.mkdtempSync(path.join(tmp, 'files-'));
  const store = createFileStore({ dir, limits: { fileBytes: 12, userBytes: 15, ttlMs: 50 } });
  await store.write('u1', CONV, 'a.txt', '12345');
  await assert.rejects(store.write('u1', CONV, 'big.txt', '1234567890123'), /不能超过/);
  await assert.rejects(store.write('u1', CONV, 'b.txt', '12345678901'), /上限/);
  const again = createFileStore({ dir });
  assert.equal(again.list('u1', CONV).length, 1, 'reloaded from disk');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.sweep(), 1);
  assert.equal(fs.readdirSync(dir).length, 0);
  store.close(); again.close();
});

test('relay target: paths, versions and whole-endpoint bases', () => {
  assert.equal(relayTarget('https://api.x.com/v1', '/v1/chat/completions?a=1').href, 'https://api.x.com/v1/chat/completions?a=1');
  assert.equal(relayTarget('https://api.x.com/v1', '/chat/completions').href, 'https://api.x.com/v1/chat/completions');
  assert.equal(relayTarget('https://api.anthropic.com/v1/messages', '/v1/messages').href, 'https://api.anthropic.com/v1/messages');
  assert.equal(relayTarget('https://api.x.com', '/v1/models').href, 'https://api.x.com/v1/models');
  assert.equal(relayTarget('https://x.cn/api/paas/v4', '/chat/completions').href, 'https://x.cn/api/paas/v4/chat/completions');
  assert.throws(() => relayTarget('https://127.0.0.1/v1', '/models'));
});

function relayCall(method, route, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: chatPort, method, path: route, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('API relay: own key, upstream key never exposed, rotate and delete', async () => {
  const created = await post('/api/chat/relays', { accountId: 'acc1', name: '测试中转' });
  assert.equal(created.status, 200, created.text);
  const { token, relay, base } = JSON.parse(created.text);
  assert.match(token, /^sk-prism-/);
  assert.equal(base, `${ORIGIN}/chat/relay`);
  assert.ok(!created.text.includes(KEY));
  assert.equal((await post('/api/chat/relays', { accountId: 'g_gopen' })).status, 403);

  // OpenAI-style client, streamed.
  const before = seen.length;
  const r = await relayCall('POST', '/chat/relay/v1/chat/completions', { headers: { authorization: `Bearer ${token}`, cookie: 'should-not-pass=1' }, body: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream: true } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /"content":"Hel"/);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  const hit = seen.slice(before).find((s) => s.path === '/v1/chat/completions');
  assert.equal(hit.auth, `Bearer ${KEY}`);
  assert.ok((await relayCall('GET', '/chat/relay/v1/models', { headers: { authorization: `Bearer ${token}` } })).text.includes('a-model'));
  assert.equal((await relayCall('GET', '/chat/relay/v1/models', { headers: { authorization: 'Bearer sk-prism-wrong' } })).status, 401);
  assert.equal((await relayCall('OPTIONS', '/chat/relay/v1/models')).status, 204);

  // Anthropic-style client: x-api-key in, x-api-key out, /v1 not doubled.
  const anth = JSON.parse((await post('/api/chat/relays', { accountId: 'anthMsg' })).text);
  const a = await relayCall('POST', '/chat/relay/v1/messages', { headers: { 'x-api-key': anth.token, 'anthropic-version': '2023-06-01' }, body: { model: 'claude-x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(a.status, 200, a.text);
  assert.match(a.text, /Hi/);

  const list = JSON.parse((await request('GET', '/api/chat/relays')).text);
  assert.ok(list.relays.find((x) => x.id === relay.id).requests >= 2);
  assert.ok(list.relays.find((x) => x.id === relay.id).canCopy);
  assert.ok(!JSON.stringify(list).includes(KEY) && !JSON.stringify(list).includes(token));
  // The owner can copy the relay key again later, like a saved API key.
  assert.equal(JSON.parse((await post(`/api/chat/relays/${relay.id}/key`, {})).text).value, token);
  assert.equal((await request('POST', `/api/chat/relays/${relay.id}/key`, { body: {}, headers: { origin: ORIGIN } })).status, 403, 'CSRF required');

  const rotated = JSON.parse((await post(`/api/chat/relays/${relay.id}/rotate`, {})).text);
  assert.notEqual(rotated.token, token);
  assert.equal(JSON.parse((await post(`/api/chat/relays/${relay.id}/key`, {})).text).value, rotated.token);
  assert.equal((await relayCall('GET', '/chat/relay/v1/models', { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await relayCall('GET', '/chat/relay/v1/models', { headers: { authorization: `Bearer ${rotated.token}` } })).status, 200);
  await post(`/api/chat/relays/${relay.id}/update`, { enabled: false });
  assert.equal((await relayCall('GET', '/chat/relay/v1/models', { headers: { authorization: `Bearer ${rotated.token}` } })).status, 403);
  await post(`/api/chat/relays/${relay.id}/delete`, {});
  assert.equal((await relayCall('GET', '/chat/relay/v1/models', { headers: { authorization: `Bearer ${rotated.token}` } })).status, 401);
});

test('relay store on disk holds no usable upstream key without the relay key', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'relay-'));
  const serverKey = crypto.randomBytes(32);
  const store = createRelayStore({ dir, key: serverKey });
  const { token, relay } = store.create('u1', { accountId: 'a', name: 'n', host: 'h' }, { baseUrl: 'https://x.com/v1', header: ['Authorization', `Bearer ${KEY}`], key: KEY, custom: false });
  const raw = fs.readFileSync(path.join(dir, 'relays.json'), 'utf8');
  assert.ok(!raw.includes(KEY) && !raw.includes(token) && !raw.includes('x.com/v1'));
  const reloaded = createRelayStore({ dir, key: serverKey });
  assert.equal(reloaded.resolve(token).secret.key, KEY);
  assert.equal(reloaded.token('u1', relay.id), token);
  assert.throws(() => reloaded.token('u2', relay.id), /不存在/);
  assert.throws(() => createRelayStore({ dir, key: crypto.randomBytes(32) }).token('u1', relay.id), /重置密钥/);
  assert.equal(reloaded.resolve(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')), null);
});
