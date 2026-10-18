// PRISM 模型对话 sidecar.
// Runs on loopback behind Caddy. Identity, ownership and key decryption all go
// through Vault.Web using the caller's own session cookie; API keys never reach
// the browser and are never logged or stored here.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, createVaultClient } from './vault.js';
import { safeLookup } from './net.js';
import { json } from './http.js';
import { createGuards } from './guards.js';
import { createLimiter } from './limits.js';
import { createAccounts } from './accounts.js';
import { createJobStore } from './jobs.js';
import { createUsageStore } from './usage.js';
import { loadOrCreateKey } from './util.js';
import { createTraceBank } from './trace/bank.js';
import { createTraceRunner } from './trace/runner.js';
import { createPelicanStore } from './trace/pelican.js';
import { createChatRoutes } from './routes/chat.js';
import { createImageRoutes } from './routes/images.js';
import { createTraceRoutes } from './routes/trace.js';
import { createUsageRoutes } from './routes/usage.js';
import { createFileStore } from './files.js';
import { RELAY_PREFIX, createRelayProxy, createRelayStore } from './relay.js';
import { createFileRoutes, createRelayRoutes } from './routes/files.js';
import { createCodexStore } from './codex/store.js';
import { createCodexAuth } from './codex/auth.js';
import { createCodexKeys } from './codex/keys.js';
import { CODEX_PREFIX, createCodexProxy } from './codex/proxy.js';
import { createCodexRoutes } from './routes/codex.js';

const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// The release directory name (/opt/prism-chat/releases/<name>), shown by /health.
const RELEASE = path.basename(fs.realpathSync(APP_DIR));

// Scripts and styles in public/ are served as /chat/<file>; the main site loads nav.js as /chat-nav.js.
const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ASSETS = { '/chat-nav.js': ['nav.js', ASSET_TYPES['.js']] };
for (const file of fs.readdirSync(PUBLIC_DIR)) {
  const type = ASSET_TYPES[path.extname(file)];
  if (type && file !== 'nav.js') ASSETS[`/chat/${file}`] = [file, type];
}
const PAGES = {
  '/chat': 'index.html', '/chat/': 'index.html',
  '/chat/trace': 'trace.html', '/chat/trace/': 'trace.html',
  '/chat/usage': 'usage.html', '/chat/usage/': 'usage.html',
  '/chat/relays': 'relays.html', '/chat/relays/': 'relays.html',
  '/chat/codex': 'codex.html', '/chat/codex/': 'codex.html',
};
const FILE_ROUTE = /^\/api\/chat\/files\/([a-f0-9]{32})$/;
const CODEX_ACTION = /^\/api\/chat\/codex\/(login\/start|login\/complete|login\/cancel|import|refresh|test|models\/custom|disconnect|keys)$/;
const CODEX_KEY_ROUTE = /^\/api\/chat\/codex\/keys\/([a-f0-9]{16})\/(key|update|delete)$/;
const RELAY_ROUTE = /^\/api\/chat\/relays\/([a-f0-9]{16})\/(update|rotate|delete|key)$/;
const JOB_ROUTE = /^\/api\/chat\/jobs\/([^/]+)\/(events|images\/(\d{1,2})|cancel)$/;

// frame-ancestors 'self': the main site shows these pages inside its workspace (see public/embed.js).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  "font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

const FORBIDDEN_HTML = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>无权访问 · Codex 转发</title><body style="font-family:system-ui,sans-serif;padding:40px;color:#0b0f19">' +
  '<h1 style="font-size:22px">只有管理员可以使用 Codex 转发</h1><p><a href="/" target="_top" style="color:#2563eb">返回首页</a></p></body></html>';

const LOGIN_HTML = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>请先登录 · 模型对话</title><body style="font-family:system-ui,sans-serif;padding:40px;color:#0b0f19">' +
  '<h1 style="font-size:22px">请先登录 API 网站</h1><p>模型对话使用 API 网站的账号和已保存的 API。</p>' +
  '<p><a href="/" target="_top" style="color:#2563eb">前往登录</a></p></body></html>';

export function createChatServer({
  vault = createVaultClient(),
  origin = 'https://qiuzhang.xyz',
  lookup = safeLookup,
  agent,
  csrfKey = crypto.randomBytes(32),
  loopbackOnly = true,
  idleMs = 180000,
  retryDelays, // waits between retries of a busy or dropped upstream (tests shorten them)
  release = RELEASE,
  jobDir = process.env.JOB_DIR || path.join(APP_DIR, '.jobs'),
  jobStore = createJobStore({ dir: jobDir }),
  usage = createUsageStore(), // in memory unless a dir is given (see main below)
  traceBank = createTraceBank({ dir: process.env.TRACE_DIR || null }), // null = bundled bank, no persistence
  traceRunner = createTraceRunner({ bank: () => traceBank.current(), lookup, agent }),
  pelicanStore = createPelicanStore({ dir: process.env.PELICAN_DIR || null, lookup, agent }),
  files = createFileStore(), // in memory unless a dir is given (see main below)
  relays = createRelayStore(),
  codexStore = createCodexStore(), // in memory unless a dir is given (see main below)
  codexConfig = {}, // tests point the OpenAI endpoints at fakes
  codex = createCodexAuth({ store: codexStore, lookup, agent, config: codexConfig }),
  codexKeys = createCodexKeys({ store: codexStore }),
} = {}) {
  const startedAt = Date.now();
  const guards = createGuards({ key: csrfKey, origin });
  const limiter = createLimiter();
  const accounts = createAccounts(vault, { codex });
  const shared = { accounts, usage, limiter, guards, lookup, agent, idleMs, ...(retryDelays ? { retryDelays } : {}) };
  const chat = createChatRoutes({ ...shared, files });
  const fileRoutes = createFileRoutes({ files });
  const relayRoutes = createRelayRoutes({ relays, accounts, origin });
  // Caddy (the only client) appends the caller's address to X-Forwarded-For.
  const clientAddress = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  const relayProxy = createRelayProxy({ store: relays, lookup, agent, clientAddress });
  const codexRoutes = createCodexRoutes({ codex, keys: codexKeys, origin });
  const codexProxy = createCodexProxy({ codex, keys: codexKeys, clientAddress, idleMs });
  const images = createImageRoutes({ ...shared, jobStore });
  const trace = createTraceRoutes({ ...shared, traceBank, traceRunner, pelicanStore });
  const usageSummary = createUsageRoutes(shared);

  function health() {
    const bank = traceBank.current();
    return {
      status: 'ok', release, node: process.version,
      startedAt: new Date(startedAt).toISOString(), uptimeS: Math.round((Date.now() - startedAt) / 1000),
      jobs: jobStore.running(), streams: limiter.streams,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      trace: { bank: bank.origin, sha: bank.source?.sha || null, committedAt: bank.source?.committedAt || null, models: bank.summary.modelCount },
      usageUsers: usage.users,
      files: { count: files.count, mb: Math.round(files.totalBytes / 1048576) },
      relays: relays.count,
      codex: { state: codex.status().state, keys: codexKeys.count },
    };
  }

  async function route(req, res) {
    if (loopbackOnly && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      throw new AppError('FORBIDDEN', '仅允许本机代理', 403);
    }
    const url = new URL(req.url, origin);
    const pathname = url.pathname;
    // API 中转: authenticated by its own key, not by the site session.
    if (pathname.startsWith(RELAY_PREFIX + '/')) return await relayProxy(req, res, url);
    // Codex 转发: the OpenAI-compatible endpoint, authenticated by its own sk-codex key.
    if (pathname.startsWith(CODEX_PREFIX + '/')) return await codexProxy(req, res, url);
    if (req.method === 'GET') {
      // Loopback only (Caddy does not route it): release, bank and load, for deploy checks.
      if (pathname === '/health') return json(res, 200, health());
      // Public liveness for an external monitor: no details, but Vault must answer too.
      if (pathname === '/chat/healthz') {
        const up = await vault.ping();
        return json(res, up ? 200 : 503, { status: up ? 'ok' : 'degraded' });
      }
      if (ASSETS[pathname]) {
        const [file, type] = ASSETS[pathname];
        res.setHeader('Content-Type', type);
        // Pages link versioned URLs (?v=N, bumped on change): those can be cached for good.
        res.setHeader('Cache-Control', url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
        return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
      }
    }
    const cookie = req.headers.cookie || '';
    if (cookie.length > 12000) throw new AppError('UNAUTHORIZED', '请先登录 API 网站', 401);
    const page = PAGES[pathname];
    let me;
    try { me = await vault.me(cookie); }
    catch (error) {
      if (page && error.status === 401) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_HTML);
      }
      throw error;
    }
    if (page) {
      if (req.method !== 'GET') throw new AppError('METHOD', '不支持的请求', 405);
      if (page === 'codex.html' && !me.isAdmin) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(FORBIDDEN_HTML);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, page)));
    }
    if (!pathname.startsWith('/api/chat/')) throw new AppError('NOT_FOUND', '不存在', 404);
    if (pathname.startsWith('/api/chat/trace/')) return await trace(req, res, pathname, url, cookie, me);
    const job = JOB_ROUTE.exec(pathname);
    if (req.method === 'GET') {
      if (job && job[2] === 'events') return await images.events(req, res, me, job[1], url);
      if (job && job[3] !== undefined) return images.image(req, res, me, job[1], Number(job[3]));
      if (pathname === '/api/chat/session') return json(res, 200, { userId: me.id, userName: me.userName, isAdmin: Boolean(me.isAdmin), csrf: guards.tokenFor(cookie) });
      if (pathname === '/api/chat/accounts') return json(res, 200, { accounts: await accounts.list(cookie, me) });
      if (pathname === '/api/chat/usage') return await usageSummary(req, res, url, cookie, me);
      if (pathname === '/api/chat/files') return fileRoutes.list(res, me, url);
      const file = FILE_ROUTE.exec(pathname);
      if (file) return await fileRoutes.download(req, res, me, file[1]);
      if (pathname === '/api/chat/relays') return relayRoutes.list(res, me);
      if (pathname === '/api/chat/codex') return codexRoutes.get(res, me);
      throw new AppError('NOT_FOUND', '不存在', 404);
    }
    if (req.method !== 'POST') throw new AppError('METHOD', '不支持的请求', 405);
    guards.check(req, cookie);
    if (pathname === '/api/chat/models') return await chat.models(req, res, cookie, me);
    if (pathname === '/api/chat/completions') return await chat.completion(req, res, cookie, me);
    if (pathname === '/api/chat/images') return await images.start(req, res, cookie, me);
    if (job && job[2] === 'cancel') return images.cancel(req, res, me, job[1]);
    if (pathname === '/api/chat/files/clear') return await fileRoutes.clear(req, res, me);
    if (pathname === '/api/chat/files/delete') return await fileRoutes.remove(req, res, me);
    const codexAction = CODEX_ACTION.exec(pathname);
    if (codexAction) return await codexRoutes.post(req, res, me, codexAction[1]);
    const codexKey = CODEX_KEY_ROUTE.exec(pathname);
    if (codexKey) return await codexRoutes.keyAction(req, res, me, codexKey[1], codexKey[2]);
    if (pathname === '/api/chat/relays') return await relayRoutes.create(req, res, cookie, me);
    const relayAction = RELAY_ROUTE.exec(pathname);
    if (relayAction) return await relayRoutes.action(req, res, cookie, me, relayAction[1], relayAction[2]);
    throw new AppError('NOT_FOUND', '不存在', 404);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', CSP);
    try {
      await route(req, res);
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.warn(JSON.stringify({ event: 'request_failed', name: error?.name, code: error?.code }));
      if (!res.headersSent) json(res, known ? error.status : 500, { error: known ? error.message : '操作未完成，请稍后重试', code: known ? error.code : 'INTERNAL' });
      else res.end();
    }
  });
  server.codex = codex;
  server.headersTimeout = 15000;
  server.requestTimeout = 0; // streaming replies can be long; idle timeouts are enforced per upstream read
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 4320);
  const origin = process.env.PUBLIC_ORIGIN || 'https://qiuzhang.xyz';
  // systemd's StateDirectory= (/var/lib/prism-chat); a local folder when run by hand.
  const stateDir = (process.env.STATE_DIRECTORY || '').split(':')[0] || path.join(APP_DIR, '.state');
  const log = (event) => console.warn(JSON.stringify(event));
  // Optional: enables admin-granted APIs. Missing/unreadable file = feature off, chat keeps working.
  let bridgeSecret = '';
  const secretFile = process.env.VAULT_BRIDGE_SECRET_FILE;
  if (secretFile) {
    try { bridgeSecret = fs.readFileSync(secretFile, 'utf8').trim(); }
    catch (error) { log({ event: 'bridge_secret_unreadable', code: error?.code }); }
  }
  // Kept across restarts so a deploy does not invalidate the CSRF tokens of open pages.
  let csrfKey;
  try { csrfKey = loadOrCreateKey(path.join(stateDir, 'csrf.key')); }
  catch (error) { log({ event: 'csrf_key_unavailable', code: error?.code }); }
  const vault = createVaultClient({ port: Number(process.env.VAULT_PORT || 5080), publicHost: new URL(origin).host, bridgeSecret });
  const traceBank = createTraceBank({ dir: process.env.TRACE_DIR || path.join(APP_DIR, '.trace') });
  traceBank.start(); // checks GitHub for new fingerprints shortly after boot, then every 6 h
  const usage = createUsageStore({ dir: process.env.USAGE_DIR || path.join(stateDir, 'usage'), log });
  const files = createFileStore({ dir: process.env.FILES_DIR || path.join(stateDir, 'files'), log });
  // Encrypts the stored relay keys; kept apart from relays.json's sealed secrets but in the same private dir.
  const relayDir = path.join(stateDir, 'relay');
  const relays = createRelayStore({ dir: relayDir, key: loadOrCreateKey(path.join(relayDir, 'relay.key')), log });
  // The ChatGPT login and the Codex API keys: one encrypted file, key kept next to it (see codex/store.js).
  const codexDir = process.env.CODEX_DIR || path.join(stateDir, 'codex');
  const codexStore = createCodexStore({ dir: codexDir, key: loadOrCreateKey(path.join(codexDir, 'codex.key')), log });
  const server = createChatServer({ vault, origin, traceBank, usage, files, relays, codexStore, ...(csrfKey ? { csrfKey } : {}) });
  server.codex.start(); // keeps the ChatGPT login refreshed in the background
  server.listen(port, '127.0.0.1', () => console.log(`Prism chat ${RELEASE} listening on 127.0.0.1:${port}`));
  // Long-polls and open streams would otherwise hold shutdown until systemd kills us.
  const stop = () => {
    usage.close();
    relays.close();
    files.close();
    server.codex.close();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
