// One-click ModelTrace run. Each probe prompt is handled by its own independent
// agent: a fresh single-turn conversation (no shared history, no system prompt)
// with its own retries and its own replacement prompt. Agents run in parallel;
// the valid outputs are then scored against the active fingerprint bank.
import crypto from 'node:crypto';
import { AppError } from '../vault.js';
import { ANTHROPIC_VERSION, decoded, endpointUrl, isTruncated, networkError, normalize, normalizeWhole, open, readText, sseEvents, upstreamError } from '../upstream.js';
import { safeLookup } from '../net.js';
import { DEFAULT_INSTRUCTIONS } from '../codex/translate.js';
import { isUuid, sleep, tokenTotals, waitFor, wake } from '../util.js';
import { analyzeGlobalOutputs, parseNumbers } from './fingerprint-core.js';
import { generateChallenges, minimumNumbers } from './challenges.js';

export const AGENTS = 3;
const PROMPTS_PER_AGENT = 2; // first prompt + one fresh replacement if the answer is unusable
const CALLS_PER_AGENT = 4; // includes transient-error retries
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const MAX_OUTPUT = 512 * 1024;

function anthropicUrl(baseUrl) {
  const base = endpointUrl(baseUrl, '').href.replace(/\/+$/, '');
  if (/\/messages$/.test(base)) return new URL(base);
  return new URL(/\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`);
}

/** Anthropic Messages SSE payload -> normalized events (same shape as upstream.normalize). */
export function anthropicEvents(p) {
  const out = [];
  if (p?.type === 'error' || p?.error) {
    out.push({ type: 'error', message: `上游错误：${String(p.error?.message || p.message || '生成失败').slice(0, 600)}` });
  } else if (p?.type === 'message_start' && p.message?.usage) {
    out.push({ type: 'usage', usage: { input: p.message.usage.input_tokens, output: p.message.usage.output_tokens } });
  } else if (p?.type === 'content_block_delta' && p.delta?.type === 'text_delta' && typeof p.delta.text === 'string') {
    out.push({ type: 'delta', text: p.delta.text });
  } else if (p?.type === 'message_delta') {
    if (p.usage) out.push({ type: 'usage', usage: { output: p.usage.output_tokens, ...(p.usage.input_tokens != null ? { input: p.usage.input_tokens } : {}) } });
    if (p.delta?.stop_reason) out.push({ type: 'finish', reason: p.delta.stop_reason });
  }
  return out;
}

export class ProbeError extends Error {
  constructor(message, { status = 0, retryable = false, unsupported = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.unsupported = unsupported;
  }
}

/**
 * One upstream call. Returns { text, usage, finish }.
 * allowTruncated: return length-limited answers instead of throwing (finish tells the caller).
 * onText(length): called as streamed text arrives.
 */
export async function completeOnce(conn, {
  format, model, prompt, temperature, signal, lookup = safeLookup, agent, idleMs = 180000,
  maxTokens = 4096, chatMaxTokens, connectTimeoutMs = 240000, allowTruncated = false, onText,
}) {
  const [name, value] = conn.header || [];
  let url;
  let body;
  const headers = name ? { [name]: value } : {};
  if (conn.codex) {
    // Codex 转发: a Responses request on the ChatGPT backend (no temperature or token limits there).
    body = { model, instructions: DEFAULT_INSTRUCTIONS, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }], store: false, stream: true };
  } else if (format === 'anthropic') {
    url = anthropicUrl(conn.baseUrl);
    // Streamed: a non-streaming call sends no bytes until the whole answer is done, and
    // Cloudflare-fronted relays cut such requests after ~120 s (HTTP 524).
    body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], stream: true };
    const key = conn.rawKey || (/^Bearer\s+(.+)$/i.exec(value)?.[1] ?? '');
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    headers.accept = 'text/event-stream, application/json';
  } else {
    url = endpointUrl(conn.baseUrl, '/chat/completions');
    body = { model, messages: [{ role: 'user', content: prompt }], stream: true };
    if (Number.isInteger(chatMaxTokens)) body.max_tokens = chatMaxTokens;
  }
  if (Number.isFinite(temperature) && !conn.codex) body.temperature = temperature;
  let response;
  try {
    response = conn.codex
      ? await conn.codex.backend('/responses', { body: Buffer.from(JSON.stringify(body)), signal, idleMs, headers: { accept: 'text/event-stream', session_id: crypto.randomUUID() } })
      : await open(url, { headers, body, signal, lookup, agent, connectTimeoutMs, idleMs });
  } catch (error) {
    if (signal?.aborted) throw new ProbeError('已停止');
    if (error instanceof AppError) throw new ProbeError(error.message);
    throw new ProbeError(networkError(error), { retryable: error?.code !== 'NON_PUBLIC_ADDRESS' });
  }
  const status = response.statusCode;
  if (status < 200 || status >= 300) {
    const text = await readText(decoded(response));
    const unsupported = status === 404 || status === 405 ||
      (status === 400 && /not support|unsupported|unknown.*(endpoint|url|route)|invalid.*(endpoint|url)/i.test(text));
    throw new ProbeError(upstreamError(status, text), { status, retryable: RETRYABLE.has(status), unsupported });
  }
  let text = '';
  let usage;
  let finish = '';
  const take = (events) => {
    for (const e of events) {
      if (e.type === 'delta') { text += e.text; if (text.length > MAX_OUTPUT) throw new ProbeError('回答过长'); onText?.(text.length); }
      else if (e.type === 'usage') usage = e.usage;
      else if (e.type === 'finish') finish = e.reason;
      else if (e.type === 'error') throw new ProbeError(e.message);
    }
  };
  try {
    const type = String(response.headers['content-type'] || '');
    // Some relays ignore `stream` and answer with one JSON body; both shapes are accepted.
    if (type.includes('application/json')) {
      const raw = await readText(decoded(response), MAX_OUTPUT);
      let data;
      try { data = JSON.parse(raw); } catch { throw new ProbeError('上游返回了无法识别的响应'); }
      if (format === 'anthropic') {
        if (!Array.isArray(data?.content)) throw new ProbeError(data?.error?.message ? `上游错误：${data.error.message}` : '上游返回了无法识别的响应');
        text = data.content.filter((b) => b?.type === 'text').map((b) => String(b.text || '')).join('');
        finish = data.stop_reason || '';
        if (data.usage) usage = { input: data.usage.input_tokens, output: data.usage.output_tokens };
      } else take(normalizeWhole(conn.codex ? 'responses' : 'chat', data));
    } else {
      const parse = conn.codex ? (payload) => normalize('responses', payload) : format === 'anthropic' ? anthropicEvents : (payload) => normalize('chat', payload);
      for await (const payload of sseEvents(decoded(response), idleMs)) {
        if (payload === '[DONE]') break;
        take(parse(payload));
        if (signal?.aborted) break;
      }
    }
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (signal?.aborted) throw new ProbeError('已停止');
    throw new ProbeError(networkError(error), { retryable: true });
  }
  if (finish === 'refusal') throw new ProbeError('模型拒绝生成，本次回答不计入');
  if (finish === 'content_filter' || (isTruncated(finish) && !allowTruncated)) {
    throw new ProbeError(`回答未正常完成（${finish}），本次回答不计入`);
  }
  return { text, usage, finish };
}

/**
 * bank(): returns { bank, summary } of the active fingerprint bank.
 * Run input: { userId, model, temperature, apiFormat: 'auto'|'openai'|'anthropic', connect, record? }
 * connect(): Promise<{ baseUrl, header, rawKey?, bill(record) }> — called once per upstream
 * call so admin grants are quota-checked and billed per request.
 * record({ status, usage, ms }): optional, called once per upstream call (用量统计).
 */
export function createTraceRunner({ bank, lookup = safeLookup, agent, maxRunning = 3, maxPerUser = 1, perHour = 30, ttlMs = 3600 * 1000, retryDelayMs = 1500 } = {}) {
  const runs = new Map();
  const history = new Map(); // userId -> start timestamps (last hour)

  function sweep() {
    const now = Date.now();
    for (const run of runs.values()) if (run.status !== 'running' && now - run.finishedAt > ttlMs) runs.delete(run.id);
    for (const [user, list] of history) {
      const recent = list.filter((t) => now - t < 3600 * 1000);
      if (recent.length) history.set(user, recent); else history.delete(user);
    }
  }
  const timer = setInterval(sweep, 5 * 60 * 1000);
  timer.unref();

  const running = (userId) => [...runs.values()].filter((r) => r.status === 'running' && (userId === undefined || r.userId === userId)).length;

  function push(run, event) {
    run.events.push({ seq: run.events.length, at: Date.now(), ...event });
    wake(run);
  }

  async function runAgent(run, index, input) {
    const prompts = generateChallenges(PROMPTS_PER_AGENT);
    let promptIndex = 0;
    let calls = 0;
    const agentEvent = (state, extra = {}) => push(run, { type: 'agent', index, state, attempt: promptIndex + 1, calls, ...extra });
    while (promptIndex < prompts.length && calls < CALLS_PER_AGENT && !run.controller.signal.aborted) {
      const challenge = prompts[promptIndex];
      calls++;
      agentEvent('working', { expected: challenge.expected_count });
      const began = Date.now();
      let conn;
      let billed = false;
      const bill = (status, usage) => {
        if (billed) return;
        billed = true;
        const ms = Date.now() - began;
        conn?.bill?.({ status, ...tokenTotals(usage), images: 0, durationMs: ms });
        if (conn) input.record?.({ status, usage, ms });
      };
      try {
        conn = await input.connect();
        let format = run.format;
        let result;
        try {
          result = await completeOnce(conn, { format: format === 'anthropic' ? 'anthropic' : 'openai', model: input.model, prompt: challenge.prompt, temperature: input.temperature, signal: run.controller.signal, lookup, agent });
        } catch (error) {
          // Auto mode: an endpoint that does not speak Chat Completions gets one Anthropic Messages try.
          if (!(error instanceof ProbeError && error.unsupported && format === 'auto')) throw error;
          result = await completeOnce(conn, { format: 'anthropic', model: input.model, prompt: challenge.prompt, temperature: input.temperature, signal: run.controller.signal, lookup, agent });
          format = 'anthropic';
        }
        if (run.format === 'auto') run.format = format === 'anthropic' ? 'anthropic' : 'openai';
        const parsed = parseNumbers(result.text).length;
        const minimum = minimumNumbers(challenge.expected_count);
        bill('completed', result.usage);
        if (parsed >= minimum) {
          agentEvent('done', { parsed, minimum, expected: challenge.expected_count, preview: result.text.slice(0, 4000), ms: Date.now() - began });
          return { text: result.text, expected_count: challenge.expected_count };
        }
        agentEvent('invalid', { parsed, minimum, expected: challenge.expected_count, preview: result.text.slice(0, 4000), message: `有效数字 ${parsed}/${minimum}，换一条新提示词重试` });
        promptIndex++;
      } catch (error) {
        bill('failed');
        if (run.controller.signal.aborted) break;
        const message = error instanceof ProbeError || error instanceof AppError ? error.message : '请求失败';
        // Bad key, unknown model, no balance, quota: retrying with another prompt cannot help.
        const fatal = error instanceof AppError || (error instanceof ProbeError && [400, 401, 402, 403, 404, 422].includes(error.status));
        agentEvent('error', { message });
        if (fatal) { run.fatal ||= message; break; }
        if (!(error instanceof ProbeError && error.retryable)) promptIndex++;
        await sleep(retryDelayMs * calls, run.controller.signal);
      }
    }
    agentEvent(run.controller.signal.aborted ? 'stopped' : 'failed');
    return null;
  }

  async function execute(run, input) {
    try {
      const active = bank();
      push(run, { type: 'start', model: input.model, agents: AGENTS, bank: { models: active.summary.modelCount, sha: active.summary.source?.sha || null } });
      // A fatal error (bad key, quota) in one agent stops the others early.
      const outputs = await Promise.all(Array.from({ length: AGENTS }, (_, i) => runAgent(run, i, input).then((r) => {
        if (!r && run.fatal) run.controller.abort();
        return r;
      })));
      const valid = outputs.filter(Boolean);
      if (run.stopRequested) { push(run, { type: 'error', message: '已停止检测' }); run.status = 'stopped'; return; }
      if (!valid.length) {
        push(run, { type: 'error', message: run.fatal ? `检测失败：${run.fatal}` : '三个独立智能体都没有拿到可用回答，无法归因' });
        run.status = 'failed';
        return;
      }
      const scored = analyzeGlobalOutputs(valid, active.bank);
      push(run, {
        type: 'result',
        result: {
          prediction: scored.prediction,
          predictionName: scored.prediction_name,
          probability: scored.probability,
          familyName: scored.family_prediction_name,
          familyProbability: scored.family_probability,
          families: scored.family_probabilities.map((f) => ({ name: f.display_name, probability: f.probability })),
          usedOutputs: scored.used_outputs,
          cvAccuracy: scored.calibration.cv_accuracy,
          results: scored.results.map((r) => ({ id: r.model, name: r.display_name, family: r.family_name, probability: r.probability, similarity: r.profile_similarity })),
        },
        bank: { models: active.summary.modelCount, sha: active.summary.source?.sha || null, committedAt: active.summary.source?.committedAt || null },
      });
      run.status = 'done';
    } catch (error) {
      push(run, { type: 'error', message: error instanceof AppError ? error.message : '检测未完成，请稍后重试' });
      run.status = 'failed';
    } finally {
      run.finishedAt = Date.now();
      push(run, { type: 'done', ms: run.finishedAt - run.createdAt });
      run.controller = null;
    }
  }

  return {
    start(input) {
      sweep();
      if (running(input.userId) >= maxPerUser) throw new AppError('BUSY', '你已有一个检测正在进行，请等它完成', 429);
      if (running() >= maxRunning) throw new AppError('BUSY', '同时进行的检测过多，请稍后再试', 429);
      const recent = history.get(input.userId) || [];
      if (recent.length >= perHour) throw new AppError('RATE', '检测太频繁，请一小时后再试', 429);
      history.set(input.userId, [...recent, Date.now()]);
      const run = {
        id: crypto.randomUUID(), userId: input.userId, status: 'running', createdAt: Date.now(), finishedAt: 0,
        events: [], waiters: new Set(), controller: new AbortController(), format: input.apiFormat || 'auto', fatal: '', stopRequested: false,
      };
      runs.set(run.id, run);
      execute(run, input);
      return run;
    },
    get(id, userId) {
      if (!isUuid(id)) return null;
      const run = runs.get(id);
      return run && run.userId === userId ? run : null;
    },
    cancel(run) {
      if (run.status !== 'running') return;
      run.stopRequested = true;
      run.controller?.abort();
    },
    wait(run, after, timeoutMs, signal) {
      return waitFor(run, () => run.events.length > after || run.status !== 'running', timeoutMs, signal);
    },
    running,
    close() { clearInterval(timer); for (const run of runs.values()) run.controller?.abort(); },
  };
}
