// OpenAI-compatible wire formats on top of the Codex backend, which only speaks the
// (streaming, stateless) Responses API: Chat Completions requests are converted to
// Responses requests, and Responses events back into Chat Completions chunks.
import crypto from 'node:crypto';
import { AppError } from '../vault.js';

export const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

// Parameters the Codex backend does not accept; they are dropped instead of failing the request.
const CHAT_DROPPED = ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'logit_bias',
  'logprobs', 'top_logprobs', 'stop', 'metadata', 'user', 'service_tier', 'store', 'modalities', 'audio', 'prediction', 'safety_identifier'];
const RESPONSES_DROPPED = ['max_output_tokens', 'max_tokens', 'temperature', 'top_p', 'metadata', 'user', 'service_tier', 'background', 'truncation', 'safety_identifier', 'top_logprobs'];

const bad = (message) => new AppError('INVALID_REQUEST', message, 400);
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text' ? p.text || '' : '')).join('');
};

function userParts(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') parts.push({ type: 'input_text', text: p });
    else if (p?.type === 'text' || p?.type === 'input_text') parts.push({ type: 'input_text', text: String(p.text ?? '') });
    else if (p?.type === 'image_url' || p?.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (!url) throw bad('image_url 缺少 url');
      parts.push({ type: 'input_image', image_url: url, ...(p.image_url?.detail ? { detail: p.image_url.detail } : {}) });
    } else throw bad(`不支持的内容类型：${p?.type}（Codex 只接受文本和图片）`);
  }
  return parts;
}

/**
 * Chat Completions request -> { request (Responses body), stream (what the client
 * asked for), includeUsage, dropped (names of ignored parameters) }.
 */
export function chatToResponses(body) {
  if (!body || typeof body !== 'object') throw bad('请求体必须是 JSON 对象');
  if (typeof body.model !== 'string' || !body.model) throw bad('缺少 model');
  if (!Array.isArray(body.messages) || !body.messages.length) throw bad('messages 不能为空');
  if (body.n !== undefined && Number(body.n) !== 1) throw bad('Codex 只支持 n=1');
  const instructions = [];
  const input = [];
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') throw bad('messages 里有无效的消息');
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOf(m.content);
      if (t) instructions.push(t);
    } else if (m.role === 'user') {
      const content = userParts(m.content);
      if (content.length) input.push({ type: 'message', role: 'user', content });
    } else if (m.role === 'assistant') {
      const t = textOf(m.content);
      if (t) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (call?.type && call.type !== 'function') continue;
        input.push({ type: 'function_call', call_id: String(call.id || `call_${crypto.randomBytes(6).toString('hex')}`), name: String(call.function?.name || ''), arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}) });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(m.tool_call_id || ''), output: typeof m.content === 'string' ? m.content : textOf(m.content) });
    } else throw bad(`不支持的消息角色：${m.role}`);
  }
  if (!input.length) throw bad('messages 里没有 user 消息');
  const request = { model: body.model, instructions: instructions.join('\n\n') || DEFAULT_INSTRUCTIONS, input, store: false, stream: true };

  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t?.type === 'function' && t.function?.name);
  if (tools.length) {
    request.tools = tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} }, strict: t.function.strict === true }));
    const c = body.tool_choice;
    if (typeof c === 'string') request.tool_choice = c;
    else if (c?.type === 'function' && c.function?.name) request.tool_choice = { type: 'function', name: c.function.name };
    if (typeof body.parallel_tool_calls === 'boolean') request.parallel_tool_calls = body.parallel_tool_calls;
  }
  const effort = body.reasoning_effort || body.reasoning?.effort;
  if (effort) request.reasoning = { effort, summary: body.reasoning?.summary || 'auto' };
  const text = {};
  const rf = body.response_format;
  if (rf?.type === 'json_schema' && rf.json_schema) text.format = { type: 'json_schema', name: rf.json_schema.name || 'response', schema: rf.json_schema.schema || {}, strict: rf.json_schema.strict === true };
  else if (rf?.type === 'json_object') text.format = { type: 'json_object' };
  if (body.verbosity) text.verbosity = body.verbosity;
  if (Object.keys(text).length) request.text = text;
  if (typeof body.prompt_cache_key === 'string') request.prompt_cache_key = body.prompt_cache_key;
  return { request, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, dropped: CHAT_DROPPED.filter((k) => body[k] !== undefined) };
}

/** A Responses request from a client, made acceptable to the Codex backend. */
export function normalizeResponses(body) {
  if (!body || typeof body !== 'object') throw bad('请求体必须是 JSON 对象');
  if (typeof body.model !== 'string' || !body.model) throw bad('缺少 model');
  if (body.previous_response_id) throw bad('Codex 转发是无状态的，不支持 previous_response_id，请在 input 里带上完整对话');
  const request = { ...body };
  const dropped = RESPONSES_DROPPED.filter((k) => request[k] !== undefined);
  for (const k of dropped) delete request[k];
  if (typeof request.input === 'string') request.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.input }] }];
  if (!Array.isArray(request.input) || !request.input.length) throw bad('缺少 input');
  if (typeof request.instructions !== 'string' || !request.instructions.trim()) request.instructions = DEFAULT_INSTRUCTIONS;
  request.store = false;
  const stream = body.stream === true;
  request.stream = true;
  return { request, stream, dropped };
}

/**
 * The chat page's request (history with images, system prompt, file tools, tool-loop
 * turns in `extra`) as a Responses request for the Codex backend. The backend takes no
 * temperature or token limits, and thinking cannot be switched off, so those are left out.
 */
export function appChatToResponses(input) {
  const messages = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  for (const m of input.messages) {
    if (m.role === 'user' && m.images?.length) {
      messages.push({ role: 'user', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    } else messages.push({ role: m.role, content: m.content });
  }
  const tools = (input.tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const { request } = chatToResponses({
    model: input.model, messages, ...(tools.length ? { tools } : {}),
    ...(input.effort && input.effort !== 'none' ? { reasoning_effort: input.effort } : {}),
  });
  // Turns after the history (tool calls and results, a resumed reply) arrive as plain items; the backend wants typed messages.
  for (const item of input.extra || []) {
    request.input.push(item.type || typeof item.content !== 'string'
      ? item
      : { type: 'message', role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }] });
  }
  return request;
}

const FINISH_FROM_INCOMPLETE = { max_output_tokens: 'length', content_filter: 'content_filter' };

export function chatUsage(u) {
  if (!u) return undefined;
  const cached = u.input_tokens_details?.cached_tokens;
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  return {
    prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    ...(cached != null ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning != null ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

/**
 * Feeds Responses events (parsed JSON payloads) and yields Chat Completions
 * chunks. It also keeps the whole answer, so `completion()` can answer a client
 * that did not ask for streaming.
 */
export function createChatTranslator({ model, includeUsage = false, now = () => Math.floor(Date.now() / 1000) }) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = now();
  const calls = []; // { id, name, args, index }
  const byItem = new Map(); // output item id -> call
  let roleSent = false;
  let text = '';
  let reasoning = '';
  let finish = '';
  let usage;
  let failed = null;
  let reasoningParts = 0;
  const chunk = (delta, finishReason = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const withRole = (delta) => { if (!roleSent) { roleSent = true; return { role: 'assistant', ...delta }; } return delta; };

  function push(e) {
    const out = [];
    switch (e?.type) {
      case 'response.output_item.added':
        if (e.item?.type === 'function_call') {
          const call = { id: e.item.call_id || e.item.id, name: e.item.name || '', args: e.item.arguments || '', index: calls.length };
          calls.push(call);
          byItem.set(e.item.id || call.id, call);
          out.push(chunk(withRole({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] })));
        }
        break;
      case 'response.output_text.delta':
        if (typeof e.delta === 'string' && e.delta) { text += e.delta; out.push(chunk(withRole({ content: e.delta }))); }
        break;
      case 'response.reasoning_summary_part.added':
        if (reasoningParts++ > 0 && reasoning) { reasoning += '\n\n'; out.push(chunk(withRole({ reasoning_content: '\n\n' }))); }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof e.delta === 'string' && e.delta) { reasoning += e.delta; out.push(chunk(withRole({ reasoning_content: e.delta }))); }
        break;
      case 'response.function_call_arguments.delta': {
        const call = byItem.get(e.item_id) || calls.at(-1);
        if (call && typeof e.delta === 'string') { call.args += e.delta; out.push(chunk({ tool_calls: [{ index: call.index, function: { arguments: e.delta } }] })); }
        break;
      }
      case 'response.output_item.done':
        // A call whose argument deltas were never streamed still has its final arguments here.
        if (e.item?.type === 'function_call') {
          const call = byItem.get(e.item.id) || calls.find((c) => c.id === e.item.call_id);
          if (call && !call.args && typeof e.item.arguments === 'string' && e.item.arguments) {
            call.args = e.item.arguments;
            out.push(chunk({ tool_calls: [{ index: call.index, function: { arguments: call.args } }] }));
          }
        }
        break;
      case 'response.completed':
      case 'response.incomplete':
        usage = chatUsage(e.response?.usage);
        finish = e.type === 'response.incomplete' ? FINISH_FROM_INCOMPLETE[e.response?.incomplete_details?.reason] || 'length' : calls.length ? 'tool_calls' : 'stop';
        break;
      case 'response.failed':
        failed = { message: e.response?.error?.message || '生成失败', type: 'upstream_error', code: e.response?.error?.code || null };
        break;
      case 'error':
        failed = { message: e.message || e.error?.message || '上游出错', type: 'upstream_error', code: e.code || e.error?.code || null };
        break;
      default: break;
    }
    return out;
  }

  return {
    push,
    get failed() { return failed; },
    get started() { return roleSent; },
    /** The closing chunks once the upstream stream has ended. */
    finish() {
      if (failed) return [];
      const out = [chunk(withRole({}), finish || 'stop')];
      if (includeUsage && usage) out.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
      return out;
    },
    completion() {
      const message = { role: 'assistant', content: text || null };
      if (reasoning) message.reasoning_content = reasoning;
      if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
      return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish || (calls.length ? 'tool_calls' : 'stop') }], ...(usage ? { usage } : {}) };
    },
  };
}

/** Collects a Responses stream into the final `response` object (for clients that did not stream). */
export function createResponsesCollector() {
  const items = [];
  let streamed = ''; // text deltas, in case the stream never sends the finished items
  let response = null;
  let failed = null;
  return {
    push(e) {
      if (e?.type === 'response.output_text.delta' && typeof e.delta === 'string') streamed += e.delta;
      if (e?.type === 'response.output_item.done' && e.item) items.push(e.item);
      else if (e?.type === 'response.completed' || e?.type === 'response.incomplete') response = e.response;
      else if (e?.type === 'response.failed') failed = { message: e.response?.error?.message || '生成失败', code: e.response?.error?.code || null };
      else if (e?.type === 'error') failed = { message: e.message || e.error?.message || '上游出错', code: e.code || null };
    },
    get failed() { return failed; },
    result() {
      const r = { ...(response || {}) };
      if (!Array.isArray(r.output) || !r.output.length) {
        r.output = items.length || !streamed ? items : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: streamed }] }];
      }
      const done = r.output;
      if (!r.object) r.object = 'response';
      if (typeof r.output_text !== 'string') r.output_text = done.filter((i) => i.type === 'message').flatMap((i) => i.content || []).map((c) => c.text || '').join('');
      return r;
    },
  };
}

export const modelObject = (m, created) => ({ id: m.id, object: 'model', created, owned_by: 'openai' });
