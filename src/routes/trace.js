// 模型检测 (ModelTrace attribution runs) and the 鹈鹕测试. A test targets either a
// saved API / admin grant (key stays server-side) or a manually entered endpoint
// + key that is used for that run only and never stored.
import { AppError } from '../vault.js';
import { afterParam, closeSignal, json, readBody } from '../http.js';
import { checkId, checkModel, checkTemperature, text } from '../validate.js';
import { isGrant } from '../accounts.js';
import { endpointUrl, fetchModelList } from '../upstream.js';

const TRACE_RUN = /^\/api\/chat\/trace\/runs\/([^/]+)\/(events|cancel)$/;
const PELICAN_JOB = /^\/api\/chat\/trace\/pelican\/([^/]+)(?:\/(cancel|download))?$/;

function manualConnection(b) {
  const baseUrl = text(b.baseUrl, 2000, '接口地址').trim();
  const key = text(b.apiKey, 4000, 'API Key').trim();
  if (!baseUrl) throw new AppError('INVALID', '请填写接口地址', 400);
  if (!key || /[\s\u0000-\u001f\u007f]/.test(key)) throw new AppError('INVALID', '请填写有效的 API Key', 400);
  const host = endpointUrl(baseUrl, '').host; // HTTPS + public-host check
  return { baseUrl, header: ['Authorization', `Bearer ${key}`], rawKey: key, bill: null, host };
}

export function createTraceRoutes({ accounts, usage, guards, traceBank, traceRunner, pelicanStore, lookup, agent }) {
  // connect() is called once per upstream request, so grants are quota-checked
  // by Vault and billed separately for each probe.
  async function connector(b, cookie, me, model) {
    if (b.source === 'manual') {
      const conn = manualConnection(b);
      return { connect: async () => conn, accountId: `manual:${conn.host}`, label: `${conn.host}（临时输入）` };
    }
    const id = checkId(b.accountId);
    const toConn = (c) => (c.codex ? { codex: c.codex, bill: null } : { baseUrl: c.account.baseUrl, header: c.header, rawKey: c.key, bill: isGrant(id) ? c.bill : null });
    const first = await accounts.credentials(cookie, id, me, 'chat', model);
    const label = first.label;
    let fresh = toConn(first);
    if (!isGrant(id)) return { connect: async () => fresh, accountId: id, label };
    return {
      accountId: id, label,
      connect: async () => {
        const conn = fresh || toConn(await accounts.credentials(cookie, id, me, 'chat', model));
        fresh = null;
        return conn;
      },
    };
  }

  // Shared by the fingerprint run and the pelican test: same API sources and options.
  async function traceInput(req, cookie, me, kind) {
    const b = await readBody(req);
    const model = checkModel(b.model);
    const temperature = checkTemperature(b.temperature);
    const apiFormat = b.apiFormat || 'auto';
    if (!['auto', 'openai', 'anthropic'].includes(apiFormat)) throw new AppError('INVALID', '接口格式无效', 400);
    const { connect, accountId, label } = await connector(b, cookie, me, model);
    // Every upstream call shows up on the 用量统计 page.
    const record = ({ status, usage: used, ms }) => usage.record({ userId: me.id, kind, accountId, label, model, status, usage: used, ms });
    return { userId: me.id, model, temperature, apiFormat, connect, record };
  }

  function bankView(me) {
    const { summary } = traceBank.current();
    const s = traceBank.status();
    return {
      ...summary,
      update: {
        intervalHours: s.intervalHours,
        lastCheckAt: s.lastCheckAt,
        lastResult: s.lastResult,
        lastUpdateAt: s.lastUpdateAt,
        lastAdded: s.lastAdded || [],
        checking: s.checking,
        upstreamSha: s.upstreamSha,
        // Algorithm drift and errors only matter to whoever maintains the server.
        ...(me.isAdmin ? { lastError: s.lastError, algorithmChanged: s.algorithmChanged || [] } : {}),
      },
      canCheck: Boolean(me.isAdmin),
    };
  }

  async function runEvents(res, me, id, url) {
    const run = traceRunner.get(id, me.id);
    if (!run) throw new AppError('NOT_FOUND', '这次检测的记录已过期或不存在', 404);
    const after = afterParam(url);
    const gone = closeSignal(res);
    await traceRunner.wait(run, after, 25000, gone);
    if (gone.aborted) return;
    json(res, 200, { status: run.status, events: run.events.slice(after), next: run.events.length });
  }

  function pelicanJob(me, id) {
    const job = pelicanStore.get(id, me.id);
    if (!job) throw new AppError('NOT_FOUND', '这次鹈鹕测试的记录已过期或不存在', 404);
    return job;
  }

  // Long-poll: returns as soon as the job changes (or after 25 s).
  async function pelicanStatus(res, me, id, url) {
    const job = pelicanJob(me, id);
    const raw = url.searchParams.get('version');
    if (raw !== null) {
      const gone = closeSignal(res);
      await pelicanStore.wait(job, Number.parseInt(raw, 10), 25000, gone);
      if (gone.aborted) return;
    }
    json(res, 200, pelicanStore.view(job));
  }

  function pelicanDownload(res, me, id) {
    const job = pelicanStore.get(id, me.id);
    const body = job && pelicanStore.take(job);
    if (!body) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('文件已下载过或已过期（生成 5 分钟后自动删除），请重新测试。');
    }
    const safeModel = job.model.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'model';
    const name = `pelican-${safeModel}-${new Date(job.generatedAt).toISOString().replace(/[-:]/g, '').slice(0, 15)}.html`;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // The model wrote this HTML; never let it run on this origin.
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    // Delete once the whole file has been handed to the client; a dropped download keeps it until expiry.
    res.on('finish', () => pelicanStore.downloaded(job));
    res.end(body);
  }

  return async function handle(req, res, route, url, cookie, me) {
    const run = TRACE_RUN.exec(route);
    const pelican = route === '/api/chat/trace/pelican' ? null : PELICAN_JOB.exec(route);
    if (req.method === 'GET') {
      if (route === '/api/chat/trace/bank') return json(res, 200, bankView(me));
      if (run && run[2] === 'events') return await runEvents(res, me, run[1], url);
      if (pelican && !pelican[2]) return await pelicanStatus(res, me, pelican[1], url);
      if (pelican && pelican[2] === 'download') return pelicanDownload(res, me, pelican[1]);
      throw new AppError('NOT_FOUND', '不存在', 404);
    }
    if (req.method !== 'POST') throw new AppError('METHOD', '不支持的请求', 405);
    guards.check(req, cookie);
    if (route === '/api/chat/trace/runs') {
      const started = traceRunner.start(await traceInput(req, cookie, me, 'trace'));
      return json(res, 202, { runId: started.id });
    }
    if (route === '/api/chat/trace/pelican') {
      const job = pelicanStore.start(await traceInput(req, cookie, me, 'pelican'));
      return json(res, 202, pelicanStore.view(job));
    }
    if (pelican && pelican[2] === 'cancel') {
      const job = pelicanJob(me, pelican[1]);
      pelicanStore.cancel(job);
      return json(res, 200, pelicanStore.view(job));
    }
    if (route === '/api/chat/trace/models') {
      const conn = manualConnection(await readBody(req));
      return json(res, 200, await fetchModelList(conn.baseUrl, conn.header, { key: conn.rawKey, lookup, agent }));
    }
    if (route === '/api/chat/trace/bank/check') {
      if (!me.isAdmin) throw new AppError('FORBIDDEN', '只有管理员可以手动检查更新', 403);
      await traceBank.check();
      return json(res, 200, bankView(me));
    }
    if (run && run[2] === 'cancel') {
      const found = traceRunner.get(run[1], me.id);
      if (!found) throw new AppError('NOT_FOUND', '这次检测的记录已过期或不存在', 404);
      traceRunner.cancel(found);
      return json(res, 200, { status: found.status });
    }
    throw new AppError('NOT_FOUND', '不存在', 404);
  };
}
