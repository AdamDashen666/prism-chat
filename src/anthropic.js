// Native Anthropic Messages API (/v1/messages) for 模型对话: request bodies,
// header choice, step-by-step downgrades after a 400, and stream parsing.
// The OpenAI-compatible endpoint of Anthropic never returns thinking and does
// not support prompt caching, so Claude models go through here when possible.
import { ANTHROPIC_VERSION, AUTO_MAX_TOKENS, CONTEXT_ERROR, allowedMaxTokens, endpointUrl, learnedCap } from './upstream.js';

// Effort levels the Messages API accepts in output_config.effort.
const EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
// Models without adaptive thinking (Claude 4.5 and older) take a fixed budget instead.
const BUDGETS = { minimal: 2048, low: 4096, medium: 8192, high: 16000, xhigh: 24000, max: 32000 };

export const isOfficialAnthropic = (baseUrl) => {
  try { return /(^|\.)anthropic\.com$/i.test(new URL(baseUrl).hostname); } catch { return false; }
};

/** <base>/v1/messages, accepting bases saved with or without /v1 or as the whole endpoint. */
export function anthropicMessagesUrl(baseUrl) {
  const root = endpointUrl(baseUrl, '');
  const path = root.pathname.replace(/\/+$/, '').replace(/\/(messages|chat\/completions)$/i, '');
  const url = new URL(root);
  url.pathname = /\/v1$/i.test(path) ? `${path}/messages` : `${path}/v1/messages`;
  return url;
}

/**
 * Anthropic itself treats a Bearer token as OAuth, so it only gets x-api-key.
 * Relays get their configured header too (new-api style relays accept either).
 */
export function anthropicHeaders(baseUrl, header, key) {
  const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, accept: 'text/event-stream, application/json' };
  if (!isOfficialAnthropic(baseUrl) && header?.[0] && header[0].toLowerCase() !== 'x-api-key') headers[header[0]] = header[1];
  return headers;
}

const userEffort = (input) => Boolean(input.effort && input.effort !== 'none');

/**
 * First attempt for this request. `traits` is what earlier 400s taught us about
 * this API + model (Set of 'noAdaptive', 'noBudget', 'noDisplay', 'noEffort',
 * 'noTemperature', 'noCache'); `cap` is a learned max_tokens (0 = unknown).
 */
export function anthropicOptions(input, traits = new Set(), cap = 0) {
  const auto = !Number.isInteger(input.maxTokens);
  let thinking = 'off';
  // Default lets the model decide (adaptive); Off sends nothing, so models where
  // thinking is optional stay without it.
  if (input.effort !== 'none') {
    if (!traits.has('noAdaptive')) thinking = 'adaptive';
    else if (userEffort(input) && !traits.has('noBudget')) thinking = 'budget';
  }
  return {
    auto,
    maxTokens: auto ? (cap > 0 ? cap : AUTO_MAX_TOKENS) : input.maxTokens,
    thinking,
    display: !traits.has('noDisplay'),
    effort: userEffort(input) && !traits.has('noEffort') && thinking === 'adaptive',
    temperature: Number.isFinite(input.temperature) && !traits.has('noTemperature'),
    cache: !traits.has('noCache'),
    tools: Boolean(input.tools?.length) && !traits.has('noTools'),
    eager: !traits.has('noEager'),
  };
}

function contentOf(m) {
  // Anthropic rejects empty or whitespace-only text blocks.
  const text = m.content && m.content.trim() ? m.content : '';
  if (!m.images?.length) return text || '…';
  const parts = m.images.map((url) => {
    const [, mime, data] = /^data:([^;]+);base64,(.*)$/s.exec(url) || [];
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  });
  return text ? [...parts, { type: 'text', text }] : parts;
}

export function anthropicPayload(input, opts) {
  const messages = [];
  for (const m of input.messages) {
    const content = contentOf(m);
    const last = messages.at(-1);
    // Consecutive turns of one role are merged; the API wants them alternating.
    if (last?.role === m.role) {
      const asParts = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
      last.content = [...asParts(last.content), ...asParts(content)];
    } else messages.push({ role: m.role, content });
  }
  // Native turns of the current tool loop / resumed reply, replayed unchanged.
  if (input.extra?.length) messages.push(...input.extra);
  const body = { model: input.model, max_tokens: opts.maxTokens, messages, stream: true };
  if (input.system) body.system = input.system;
  if (opts.tools) {
    // eager_input_streaming: a long file body streams as it is written instead of
    // arriving in one burst minutes later (the route shows progress meanwhile).
    body.tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...(opts.eager ? { eager_input_streaming: true } : {}) }));
  }
  // Automatic caching: the breakpoint follows the end of the conversation, so each
  // turn reads the history the previous turn wrote.
  if (opts.cache) body.cache_control = { type: 'ephemeral' };
  if (opts.thinking === 'adaptive') {
    // display defaults to "omitted" on newer models: without it the thinking text is empty.
    body.thinking = opts.display ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
  } else if (opts.thinking === 'budget') {
    const budget = Math.min(BUDGETS[input.effort] || 8192, opts.maxTokens - 1024);
    if (budget >= 1024) body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  if (opts.effort && EFFORT_MAP[input.effort]) body.output_config = { effort: EFFORT_MAP[input.effort] };
  if (opts.temperature) body.temperature = Math.min(1, input.temperature);
  return body;
}

/**
 * After a 400/413/422: the next options to try, or null when nothing can be
 * changed. Returns { opts, trait?, cap?, notice? }. A level the user picked is
 * kept: it moves from effort to a thinking budget rather than disappearing.
 */
export function adjustAnthropic(input, opts, text) {
  const t = String(text || '');
  const next = (patch, extra = {}) => ({ opts: { ...opts, ...patch }, ...extra });
  if (opts.auto && /max_tokens/i.test(t) && !CONTEXT_ERROR.test(t)) {
    const allowed = allowedMaxTokens(t, opts.maxTokens);
    if (allowed) return next({ maxTokens: allowed }, { cap: learnedCap(t, allowed) });
  }
  if (opts.thinking === 'adaptive' && /adaptive/i.test(t)) {
    return next({ thinking: userEffort(input) ? 'budget' : 'off', effort: false }, { trait: 'noAdaptive' });
  }
  if (opts.thinking === 'budget' && /budget_tokens|thinking\.type\.enabled|"enabled"/i.test(t)) {
    return next({ thinking: 'off' }, { trait: 'noBudget', notice: '这个模型不接受思考参数，本次未开启思考。' });
  }
  if (opts.display && opts.thinking === 'adaptive' && /display/i.test(t)) return next({ display: false }, { trait: 'noDisplay' });
  if (opts.effort && /effort|output_config/i.test(t)) {
    return next({ effort: false, thinking: 'budget' }, { trait: 'noEffort' });
  }
  if (opts.temperature && /temperature|top_p|top_k|sampling/i.test(t)) {
    return next({ temperature: false }, { trait: 'noTemperature', notice: '这个模型不接受温度参数，已按默认值生成。' });
  }
  if (opts.cache && /cache_control/i.test(t)) return next({ cache: false }, { trait: 'noCache' });
  if (opts.tools && opts.eager && /eager_input_streaming/i.test(t)) return next({ eager: false }, { trait: 'noEager' });
  if (opts.tools && /\btools?\b|tool_use|input_schema|function/i.test(t)) {
    return next({ tools: false }, { trait: 'noTools', notice: '这个模型或中转站不支持工具调用，本次没有启用文件工具。' });
  }
  // A relay that rejects thinking outright for a model it treats as non-thinking.
  if (opts.thinking !== 'off' && !userEffort(input) && /thinking|reasoning/i.test(t)) {
    return next({ thinking: 'off', effort: false }, { trait: opts.thinking === 'adaptive' ? 'noAdaptive' : 'noBudget' });
  }
  return null;
}

/** True when an error body is Anthropic-shaped ({type:"error", error:{type, message}}). */
export function isAnthropicError(text) {
  try {
    const data = JSON.parse(text);
    return data?.type === 'error' && typeof data.error?.type === 'string';
  } catch { return false; }
}

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'max_tokens', tool_use: 'tool_calls' };

/** Anthropic usage -> normalized usage. `input` is the whole prompt, cache included. */
export function anthropicUsage(u, prev = {}) {
  if (!u) return prev;
  const pick = (k) => (u[k] != null ? Number(u[k]) : prev[k]);
  const raw = { input_tokens: pick('input_tokens'), cache_read_input_tokens: pick('cache_read_input_tokens'), cache_creation_input_tokens: pick('cache_creation_input_tokens'), output_tokens: pick('output_tokens') };
  return { ...raw, thinking_tokens: u.output_tokens_details?.thinking_tokens ?? prev.thinking_tokens };
}

function normalizedUsage(raw) {
  const cacheRead = raw.cache_read_input_tokens || 0;
  const cacheWrite = raw.cache_creation_input_tokens || 0;
  const out = { input: (raw.input_tokens || 0) + cacheRead + cacheWrite, output: raw.output_tokens };
  if (raw.thinking_tokens) out.reasoning = raw.thinking_tokens;
  if (cacheRead) out.cacheRead = cacheRead;
  if (cacheWrite) out.cacheWrite = cacheWrite;
  return out;
}

/**
 * Stateful SSE parser: returns (payload) => normalized events. It also keeps the
 * assistant content blocks (thinking with signatures, text, tool_use) so a tool
 * loop can replay the turn unchanged: `parse.content()` / `parse.partial()`.
 * Finished tool calls come out as { type: 'tool_call', id, name, input | error };
 * a growing tool input as { type: 'tool_input', id, name, chars }.
 */
export function anthropicStream() {
  let usage = {};
  let thoughts = 0; // thinking blocks seen, to separate them
  const blocks = []; // by index
  const parse = (p) => {
    const out = [];
    const t = p?.type;
    if (t === 'error' || (p?.error && !t)) {
      out.push({ type: 'error', message: `上游错误：${String(p.error?.message || p.message || '生成失败').slice(0, 600)}`, errorType: p.error?.type || '' });
    } else if (t === 'message_start') {
      usage = anthropicUsage(p.message?.usage, usage);
      if (p.message?.usage) out.push({ type: 'usage', usage: normalizedUsage(usage) });
    } else if (t === 'content_block_start') {
      const b = p.content_block;
      const i = Number.isInteger(p.index) ? p.index : blocks.length;
      if (b?.type === 'thinking') {
        blocks[i] = { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' };
        if (thoughts++ > 0) out.push({ type: 'reasoning', text: '\n\n' });
        if (b.thinking) out.push({ type: 'reasoning', text: b.thinking });
      } else if (b?.type === 'text') {
        blocks[i] = { type: 'text', text: b.text || '' };
        if (b.text) out.push({ type: 'delta', text: b.text });
      } else if (b?.type === 'tool_use') {
        blocks[i] = { type: 'tool_use', id: b.id, name: b.name, json: '', input: b.input && Object.keys(b.input).length ? b.input : null };
        out.push({ type: 'tool_input', id: b.id, name: b.name, chars: 0 });
      } else if (b && typeof b.type === 'string') blocks[i] = { ...b }; // redacted_thinking and others: replay as-is
    } else if (t === 'content_block_delta') {
      const d = p.delta;
      const b = blocks[p.index];
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        if (b?.type === 'text') b.text += d.text;
        out.push({ type: 'delta', text: d.text });
      } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
        if (b?.type === 'thinking') b.thinking += d.thinking;
        out.push({ type: 'reasoning', text: d.thinking });
      } else if (d?.type === 'signature_delta' && b?.type === 'thinking') b.signature += d.signature || '';
      else if (d?.type === 'input_json_delta' && b?.type === 'tool_use') {
        b.json += d.partial_json || '';
        out.push({ type: 'tool_input', id: b.id, name: b.name, chars: b.json.length });
      }
    } else if (t === 'content_block_stop') {
      const b = blocks[p.index];
      if (b?.type === 'tool_use') {
        if (b.json) {
          try { b.input = JSON.parse(b.json); } catch { b.bad = true; }
        } else if (!b.input) b.input = {};
        if (!b.bad && (!b.input || typeof b.input !== 'object' || Array.isArray(b.input))) b.bad = true;
        out.push(b.bad ? { type: 'tool_call', id: b.id, name: b.name, error: 'invalid JSON arguments' } : { type: 'tool_call', id: b.id, name: b.name, input: b.input });
      }
    } else if (t === 'message_delta') {
      // message_delta usage is cumulative.
      if (p.usage) { usage = anthropicUsage(p.usage, usage); out.push({ type: 'usage', usage: normalizedUsage(usage) }); }
      if (p.delta?.stop_reason) out.push({ type: 'finish', reason: FINISH[p.delta.stop_reason] || p.delta.stop_reason });
    }
    return out;
  };
  const clean = (b) => {
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.bad ? {} : b.input || {} };
    return b;
  };
  /** The finished turn as an assistant message content array (empty text blocks dropped). */
  // A thinking block without its signature (some relays strip it) cannot be replayed.
  parse.content = () => blocks.filter((b) => b && !(b.type === 'text' && !b.text.trim()) && !(b.type === 'thinking' && !b.signature)).map(clean);
  /** Text written so far, for resuming an interrupted reply. */
  parse.text = () => blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  return parse;
}

/** A non-streaming Message (some relays ignore stream:true). The array also carries `.content` for replay. */
export function anthropicWhole(data) {
  const out = [];
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let thoughts = 0;
  for (const b of blocks) {
    if (b?.type === 'thinking' && b.thinking) out.push({ type: 'reasoning', text: (thoughts++ ? '\n\n' : '') + b.thinking });
    else if (b?.type === 'text' && b.text) out.push({ type: 'delta', text: b.text });
    else if (b?.type === 'tool_use') {
      const ok = b.input && typeof b.input === 'object' && !Array.isArray(b.input);
      out.push(ok ? { type: 'tool_call', id: b.id, name: b.name, input: b.input } : { type: 'tool_call', id: b.id, name: b.name, error: 'invalid arguments' });
    }
  }
  if (data?.usage) out.push({ type: 'usage', usage: normalizedUsage(anthropicUsage(data.usage)) });
  out.push({ type: 'finish', reason: FINISH[data?.stop_reason] || data?.stop_reason || 'stop' });
  out.content = blocks.filter((b) => b && !(b.type === 'text' && !String(b.text || '').trim()) && !(b.type === 'thinking' && !b.signature));
  return out;
}
