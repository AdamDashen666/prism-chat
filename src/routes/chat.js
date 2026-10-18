// 模型对话: model lists and streamed chat completions. One completion can span
// several upstream requests ("turns"): file-tool calls are run here and their
// results sent back, a busy upstream (429/5xx/529 Overloaded) is retried, and a
// reply cut off mid-stream is continued from where it stopped.
import crypto from 'node:crypto';
import { AppError } from '../vault.js';
import { MAX_BODY, eventStream, json, readBody } from '../http.js';
import { validateChat } from '../validate.js';
import { sleep, tokenTotals } from '../util.js';
import {
  AUTO_MAX_TOKENS, allowedMaxTokens, autoMaxTokens, buildPayload, decoded, endpointUrl, fetchImage, fetchModelList,
  inlineImageFilter, learnedCap, networkError, normalize, normalizeWhole, open, parseDataImage, readText, sseEvents,
  thinkTagFilter, toDataUrl, toolCallCollector, toolResultMessages, upstreamError,
} from '../upstream.js';
import {
  adjustAnthropic, anthropicHeaders, anthropicMessagesUrl, anthropicOptions, anthropicPayload, anthropicStream,
  anthropicWhole, isAnthropicError, isOfficialAnthropic,
} from '../anthropic.js';
import { FILE_TOOLS, parseArgs, runFileTool, toolLabel } from '../tools.js';
import { appChatToResponses } from '../codex/translate.js';

const MAX_IMAGE_RESPONSE = 64 * 1024 * 1024;
const EFFORT_NAMES = { none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
// A relay without /v1/messages answers like this; Chat Completions is tried instead (auto mode only).
const NO_MESSAGES_ENDPOINT = [404, 405, 415, 501];
const effortNote = (input) => `（思考强度：${EFFORT_NAMES[input.effort] || input.effort}。这个模型或中转站可能不支持该档位，可换一档或选“默认”后重试）`;

// Busy/transient answers worth retrying before anything was streamed. 524 is not
// here: the relay already waited ~120 s and may have billed the attempt.
const RETRY_STATUS = [408, 429, 500, 502, 503, 504, 529];
export const RETRY_DELAYS = [2000, 5000, 10000, 20000];
// An error event inside the stream that is worth continuing after.
const RETRY_STREAM = /overloaded|api_error|rate_limit|timeout|temporarily|try again|internal server error|server_error|upstream connect|stream.*(closed|interrupted)/i;
const MAX_RESUMES = 3; // continuations after mid-stream failures, per completion
const MAX_TOOL_STEPS = 30; // tool rounds per completion
const RESUME_PROMPT = '（系统提示：你上一条回复在生成过程中因上游错误中断了。请从中断处直接接着写，不要重复已经写过的内容，不要加开场白或解释；如果中断在代码块里，就直接续写代码。）';

// What the user can change when a relay times out before the model starts answering.
function timeoutAdvice(input) {
  const tips = [];
  if (input.effort && input.effort !== 'none') tips.push('调低思考强度');
  // Chat Completions sends nothing while GPT-style models reason; Responses streams reasoning summaries right away.
  if (input.apiType !== 'responses' && /^(gpt-|o\d|codex|chatgpt)/i.test(input.model)) tips.push('在高级设置里把接口类型改为 Responses（会边思考边返回摘要，不容易被断开）');
  tips.push('稍后重试或换一个 API');
  return `可以${tips.join('、')}。被断开的请求在中转站那边可能仍会计费。`;
}

/** Delay before retry `attempt` (0-based), honouring a short Retry-After. */
function retryDelay(attempt, response, delays = RETRY_DELAYS) {
  const after = Number(response?.headers?.['retry-after']);
  if (Number.isFinite(after) && after > 0 && after <= 30) return after * 1000;
  return delays[Math.min(attempt, delays.length - 1)];
}

const statusName = (status, text) => (status === 529 || /overloaded/i.test(text) ? 'Overloaded' : status === 429 ? '请求过于频繁' : `HTTP ${status}`);

/** Rough output tokens for a turn that was cut off before the upstream reported usage. */
const estimateTokens = (chars) => Math.ceil(chars / 3);

function addUsage(total, u) {
  if (!u) return total;
  const out = { ...total };
  for (const k of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
    if (u[k] != null) out[k] = (out[k] || 0) + Number(u[k]);
  }
  return out;
}

export function createChatRoutes({ accounts, usage, limiter, lookup, agent, idleMs, files, retryDelays = RETRY_DELAYS }) {
  // API + model -> largest max_tokens the upstream accepted (0 = must omit it).
  const learnedCaps = new Map();
  // API + model -> 'anthropic' | 'chat' once auto mode has found out which works.
  const learnedFormats = new Map();
  // API + model -> Set of Anthropic parameters it rejected (see anthropic.js).
  const learnedTraits = new Map();
  // API + model (Chat Completions / Responses) that rejected the tools parameter.
  const noTools = new Set();
  const remember = (map, key, value) => {
    if (map.size > 500) map.delete(map.keys().next().value);
    map.set(key, value);
  };
  const rememberCap = (key, value) => remember(learnedCaps, key, value);

  function formatFor(input, account, capKey) {
    if (input.apiType !== 'auto') return input.apiType;
    if (isOfficialAnthropic(account.baseUrl)) return 'anthropic';
    return learnedFormats.get(capKey) || (/claude/i.test(input.model) ? 'anthropic' : 'chat');
  }

  /**
   * Native Messages request with step-by-step downgrades after a 400. Resolves
   * { response } on 2xx, otherwise { status, text } for the caller to report.
   */
  async function anthropicRequest(input, creds, capKey, signal, send) {
    const { account, header, key } = creds;
    const url = anthropicMessagesUrl(account.baseUrl);
    const headers = anthropicHeaders(account.baseUrl, header, key);
    const traits = learnedTraits.get(capKey) || new Set();
    let opts = anthropicOptions(input, traits, learnedCaps.get(capKey) || 0);
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      const response = await open(url, { headers, body: anthropicPayload(input, opts), signal, lookup, agent, connectTimeoutMs: 180000, idleMs });
      const status = response.statusCode;
      if (status >= 200 && status < 300) return { response, tools: opts.tools };
      const text = await readText(decoded(response));
      if (RETRY_STATUS.includes(status) && retries < retryDelays.length && !signal.aborted) {
        const wait = retryDelay(retries++, response, retryDelays);
        send({ type: 'notice', message: `上游繁忙（${statusName(status, text)}），${Math.round(wait / 1000)} 秒后自动重试（第 ${retries} 次）…`, transient: true });
        await sleep(wait, signal);
        if (signal.aborted) throw new Error('ABORTED');
        continue;
      }
      const change = attempt < 10 && [400, 413, 422].includes(status) ? adjustAnthropic(input, opts, text) : null;
      if (!change) return { status, text };
      if (change.trait) { traits.add(change.trait); remember(learnedTraits, capKey, traits); }
      if (change.cap !== undefined) rememberCap(capKey, change.cap);
      if (change.notice) send({ type: 'notice', message: change.notice });
      opts = change.opts;
    }
  }

  /**
   * Chat Completions / Responses request. Default output is "unlimited": ask for
   * a huge max_tokens, shrink it to whatever the upstream says is allowed
   * (remembered per API + model), or drop it silently. Only then fall back to
   * stripping optional params. Resolves { response } or { error } (already worded).
   */
  async function openaiRequest(input, format, creds, capKey, signal, send) {
    const { account, header } = creds;
    const url = endpointUrl(account.baseUrl, format === 'responses' ? '/responses' : '/chat/completions');
    let autoCap = autoMaxTokens({ ...input, apiType: format }) ? (learnedCaps.get(capKey) ?? AUTO_MAX_TOKENS) : undefined;
    let level = autoCap ? 0 : 1;
    let shrinks = 0;
    let retries = 0;
    let tools = input.tools?.length && !noTools.has(capKey) ? input.tools : undefined;
    while (true) {
      const payloadInput = { ...input, apiType: format, tools };
      const response = await open(url, { headers: { [header[0]]: header[1] }, body: buildPayload(payloadInput, level, autoCap), signal, lookup, agent, connectTimeoutMs: 180000, idleMs });
      const code = response.statusCode;
      if (code >= 200 && code < 300) return { response, tools: Boolean(tools) };
      if (RETRY_STATUS.includes(code) && retries < retryDelays.length && !signal.aborted) {
        const text = await readText(decoded(response));
        // 429 from a credit/quota check is final; only "slow down" style answers are retried.
        if (code !== 429 || !/quota|insufficient|balance|余额|额度/i.test(text)) {
          const wait = retryDelay(retries++, response, retryDelays);
          send({ type: 'notice', message: `上游繁忙（${statusName(code, text)}），${Math.round(wait / 1000)} 秒后自动重试（第 ${retries} 次）…`, transient: true });
          await sleep(wait, signal);
          if (signal.aborted) throw new Error('ABORTED');
          continue;
        }
        return { error: upstreamError(code, text) };
      }
      // 402: credit-reserving relays (OpenRouter style) reject large caps
      // based on balance; shrink for this request but do not remember it.
      if (level === 0 && [400, 402, 413, 422].includes(code)) {
        const text = await readText(decoded(response));
        if (tools && code === 400 && /\btools?\b|function|tool_choice/i.test(text) && !/max_tokens/i.test(text)) {
          tools = undefined;
          noTools.add(capKey);
          send({ type: 'notice', message: '这个模型或中转站不支持工具调用，本次没有启用文件工具。' });
          continue;
        }
        const next = shrinks < 2 ? allowedMaxTokens(text, autoCap) : undefined;
        if (code === 402 && !next) return { error: upstreamError(code, text) };
        // Only a limit of the model itself is remembered: a context overflow
        // depends on this request's input and must not cap everyone's replies.
        const lasting = code === 402 ? undefined : learnedCap(text, next);
        if (lasting !== undefined) rememberCap(capKey, lasting);
        if (next) { autoCap = next; shrinks++; } else level = 1;
        continue;
      }
      if (code === 400 && level >= 1) {
        const text = await readText(decoded(response));
        if (tools && /\btools?\b|function|tool_choice/i.test(text)) {
          tools = undefined;
          noTools.add(capKey);
          send({ type: 'notice', message: '这个模型或中转站不支持工具调用，本次没有启用文件工具。' });
          continue;
        }
        if (level >= 2) return { error: upstreamError(400, text) };
        // A chosen thinking level is never dropped behind the user's back: report the failure instead.
        if (input.effort) return { error: upstreamError(400, text) + effortNote(input) };
        level = 2;
        send({ type: 'notice', message: `${upstreamError(400, text)}。已去掉温度等可选参数重试。` });
        continue;
      }
      const text = await readText(decoded(response));
      let message = upstreamError(code, text);
      if (code === 524) message += timeoutAdvice(input);
      return { error: message };
    }
  }

  /**
   * Codex 转发: the ChatGPT backend only takes streaming, stateless Responses requests. Same
   * busy-upstream retries as the other APIs, except a used-up plan (429 usage limit) is final.
   * Resolves { response } or { error } (already worded).
   */
  async function codexRequest(codex, input, signal, send) {
    const body = Buffer.from(JSON.stringify(appChatToResponses(input)));
    let retries = 0;
    while (true) {
      let response;
      try {
        response = await codex.backend('/responses', { body, signal, idleMs, headers: { accept: 'text/event-stream', session_id: input.conversationId || crypto.randomUUID() } });
      } catch (error) {
        if (error instanceof AppError) return { error: error.message };
        throw error;
      }
      const status = response.statusCode;
      if (status >= 200 && status < 300) return { response };
      const text = await readText(decoded(response));
      const usedUp = status === 429 && /usage_limit|limit has been reached|resets_in/i.test(text);
      if (RETRY_STATUS.includes(status) && !usedUp && retries < retryDelays.length && !signal.aborted) {
        const wait = retryDelay(retries++, response, retryDelays);
        send({ type: 'notice', message: `上游繁忙（${statusName(status, text)}），${Math.round(wait / 1000)} 秒后自动重试（第 ${retries} 次）…`, transient: true });
        await sleep(wait, signal);
        if (signal.aborted) throw new Error('ABORTED');
        continue;
      }
      let message = upstreamError(status, text);
      if (status === 400 && input.effort && input.effort !== 'none') message += effortNote(input);
      if (usedUp) message += '。这是 ChatGPT 订阅的用量限制，等额度重置后再试';
      return { error: message };
    }
  }

  async function models(req, res, cookie, me) {
    const b = await readBody(req);
    const creds = await accounts.credentials(cookie, b.accountId, me, 'models');
    if (creds.codex) {
      const list = await creds.codex.modelList();
      const shown = list.items.filter((m) => m.visible !== false);
      return json(res, 200, { models: (shown.length ? shown : list.items).map((m) => m.id), kinds: {}, allowCustom: true });
    }
    const { account, header, key } = creds;
    // A model-restricted grant offers exactly its list (no upstream call, no custom IDs).
    if (account.allowedModels?.length) {
      return json(res, 200, { models: account.allowedModels, kinds: {}, allowCustom: false });
    }
    return json(res, 200, await fetchModelList(account.baseUrl, header, { key, lookup, agent }));
  }

  // Remote image URLs are fetched here so the page CSP can stay img-src 'self' data: blob:.
  async function imageEvent(url, signal) {
    if (/^data:image\//i.test(url)) {
      const image = parseDataImage(url);
      return image ? { type: 'image', url: toDataUrl(image) } : { type: 'notice', message: '上游返回了无法识别的图片数据' };
    }
    try { return { type: 'image', url: toDataUrl(await fetchImage(url, { lookup, agent, signal })) }; }
    catch (error) { return { type: 'notice', message: error instanceof AppError ? error.message : '图片下载失败' }; }
  }

  async function completion(req, res, cookie, me) {
    const { controller, release } = limiter.acquire(req, res, me);
    let input;
    try { input = validateChat(await readBody(req, MAX_BODY)); }
    catch (error) { release(); throw error; }
    const { send, stop } = eventStream(res);
    const signal = controller.signal;

    const began = Date.now();
    // Grant billing: only requests the upstream accepted (2xx) count; errors are reported as failed.
    let creds = null;
    let total = {}; // usage summed over every turn
    let answered = false;
    let completed = false;
    try {
      creds = await accounts.credentials(cookie, input.accountId, me, 'chat', input.model);
      const { account } = creds;
      const capKey = `${account.baseUrl}\n${input.model}`;
      let format = creds.codex ? 'responses' : formatFor(input, account, capKey);
      const toolsWanted = Boolean(files && input.fileTools);
      const base = { ...input, tools: toolsWanted ? FILE_TOOLS : undefined, extra: [] };
      send({ type: 'start', model: input.model, tools: toolsWanted });

      let firstToken = 0;
      let lastText = ''; // tail of the text sent so far, to separate turns
      let finish;
      let resumes = 0;
      let joinNext = false; // the next turn continues a cut-off reply: no paragraph break
      let steps = 0;
      const forward = async (e) => {
        if (!firstToken && (e.type === 'delta' || e.type === 'reasoning' || e.type === 'image')) { firstToken = Date.now(); send({ type: 'first', ms: firstToken - began }); }
        if (e.type === 'delta') lastText = (lastText + e.text).slice(-4);
        send(e.type === 'image' ? await imageEvent(e.url, signal) : e);
      };

      for (let turn = 0; ; turn++) {
        // ---- open the request (retries and parameter downgrades happen inside) ----
        let response;
        let toolsOn = false;
        if (creds.codex) {
          const result = await codexRequest(creds.codex, base, signal, send);
          if (result.error) { send({ type: 'error', message: result.error }); return; }
          response = result.response;
          toolsOn = Boolean(base.tools);
        } else if (format === 'anthropic') {
          const result = await anthropicRequest(base, creds, capKey, signal, send);
          const html = result.response && /text\/html/i.test(String(result.response.headers['content-type'] || ''));
          if (result.response && !html) {
            response = result.response;
            toolsOn = result.tools;
            if (input.apiType === 'auto') remember(learnedFormats, capKey, 'anthropic');
          } else if (turn === 0 && input.apiType === 'auto' && !isOfficialAnthropic(account.baseUrl) &&
            (html || NO_MESSAGES_ENDPOINT.includes(result.status) || ([400, 401, 403, 422].includes(result.status) && !isAnthropicError(result.text)))) {
            // This relay has no native Messages endpoint: use Chat Completions from now on.
            result.response?.resume();
            remember(learnedFormats, capKey, 'chat');
            format = 'chat';
          } else {
            let message = upstreamError(result.status, result.text);
            if (result.status === 400 && input.effort && input.effort !== 'none') message += effortNote(input);
            if (result.status === 524) message += timeoutAdvice(input);
            send({ type: 'error', message });
            return;
          }
        }
        if (!response) {
          const result = await openaiRequest(base, format, creds, capKey, signal, send);
          if (result.error) { send({ type: 'error', message: result.error }); return; }
          response = result.response;
          toolsOn = result.tools;
        }
        answered = true;

        // ---- read the turn ----
        const filter = inlineImageFilter();
        // Inline <think> tags only matter for Chat Completions answers.
        const thinkTags = format === 'chat' ? thinkTagFilter() : null;
        const collector = format === 'anthropic' ? null : toolCallCollector(format);
        const parse = format === 'anthropic' ? anthropicStream() : (payload) => normalize(format, payload);
        const calls = [];
        let turnText = '';
        let turnChars = 0;
        let turnUsage;
        let turnFinish;
        let streamError = null;
        let wholeContent = null;
        let separated = turn === 0 || !lastText || joinNext;
        joinNext = false;
        const progress = new Map(); // tool id -> last progress sent (ms)
        const text = async (parts) => {
          for (const part of parts) {
            if (part.type === 'reasoning') { turnChars += part.text.length; await forward(part); continue; }
            for (const x of filter.push(part.text)) {
              if (x.type === 'delta') {
                // A new turn after tool calls starts on its own paragraph.
                if (!separated) { separated = true; if (!/\n\s*$/.test(lastText)) await forward({ type: 'delta', text: '\n\n' }); }
                turnText += x.text;
                turnChars += x.text.length;
              }
              await forward(x);
            }
          }
        };
        const flushText = async () => {
          if (thinkTags) await text(thinkTags.flush());
          for (const x of filter.flush()) {
            if (x.type === 'delta') turnText += x.text;
            await forward(x);
          }
        };
        const emit = async (e) => {
          switch (e.type) {
            case 'usage': turnUsage = e.usage; send({ type: 'usage', usage: addUsage(total, e.usage) }); return;
            case 'finish': turnFinish = e.reason; return;
            case 'error': streamError = e; return;
            case 'tool_call': calls.push(e); return;
            case 'tool_input': {
              const now = Date.now();
              if (now - (progress.get(e.id) || 0) < 700 && e.chars) return;
              progress.set(e.id, now);
              send({ type: 'tool', id: e.id, name: e.name, status: 'input', chars: e.chars, label: toolLabel(e.name) });
              return;
            }
            case 'delta': await text(thinkTags ? thinkTags.push(e.text) : [e]); return;
            default: await forward(e);
          }
        };
        try {
          const type = String(response.headers['content-type'] || '');
          if (type.includes('application/json')) {
            const body = await readText(decoded(response), MAX_IMAGE_RESPONSE);
            let data;
            try { data = JSON.parse(body); } catch { send({ type: 'error', message: '上游返回了无法识别的响应' }); return; }
            if (format === 'anthropic') {
              const list = anthropicWhole(data);
              wholeContent = list.content;
              for (const e of list) await emit(e);
            } else {
              for (const e of collector.push(data)) await emit(e);
              for (const e of normalizeWhole(format, data)) await emit(e);
            }
          } else {
            for await (const payload of sseEvents(decoded(response), idleMs)) {
              if (payload === '[DONE]') break;
              if (collector) for (const e of collector.push(payload)) await emit(e);
              for (const e of parse(payload)) await emit(e);
              if (signal.aborted || streamError) break;
            }
          }
        } catch (error) {
          if (signal.aborted) throw error;
          // The connection dropped or went silent mid-reply.
          streamError = { type: 'error', message: networkError(error), errorType: 'network' };
        }
        if (streamError) response.destroy?.();
        await flushText();
        if (collector) {
          for (const c of collector.calls()) {
            const parsed = parseArgs(c.args);
            calls.push(parsed.error ? { id: c.id, name: c.name, error: parsed.error } : { id: c.id, name: c.name, input: parsed.args });
          }
        }
        if ((streamError || !turnUsage?.output) && turnChars) turnUsage = { ...(turnUsage || {}), output: Math.max(turnUsage?.output || 0, estimateTokens(turnChars)) };
        total = addUsage(total, turnUsage);
        if (turnUsage) send({ type: 'usage', usage: total });
        if (signal.aborted) break;

        // ---- a reply cut off mid-stream: continue it (or retry if nothing came yet) ----
        if (streamError) {
          const retryable = streamError.errorType === 'network' || RETRY_STREAM.test(`${streamError.errorType} ${streamError.message}`);
          if (!retryable || resumes >= MAX_RESUMES) { send({ type: 'error', message: streamError.message }); return; }
          resumes++;
          const partial = format === 'anthropic' ? parse.text() : turnText;
          const wait = retryDelays[Math.min(resumes - 1, retryDelays.length - 1)];
          send({
            type: 'notice', transient: true,
            message: `${streamError.message.replace(/^上游错误：/, '上游中断：')}。${partial.trim() ? '正在从断点续写' : '正在重试'}（第 ${resumes} 次）…`,
          });
          if (partial.trim()) {
            base.extra.push(
              format === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: partial }] } : { role: 'assistant', content: partial },
              { role: 'user', content: RESUME_PROMPT },
            );
            joinNext = true;
          }
          await sleep(wait, signal);
          if (signal.aborted) break;
          continue;
        }

        // ---- tool calls: run them, send the results back, next turn ----
        if (calls.length && toolsOn && steps < MAX_TOOL_STEPS) {
          steps++;
          const assistant = format === 'anthropic'
            ? [{ role: 'assistant', content: wholeContent || parse.content() }]
            : collector.replay(turnText);
          const results = [];
          for (const call of calls) {
            const parsed = call.error ? { error: call.error } : { args: call.input };
            const label = toolLabel(call.name, parsed.args || {});
            send({ type: 'tool', id: call.id, name: call.name, status: 'running', label });
            const result = parsed.error
              ? { output: `Error: ${parsed.error}`, summary: '参数不是有效的 JSON（可能被输出上限截断）', error: true }
              : await runFileTool(files, me.id, input.conversationId, call.name, parsed.args);
            send({ type: 'tool', id: call.id, name: call.name, status: result.error ? 'error' : 'done', label, summary: result.summary });
            if (result.file) send({ type: 'file', file: result.file });
            if (result.removed) send({ type: 'file_removed', path: result.removed });
            results.push({ id: call.id, output: result.output, error: result.error });
          }
          base.extra.push(...assistant, ...toolResultMessages(format, results));
          separated = false;
          continue;
        }
        if (calls.length && toolsOn) send({ type: 'notice', message: `工具调用已达到单次回复上限（${MAX_TOOL_STEPS} 轮），已停止。` });
        finish = turnFinish;
        break;
      }
      send({ type: 'finish', reason: finish || (signal.aborted ? 'stopped' : 'stop') });
      completed = !signal.aborted;
      send({ type: 'done', ms: Date.now() - began });
    } catch (error) {
      if (error instanceof AppError) send({ type: 'error', message: error.message, code: error.code });
      else if (!signal.aborted) send({ type: 'error', message: networkError(error) });
    } finally {
      stop();
      release();
      if (creds) {
        const status = completed ? 'completed' : answered ? 'stopped' : 'failed';
        const ms = Date.now() - began;
        const seen = Object.keys(total).length ? total : undefined;
        creds.bill({ status, ...tokenTotals(seen), images: 0, durationMs: ms });
        usage.record({ userId: me.id, kind: 'chat', accountId: input.accountId, label: creds.label, model: input.model, status, usage: seen, ms });
      }
    }
  }

  return { models, completion };
}
