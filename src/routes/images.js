// Image generation jobs. POST /api/chat/images -> {jobId}. Generation continues on
// the server even if the browser disconnects; the page long-polls
// /api/chat/jobs/<id>/events and downloads each finished image from
// /api/chat/jobs/<id>/images/<n>.
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { AppError } from '../vault.js';
import { MAX_BODY, afterParam, closeSignal, json, readBody } from '../http.js';
import { validateImageJob } from '../validate.js';
import { tokenTotals } from '../util.js';
import { decoded, fetchImage, imageRequest, imageResults, isArk, networkError, open, readBuffer, readText, sniffImage, upstreamError } from '../upstream.js';

const MAX_IMAGE_RESPONSE = 64 * 1024 * 1024;

export function createImageRoutes({ accounts, usage, limiter, jobStore, lookup, agent, idleMs }) {
  const maxJobs = limiter.heavyLimit;

  async function start(req, res, cookie, me) {
    if (jobStore.running() >= maxJobs) throw new AppError('BUSY', '同时进行的图片任务过多，请稍等片刻再试', 429);
    if (jobStore.running(me.id) >= maxJobs) throw new AppError('BUSY', '你已有图片正在生成，请等它完成', 429);
    const { input, creds } = await limiter.withHeavy(async () => {
      const checked = validateImageJob(await readBody(req, MAX_BODY));
      // Resolve the key while the user's session cookie is at hand.
      return { input: checked, creds: await accounts.credentials(cookie, checked.accountId, me, 'image', checked.model) };
    });
    const job = jobStore.create(me.id, { model: input.model });
    json(res, 202, { jobId: job.id });
    run(job, input, creds, me).catch(() => { /* reported inside */ });
  }

  async function run(job, input, creds, me) {
    const { account, header } = creds;
    const controller = job.controller;
    const send = (event) => jobStore.push(job, event);
    const began = Date.now();
    let failed = false;
    let produced = 0;
    let usageSeen;
    const sendError = (event) => { failed = true; send(event); };
    try {
      const ark = isArk(account.baseUrl);
      // With reference images: OpenAI-style relays use /images/edits; Ark (and some
      // relays for Seedream/Wan) take an `image` field on /images/generations.
      const modes = !input.images.length ? ['gen'] : ark ? ['gen-ref', 'edit'] : ['edit', 'gen-ref'];
      send({ type: 'start', model: input.model, n: input.n });
      let mode = modes[0];
      let strip = 0;
      const notes = new Set();
      // One upstream call; returns false on a fatal error (already reported).
      const call = async (want) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const r = imageRequest(account.baseUrl, input, { mode, strip, n: want });
          const response = await open(r.url, {
            headers: { [header[0]]: header[1], ...r.headers }, body: r.body, signal: controller.signal, lookup, agent,
            connectTimeoutMs: 360000, idleMs,
          });
          if (response.statusCode >= 200 && response.statusCode < 300) {
            const raw = await readBuffer(decoded(response), MAX_IMAGE_RESPONSE);
            let data;
            try { data = JSON.parse(raw.toString('utf8')); } catch { sendError({ type: 'error', message: '上游返回了无法识别的响应' }); return false; }
            if (data?.error) { sendError({ type: 'error', message: upstreamError(200, JSON.stringify(data)) }); return false; }
            const result = imageResults(data);
            if (result.usage) usageSeen = result.usage;
            for (const note of result.notes) notes.add(note);
            data = null; // let the large JSON be collected before the next download
            for (const item of result.images) {
              if (controller.signal.aborted) return false;
              let image = null;
              if (item.b64) {
                const buffer = Buffer.from(item.b64, 'base64');
                const mime = sniffImage(buffer);
                if (mime) image = { mime, buffer };
                else send({ type: 'notice', message: '上游返回了无法识别的图片数据' });
              } else {
                try { image = await fetchImage(item.url, { lookup, agent, signal: controller.signal }); }
                catch (error) { send({ type: 'notice', message: error instanceof AppError ? error.message : '图片下载失败' }); }
              }
              if (image) { produced++; jobStore.addImage(job, image); }
            }
            return true;
          }
          const text = await readText(decoded(response));
          const unsupported = response.statusCode === 404 || response.statusCode === 405 ||
            (response.statusCode === 400 && /not support|unsupported|不支持|invalid.*(endpoint|url)|unknown.*(endpoint|route)/i.test(text));
          if (unsupported && modes.indexOf(mode) < modes.length - 1) {
            mode = modes[modes.indexOf(mode) + 1];
            send({ type: 'notice', message: `${upstreamError(response.statusCode, text)}。已改用另一种参考图接口重试。` });
            continue;
          }
          if ((response.statusCode === 400 || response.statusCode === 422) && strip < 2) {
            strip++;
            send({ type: 'notice', message: `${upstreamError(response.statusCode, text)}。已去掉${strip === 1 ? '数量、质量等' : '尺寸'}参数重试。` });
            continue;
          }
          sendError({ type: 'error', message: upstreamError(response.statusCode, text) });
          return false;
        }
        sendError({ type: 'error', message: '多次重试后仍未成功' });
        return false;
      };
      let ok = await call(input.n);
      // Some providers ignore `n`; top up with single requests.
      for (let extra = 0; ok && produced > 0 && produced < input.n && extra < input.n; extra++) {
        if (controller.signal.aborted) break;
        ok = await call(1);
      }
      if (ok && !produced) sendError({ type: 'error', message: '上游没有返回图片' });
      for (const note of notes) send({ type: 'notice', message: note });
      if (usageSeen) send({ type: 'usage', usage: usageSeen });
    } catch (error) {
      if (controller.signal.aborted) send({ type: 'notice', message: '已停止生成。' });
      else if (error instanceof AppError) sendError({ type: 'error', message: error.message, code: error.code });
      else sendError({ type: 'error', message: networkError(error) });
    } finally {
      const ms = Date.now() - began;
      send({ type: 'done', ms });
      jobStore.finish(job, controller.signal.aborted ? 'stopped' : failed && !job.files ? 'failed' : 'done');
      // Grants: images that were actually delivered are billed; none delivered = failed (free).
      const status = produced ? (controller.signal.aborted ? 'stopped' : 'completed') : 'failed';
      creds.bill({ status, ...tokenTotals(usageSeen), images: produced, durationMs: ms });
      usage.record({ userId: me.id, kind: 'image', accountId: input.accountId, label: creds.label, model: input.model, status, usage: usageSeen, images: produced, ms });
    }
  }

  // Long-poll: returns events after `after`, waiting up to ~25 s for new ones.
  async function events(req, res, me, id, url) {
    const job = jobStore.get(id, me.id);
    if (!job) throw new AppError('NOT_FOUND', '这次生成的记录已过期或不存在', 404);
    const after = afterParam(url);
    const gone = closeSignal(res);
    await jobStore.wait(job, after, 25000, gone);
    if (gone.aborted) return;
    json(res, 200, { status: job.status, events: job.events.slice(after), next: job.events.length });
  }

  // Serves a finished image; supports Range so a broken download can resume.
  function image(req, res, me, id, index) {
    const job = jobStore.get(id, me.id);
    const found = job && jobStore.image(job, index);
    if (!found) throw new AppError('NOT_FOUND', '图片不存在或已过期', 404);
    let stat;
    try { stat = fs.statSync(found.path); } catch { throw new AppError('NOT_FOUND', '图片不存在或已过期', 404); }
    const headers = { 'Content-Type': found.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400, immutable' };
    let part;
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      part = { start, end };
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    }
    // pipeline: a file removed by the cleanup sweep (or a read error) must end this
    // response, not surface as an unhandled 'error' event that kills the process.
    pipeline(fs.createReadStream(found.path, part), res, () => {});
  }

  function cancel(req, res, me, id) {
    const job = jobStore.get(id, me.id);
    if (!job) throw new AppError('NOT_FOUND', '这次生成的记录已过期或不存在', 404);
    jobStore.cancel(job);
    return json(res, 200, { status: job.status });
  }

  return { start, run, events, image, cancel };
}
