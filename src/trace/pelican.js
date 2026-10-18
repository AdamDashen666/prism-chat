// 鹈鹕测试: one fixed single-turn prompt asks the model for an SVG animation of a
// pelican riding a bicycle. The answer is written to a temporary .html file that
// the requesting user can download once; it is deleted right after a completed
// download, or automatically when it expires (5 min after generation).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../vault.js';
import { allowedMaxTokens, isTruncated, unlimitedByDefault } from '../upstream.js';
import { safeLookup } from '../net.js';
import { isUuid, sleep, tokenTotals, waitFor, wake } from '../util.js';
import { ProbeError, completeOnce } from './runner.js';

export const PELICAN_PROMPT = '创建一个HTML，不许查看其他代码文件，内容是SVG绘制一个鹈鹕骑自行车的2D动画，不要有任何限制';
const CALLS = 3; // first try + transient-error retries
const ANTHROPIC_MAX_TOKENS = 32000;
const CHAT_MAX_TOKENS = 32000;

/** Pulls the HTML document out of a chat answer (fenced block, bare document or raw SVG). */
export function extractHtml(text) {
  const raw = String(text || '');
  const blocks = [...raw.matchAll(/```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g)]
    .map((m) => ({ lang: m[1].toLowerCase(), code: m[2] }))
    .filter((b) => /<(svg|html|!doctype)/i.test(b.code));
  let html;
  if (blocks.length) {
    // Prefer an html block, then the longest one (models sometimes add small snippets).
    blocks.sort((a, b) => Number(b.lang === 'html') - Number(a.lang === 'html') || b.code.length - a.code.length);
    html = blocks[0].code;
  } else {
    const start = raw.search(/<!doctype html|<html[\s>]/i);
    if (start >= 0) {
      const end = raw.toLowerCase().lastIndexOf('</html>');
      html = raw.slice(start, end > start ? end + 7 : undefined);
    } else {
      const svg = raw.search(/<svg[\s>]/i);
      html = svg >= 0 ? raw.slice(svg) : raw;
    }
  }
  html = html.trim();
  const hasDocument = /<html[\s>]/i.test(html) || /<!doctype html/i.test(html);
  if (!hasDocument && /<svg[\s>]/i.test(html)) {
    html = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><title>Pelican</title></head>\n<body>\n${html}\n</body>\n</html>`;
  }
  return {
    html,
    checks: {
      svg: /<svg[\s>]/i.test(html),
      animation: /<animate|<animateTransform|<animateMotion|@keyframes|requestAnimationFrame|\.animate\(|setInterval\(/i.test(html),
      complete: /<\/html>\s*$/i.test(html) || (!hasDocument && /<\/svg>/i.test(html)),
      document: hasDocument,
    },
  };
}

/**
 * Pelican jobs. start({ userId, model, temperature, apiFormat, connect, record? }) where
 * connect() resolves { baseUrl, header, rawKey?, bill? } once per upstream call and
 * record({ status, usage, ms }) counts each call for 用量统计.
 */
export function createPelicanStore({
  dir = null, // null = private temp dir created on first use
  lookup = safeLookup, agent, ttlMs = 5 * 60 * 1000, maxRunning = 3, maxPerUser = 1, perHour = 20,
  retryDelayMs = 2000, connectTimeoutMs = 600000, idleMs = 180000, prompt = PELICAN_PROMPT,
} = {}) {
  let ownDir = false;
  const folder = () => {
    if (!dir) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-pelican-')); ownDir = true; }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  // Files from a previous process can never be downloaded (their jobs are gone).
  if (dir) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith('.html')) fs.rmSync(path.join(dir, f), { force: true });
  const jobs = new Map();
  const history = new Map();

  function bump(job) {
    job.version++;
    wake(job);
  }

  function removeFile(job, reason) {
    clearTimeout(job.expiryTimer);
    if (job.file) {
      fs.rm(job.file, { force: true }, () => {});
      job.file = null;
      job.fileState = reason;
      bump(job);
    }
  }

  function sweep() {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.file && now >= job.expiresAt) removeFile(job, 'expired');
      // Keep the finished record a little longer than the file so the page can explain what happened.
      if (job.status !== 'running' && now - job.finishedAt > ttlMs + 10 * 60 * 1000) jobs.delete(job.id);
    }
    for (const [user, list] of history) {
      const recent = list.filter((t) => now - t < 3600 * 1000);
      if (recent.length) history.set(user, recent); else history.delete(user);
    }
  }
  const timer = setInterval(sweep, 30 * 1000);
  timer.unref();

  const running = (userId) => [...jobs.values()].filter((j) => j.status === 'running' && (userId === undefined || j.userId === userId)).length;

  async function call(job, input) {
    let conn;
    const began = Date.now();
    let billed = false;
    const bill = (status, usage) => {
      if (billed) return;
      billed = true;
      const ms = Date.now() - began;
      conn?.bill?.({ status, ...tokenTotals(usage), images: 0, durationMs: ms });
      if (conn) input.record?.({ status, usage, ms });
    };
    let lastBump = 0;
    const onText = (chars) => {
      job.chars = chars;
      const now = Date.now();
      if (now - lastBump > 400) { lastBump = now; bump(job); }
    };
    try {
      conn = await input.connect();
      const opts = { model: input.model, prompt, temperature: input.temperature, signal: job.controller.signal, lookup, agent, idleMs, connectTimeoutMs, allowTruncated: true, onText };
      const anthropic = async () => {
        try {
          return await completeOnce(conn, { ...opts, format: 'anthropic', maxTokens: ANTHROPIC_MAX_TOKENS });
        } catch (error) {
          // Older Claude models cap output lower; the 400 tells us the real limit.
          const cap = error instanceof ProbeError && error.status === 400 ? allowedMaxTokens(error.message, ANTHROPIC_MAX_TOKENS) : undefined;
          if (!cap) throw error;
          return completeOnce(conn, { ...opts, format: 'anthropic', maxTokens: cap });
        }
      };
      // Relays often default Claude-style models to a small max_tokens, which would cut the
      // HTML off. Ask for plenty, then shrink to what the upstream says it allows, or omit it.
      const openai = async () => {
        const first = unlimitedByDefault(input.model) ? undefined : CHAT_MAX_TOKENS;
        try {
          return await completeOnce(conn, { ...opts, format: 'openai', chatMaxTokens: first });
        } catch (error) {
          if (!(first && error instanceof ProbeError && error.status === 400 && /token/i.test(error.message))) throw error;
          return completeOnce(conn, { ...opts, format: 'openai', chatMaxTokens: allowedMaxTokens(error.message, first) });
        }
      };
      let result;
      if (job.format === 'anthropic') result = await anthropic();
      else {
        try {
          result = await openai();
          job.format = 'openai';
        } catch (error) {
          if (!(error instanceof ProbeError && error.unsupported && job.format === 'auto')) throw error;
          result = await anthropic();
          job.format = 'anthropic';
        }
      }
      bill('completed', result.usage);
      return result;
    } catch (error) {
      bill('failed');
      throw error;
    }
  }

  async function execute(job, input) {
    try {
      let result;
      for (let attempt = 1; attempt <= CALLS && !job.controller.signal.aborted; attempt++) {
        job.attempt = attempt;
        job.chars = 0;
        bump(job);
        try {
          result = await call(job, input);
          break;
        } catch (error) {
          if (job.controller.signal.aborted) break;
          const retryable = error instanceof ProbeError && error.retryable;
          job.lastError = error instanceof ProbeError || error instanceof AppError ? error.message : '请求失败';
          if (!retryable || attempt === CALLS) throw error;
          bump(job);
          await sleep(retryDelayMs * attempt, job.controller.signal);
        }
      }
      if (job.controller.signal.aborted || !result) { job.status = 'stopped'; job.error = '已停止'; return; }
      const { html, checks } = extractHtml(result.text);
      if (!html) throw new ProbeError('模型没有返回任何内容');
      const file = path.join(folder(), `${job.id}.html`);
      fs.writeFileSync(file, html, { mode: 0o600 });
      job.file = file;
      job.size = Buffer.byteLength(html);
      job.checks = { ...checks, truncated: isTruncated(result.finish) };
      job.usage = { input: Number(result.usage?.input) || 0, output: Number(result.usage?.output) || 0, reasoning: Number(result.usage?.reasoning) || 0 };
      job.chars = result.text.length;
      job.generatedAt = Date.now();
      job.expiresAt = job.generatedAt + ttlMs;
      job.expiryTimer = setTimeout(() => removeFile(job, 'expired'), ttlMs);
      job.expiryTimer.unref?.();
      job.fileState = 'ready';
      job.status = 'done';
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof ProbeError || error instanceof AppError ? error.message : '生成未完成，请稍后重试';
    } finally {
      job.finishedAt = Date.now();
      job.controller = null;
      bump(job);
    }
  }

  function view(job) {
    return {
      id: job.id, status: job.status, version: job.version, model: job.model, prompt,
      attempt: job.attempt, chars: job.chars, error: job.error || '', lastError: job.lastError || '',
      createdAt: job.createdAt, generatedAt: job.generatedAt || 0, finishedAt: job.finishedAt || 0,
      durationMs: (job.generatedAt || job.finishedAt || Date.now()) - job.createdAt,
      size: job.size || 0, checks: job.checks || null, usage: job.usage || null,
      file: job.fileState || '', expiresAt: job.file ? job.expiresAt : 0, now: Date.now(),
    };
  }

  return {
    get dir() { return dir; },
    start(input) {
      sweep();
      if (running(input.userId) >= maxPerUser) throw new AppError('BUSY', '你已有一个鹈鹕测试正在生成，请等它完成', 429);
      if (running() >= maxRunning) throw new AppError('BUSY', '同时进行的鹈鹕测试过多，请稍后再试', 429);
      const recent = history.get(input.userId) || [];
      if (recent.length >= perHour) throw new AppError('RATE', '鹈鹕测试太频繁，请一小时后再试', 429);
      history.set(input.userId, [...recent, Date.now()]);
      const job = {
        id: crypto.randomUUID(), userId: input.userId, model: input.model, status: 'running', version: 0,
        createdAt: Date.now(), finishedAt: 0, attempt: 0, chars: 0, waiters: new Set(),
        controller: new AbortController(), format: input.apiFormat || 'auto', file: null, fileState: '',
      };
      jobs.set(job.id, job);
      execute(job, input);
      return job;
    },
    get(id, userId) {
      if (!isUuid(id)) return null;
      const job = jobs.get(id);
      return job && job.userId === userId ? job : null;
    },
    view,
    cancel(job) { job.controller?.abort(); },
    wait(job, version, timeoutMs, signal) {
      return waitFor(job, () => job.version !== version, timeoutMs, signal);
    },
    /** Reads the file for download; returns null when it is gone. */
    take(job) {
      if (!job.file || Date.now() >= job.expiresAt) { removeFile(job, 'expired'); return null; }
      try { return fs.readFileSync(job.file); } catch { job.file = null; job.fileState = 'expired'; return null; }
    },
    /** Called once the download response has been fully sent. */
    downloaded(job) { removeFile(job, 'downloaded'); },
    running,
    close() {
      clearInterval(timer);
      for (const job of jobs.values()) { job.controller?.abort(); removeFile(job, 'expired'); }
      if (dir && ownDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
