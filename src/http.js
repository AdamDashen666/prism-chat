// HTTP plumbing shared by the routes: JSON replies, bounded body reads, the
// NDJSON event stream used for chat replies, and long-poll cancellation.
import { AppError } from './vault.js';

export const MAX_BODY = 22 * 1024 * 1024; // chat history and image jobs carry images
export const SMALL_BODY = 64 * 1024; // every other JSON request

export function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

export async function readBody(req, limit = SMALL_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('TOO_LARGE', limit >= MAX_BODY ? '对话内容过长，请新建对话或删减历史' : '请求内容过大', 413);
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new AppError('INVALID_JSON', '请求格式错误', 400); }
}

// NDJSON event stream to the browser, with heartbeats so proxies keep it open.
export function eventStream(res) {
  let started = false;
  const send = (event) => {
    if (!started) {
      started = true;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    }
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
  heartbeat.unref();
  return { send, stop: () => { clearInterval(heartbeat); if (!started) send({ type: 'error', message: '请求未完成' }); res.end(); } };
}

/** Aborts when the client goes away, so a long-poll can stop waiting. */
export function closeSignal(res) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  return controller.signal;
}

export function afterParam(url) {
  return Math.max(0, Number.parseInt(url.searchParams.get('after') || '0', 10) || 0);
}
