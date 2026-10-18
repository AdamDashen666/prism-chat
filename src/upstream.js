// Upstream model API calls: builds provider payloads, streams SSE, and
// normalizes events into {type, ...} objects for the browser.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { safeLookup, validateBaseUrl } from './net.js';
import { AppError } from './vault.js';

// Sent to the upstream as-is; whether a model accepts a level is up to the provider.
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_ERROR_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const ANTHROPIC_VERSION = '2023-06-01';

export function authHeader(account, key) {
  const profile = account.protocolProfileId === 'custom' ? account.customProtocolProfile : null;
  const name = profile?.authHeaderName?.trim() || 'Authorization';
  const template = profile?.authHeaderTemplate || 'Bearer {key}';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new AppError('BAD_PROFILE', '认证头名称无效', 400);
  const value = template.replace('{key}', key);
  if (/[\r\n\0]/.test(value)) throw new AppError('BAD_PROFILE', '认证头无效', 400);
  return [name, value];
}

export function endpointUrl(baseUrl, path) {
  let base;
  try { base = validateBaseUrl(String(baseUrl || '').trim().replace(/\/+$/, '')); }
  catch (error) { throw new AppError('UNSAFE_ADDRESS', error.message, 400); }
  return new URL(base.href.replace(/\/+$/, '') + path);
}

// Volcengine Ark takes reference images inside /images/generations and adds a
// watermark unless told otherwise.
export const isArk = (baseUrl) => {
  try { return /(^|\.)volces\.com$/i.test(new URL(baseUrl).hostname); } catch { return false; }
};

function chatContent(m) {
  if (!m.images?.length) return m.content;
  return [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

function responsesContent(m) {
  if (!m.images?.length) return m.content;
  return [...(m.content ? [{ type: 'input_text', text: m.content }] : []), ...m.images.map((url) => ({ type: 'input_image', image_url: url }))];
}

// "No limit" by default. Omitting max_tokens is not enough: many relays and
// providers (Claude via relays, DeepSeek, Kimi, Ark...) then apply a small
// default such as 4096/8192. So when the user leaves the limit empty we ask for
// a very large value and, if the upstream rejects it, retry with the maximum
// it reports (see allowedMaxTokens). OpenAI models and the Responses API are
// already unlimited when the field is omitted.
export const AUTO_MAX_TOKENS = 128000;
const UNLIMITED_BY_DEFAULT = /^(gpt-|chatgpt|o\d|codex)/i;
/** OpenAI models have no small default output cap, so max_tokens can simply be left out. */
export const unlimitedByDefault = (model) => UNLIMITED_BY_DEFAULT.test(model);
export function autoMaxTokens(input) {
  if (Number.isInteger(input.maxTokens) || input.apiType === 'responses') return undefined;
  return unlimitedByDefault(input.model) ? undefined : AUTO_MAX_TOKENS;
}

const num = (s) => Number(String(s).replace(/,/g, ''));
const CONTEXT_SUM = /(\d{2,7})\s*\+\s*(\d{2,7})\s*>\s*(\d{3,7})/;
// The prompt itself is too big for the context window. Any limit found here depends
// on this one request's input, and other numbers in the text are input sizes.
export const CONTEXT_ERROR = /context (length|window|limit)|prompt is too long|input (length|is too long)|too many (input|prompt) tokens|reduce the length/i;
// The error is about the output-size parameter itself.
const OUTPUT_PARAM = /max_(completion_|output_)?tokens|maxOutputTokens|output tokens|completion tokens/i;

// Reads the largest output size an upstream will accept from its error text,
// e.g. "max_tokens: 128000 > 64000, which is the maximum allowed",
// "supports at most 16384 completion tokens", "valid range is [1, 8192]",
// "input length and max_tokens exceed context limit: 150000 + 128000 > 200000",
// or "maximum context length is 128000 tokens ... (2000 in the messages, ...)".
export function allowedMaxTokens(text, sent) {
  const t = String(text || '');
  if (!/token/i.test(t)) return undefined;
  const room = (context, input) => {
    const r = context - input - 256;
    return r >= 1024 && r < sent ? r : undefined;
  };
  const sum = CONTEXT_SUM.exec(t);
  if (sum) return room(num(sum[3]), num(sum[1]));
  const context = /context length is ([\d,]+)/i.exec(t);
  const input = /([\d,]+) (?:tokens )?in (?:the messages|your prompt|the prompt)/i.exec(t);
  if (context && input) return room(num(context[1]), num(input[1]));
  if (CONTEXT_ERROR.test(t)) return undefined;
  const nums = [...t.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d{4,7})(?![\w.])/g)]
    .map((m) => num(m[1]))
    .filter((n) => n >= 1024 && n < sent);
  return nums.length ? Math.max(...nums) : undefined;
}

/**
 * What later requests to the same API + model should reuse after a rejected
 * max_tokens: the model's output cap, 0 (= leave max_tokens out), or undefined
 * when the error says nothing lasting about the model (a context overflow
 * caused by this request's input, or an error about something else).
 */
export function learnedCap(text, allowed) {
  const t = String(text || '');
  if (CONTEXT_SUM.test(t) || CONTEXT_ERROR.test(t) || !OUTPUT_PARAM.test(t)) return undefined;
  return allowed ?? 0;
}

export const LENGTH_REASONS = ['length', 'max_tokens', 'max_output_tokens'];
export const isTruncated = (finish) => LENGTH_REASONS.includes(finish);

// Build the request body. `level` controls retries after a 400:
// 0 = everything (plus `autoCap` when the user set no limit),
// 1 = without the automatic max_tokens, 2 = no optional params.
export function buildPayload(input, level = 0, autoCap = undefined) {
  const strip = level === true || level >= 2;
  const { model, messages, system, effort, effortFormat, temperature, apiType } = input;
  const maxTokens = Number.isInteger(input.maxTokens) ? input.maxTokens : level === 0 ? autoCap : undefined;
  const useEffort = !strip && effort && EFFORTS.includes(effort);
  const sendEffort = useEffort && effortFormat !== 'thinking';
  const sendThinking = useEffort && (effortFormat === 'thinking' || effortFormat === 'both');
  if (apiType === 'responses') {
    const body = {
      model,
      input: messages.map((m) => ({ role: m.role, content: responsesContent(m) })),
      stream: true,
    };
    if (system) body.instructions = system;
    if (!strip) body.store = false;
    if (sendEffort) body.reasoning = { effort, ...(effort === 'none' ? {} : { summary: 'auto' }) };
    if (sendThinking) body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
    if (!strip && Number.isFinite(temperature)) body.temperature = temperature;
    if (!strip && Number.isInteger(maxTokens)) body.max_output_tokens = maxTokens;
    if (input.extra?.length) body.input.push(...input.extra);
    if (input.tools?.length) body.tools = input.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    return body;
  }
  const chat = [];
  if (system) chat.push({ role: 'system', content: system });
  for (const m of messages) chat.push({ role: m.role, content: chatContent(m) });
  // Native turns of the current tool loop / resumed reply.
  if (input.extra?.length) chat.push(...input.extra);
  const body = { model, messages: chat, stream: true };
  if (input.tools?.length) body.tools = input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (!strip) body.stream_options = { include_usage: true };
  if (sendEffort) body.reasoning_effort = effort;
  if (sendThinking) body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
  if (!strip && Number.isFinite(temperature)) body.temperature = temperature;
  if (!strip && Number.isInteger(maxTokens)) body.max_tokens = maxTokens;
  return body;
}

export function multipart(fields, files) {
  const boundary = '----PrismChat' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), Buffer.from(String(value)), Buffer.from('\r\n'));
  }
  files.forEach(({ name, mime, buffer }, i) => {
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="image-${i + 1}.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`), buffer, Buffer.from('\r\n'));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function parseDataImage(url) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(url);
  if (!match) return null;
  const b64 = match[2].replace(/[\r\n]/g, '');
  const buffer = Buffer.from(b64, 'base64');
  const mime = sniffImage(buffer);
  return mime ? { mime, buffer, b64 } : null;
}

// mode: 'gen' (text-to-image), 'gen-ref' (generations + image field), 'edit' (multipart /images/edits)
// strip: 0 = all params, 1 = drop n/quality/watermark, 2 = also drop size.
// input.images: [{ url, mime, buffer }]
export function imageRequest(baseUrl, input, { mode, strip = 0, n = 1 }) {
  const ark = isArk(baseUrl);
  const withN = strip < 1 && n > 1;
  const withQuality = strip < 1 && input.quality;
  const withSize = strip < 2 && input.size;
  if (mode === 'edit') {
    const fields = [['model', input.model], ['prompt', input.prompt]];
    if (withN) fields.push(['n', n]);
    if (withSize) fields.push(['size', input.size]);
    if (withQuality) fields.push(['quality', input.quality]);
    const name = input.images.length > 1 ? 'image[]' : 'image';
    const { body, contentType } = multipart(fields, input.images.map((r) => ({ name, mime: r.mime, buffer: r.buffer })));
    return { url: endpointUrl(baseUrl, '/images/edits'), body, headers: { 'content-type': contentType, accept: 'application/json' } };
  }
  const body = { model: input.model, prompt: input.prompt };
  if (withN) body.n = n;
  if (withSize) body.size = input.size;
  if (withQuality) body.quality = input.quality;
  if (strip < 1 && ark) body.watermark = false;
  if (withN && ark) {
    // Ark Seedream produces multiple images via sequential generation instead of `n`.
    delete body.n;
    body.sequential_image_generation = 'auto';
    body.sequential_image_generation_options = { max_images: n };
  }
  if (mode === 'gen-ref' && input.images.length) {
    const urls = input.images.map((r) => r.url);
    body.image = urls.length === 1 ? urls[0] : urls;
  }
  return { url: endpointUrl(baseUrl, '/images/generations'), body, headers: { accept: 'application/json' } };
}

export const toDataUrl = ({ mime, buffer, b64 }) => `data:${mime};base64,${b64 || buffer.toString('base64')}`;

// Opens an HTTP(S) request to the upstream. Resolves with the IncomingMessage.
// connectTimeoutMs bounds the wait for the response headers; after that, a body
// that stays silent for idleMs is cut, so a stalled upstream cannot hold a slot.
export function open(url, { method = 'POST', headers = {}, body, signal, connectTimeoutMs = 20000, idleMs = 180000, lookup = safeLookup, agent }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const lib = url.protocol === 'http:' ? http : https;
    const request = lib.request(url, {
      method,
      lookup,
      agent: lib === https ? agent : undefined,
      headers: {
        accept: 'text/event-stream, application/json',
        'accept-encoding': 'gzip, br, deflate',
        'user-agent': 'PrismChat/1.0',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    });
    const timer = setTimeout(() => request.destroy(new Error('CONNECT_TIMEOUT')), connectTimeoutMs);
    const abort = () => request.destroy(new Error('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    request.on('response', (response) => {
      clearTimeout(timer);
      request.setTimeout(idleMs, () => response.destroy(new Error('IDLE_TIMEOUT')));
      resolve(response);
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.end(payload);
  });
}

// pipeline (not pipe) so a dropped or timed-out response errors the decoder too;
// with pipe() the decoder would wait for more input forever.
export function decoded(response) {
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase().trim();
  const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'br' ? zlib.createBrotliDecompress()
    : encoding === 'deflate' ? zlib.createInflate() : null;
  return decoder ? pipeline(response, decoder, () => {}) : response;
}

export async function readText(stream, limit = MAX_ERROR_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readBuffer(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy?.();
      throw new AppError('TOO_LARGE', '上游返回的内容过大', 502);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sniffImage(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return '';
}

// Downloads an image URL returned by a provider. Every hop is re-validated and
// resolved through the public-address-only lookup.
export async function fetchImage(raw, { lookup = safeLookup, agent, signal } = {}) {
  let next = raw;
  for (let hop = 0; hop < 4; hop++) {
    let target;
    try { target = validateBaseUrl(next, { allowQuery: true, allowHttp: true }); }
    catch (error) { throw new AppError('UNSAFE_ADDRESS', `图片地址被拒绝：${error.message}`, 400); }
    let response;
    try {
      response = await open(target, { method: 'GET', headers: { accept: 'image/*,*/*;q=0.5' }, signal, lookup, agent, connectTimeoutMs: 30000 });
    } catch (error) { throw new AppError('UPSTREAM', '图片下载失败：' + networkError(error), 502); }
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.resume();
      next = new URL(response.headers.location, target).href;
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new AppError('UPSTREAM', `图片下载失败（${response.statusCode}）`, 502);
    }
    const buffer = await readBuffer(decoded(response), MAX_IMAGE_BYTES);
    const mime = sniffImage(buffer);
    if (!mime) throw new AppError('UPSTREAM', '下载的内容不是图片', 502);
    return { mime, buffer };
  }
  throw new AppError('UPSTREAM', '图片地址重定向次数过多', 502);
}

// Cloudflare-fronted relays cut requests whose origin sends nothing for ~100–120 s.
// The raw page text is English boilerplate; say what actually happened instead.
const EDGE_TIMEOUT = {
  524: '中转站前面的 Cloudflare 等了约 120 秒仍没收到模型的任何输出，主动断开了（不是本站超时）。通常是模型思考或排队太久',
  522: '中转站前面的 Cloudflare 连不上中转站的源服务器',
  504: '中转站网关等待模型超时',
};

export function upstreamError(status, text) {
  if (EDGE_TIMEOUT[status]) return `上游返回 ${status}：${EDGE_TIMEOUT[status]}。`;
  let message = '';
  try {
    const data = JSON.parse(text);
    message = data?.error?.message || data?.error?.msg || (typeof data?.error === 'string' ? data.error : '') ||
      data?.message || data?.msg || data?.detail || '';
  } catch { message = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  message = String(message).slice(0, 600);
  return `上游返回 ${status}${message ? '：' + message : ''}`;
}

export function networkError(error) {
  if (error?.message === 'ABORTED') return '已停止';
  if (error?.code === 'NON_PUBLIC_ADDRESS') return '目标解析到了非公网地址，已拒绝连接';
  if (error?.message === 'CONNECT_TIMEOUT' || error?.message === 'IDLE_TIMEOUT') return '上游响应超时';
  if (error?.code === 'ENOTFOUND') return '无法解析上游域名';
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET') return '上游连接被拒绝或中断';
  if (String(error?.code || '').startsWith('ERR_TLS') || /certificate/i.test(error?.message || '')) return '上游 TLS 证书校验失败';
  return '无法连接上游接口';
}

const MAX_EVENT_CHARS = 48 * 1024 * 1024;
const LINE_BREAK = /[\r\n]/g;

// Parses an SSE byte stream and yields JSON payloads (or the string '[DONE]').
// Line by line, per the SSE spec (CRLF, LF or CR line ends; a blank line ends an
// event). Only the new chunk is scanned, so a huge event (an inline base64 image
// split over hundreds of chunks) costs linear time.
export async function* sseEvents(stream, idleMs = 180000) {
  const decoder = new TextDecoder();
  const iterator = stream[Symbol.asyncIterator]();
  let line = ''; // current, unfinished line
  let data = []; // data: lines of the current event
  let size = 0;
  let skipLF = false; // the previous chunk ended with CR; a leading LF belongs to it
  const ready = [];
  const endLine = () => {
    if (line === '') {
      if (data.length) {
        const payload = parseData(data.join('\n'));
        if (payload !== undefined) ready.push(payload);
      }
      data = [];
      size = 0;
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
    line = '';
  };
  const feed = (text) => {
    let i = 0;
    if (skipLF && text[0] === '\n') i = 1;
    skipLF = false;
    while (i < text.length) {
      LINE_BREAK.lastIndex = i;
      const m = LINE_BREAK.exec(text);
      if (!m) { line += text.slice(i); size += text.length - i; break; }
      line += text.slice(i, m.index);
      size += m.index - i;
      i = m.index + 1;
      if (text[m.index] === '\r') {
        if (i === text.length) skipLF = true;
        else if (text[i] === '\n') i++;
      }
      endLine();
    }
    if (size > MAX_EVENT_CHARS) throw new Error('EVENT_TOO_LARGE');
  };
  while (true) {
    let timer;
    const idle = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IDLE_TIMEOUT')), idleMs); });
    let step;
    try { step = await Promise.race([iterator.next(), idle]); }
    finally { clearTimeout(timer); }
    if (step.done) break;
    feed(decoder.decode(step.value, { stream: true }));
    yield* ready.splice(0);
  }
  feed(decoder.decode());
  if (line) endLine();
  endLine(); // the stream may end without the final blank line
  yield* ready.splice(0);
}

function parseData(data) {
  if (data.trim() === '[DONE]') return '[DONE]';
  try { return JSON.parse(data); } catch { return undefined; }
}

// Image parts appear in several shapes depending on the relay
// (OpenRouter `images`, content-part arrays, Gemini inline_data).
function imagePartUrl(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.image_url === 'string') return p.image_url;
  if (typeof p.image_url?.url === 'string') return p.image_url.url;
  if (typeof p.url === 'string' && /image/i.test(p.type || '')) return p.url;
  const inline = p.inline_data || p.inlineData;
  const b64 = p.b64_json || inline?.data || (typeof p.data === 'string' ? p.data : '');
  const mime = p.mime_type || p.mimeType || inline?.mime_type || inline?.mimeType || '';
  if (typeof b64 === 'string' && b64 && (/image/i.test(p.type || '') || /^image\//.test(mime))) {
    return b64.startsWith('data:') ? b64 : `data:${mime || 'image/png'};base64,${b64}`;
  }
  return '';
}

function contentEvents(content, out) {
  if (typeof content === 'string') { if (content) out.push({ type: 'delta', text: content }); return; }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (typeof part?.text === 'string' && part.text && /text/.test(part.type || 'text')) out.push({ type: 'delta', text: part.text });
    const url = imagePartUrl(part);
    if (url) out.push({ type: 'image', url });
  }
}

const firstNumber = (...values) => { for (const v of values) if (v != null && Number.isFinite(Number(v))) return Number(v); return undefined; };

/**
 * OpenAI-style usage (Chat Completions or Responses, as relayed by many
 * providers) -> { input, output, reasoning?, cacheRead?, cacheWrite? }.
 * `input` is the whole prompt, cached part included. Cache hits are reported as
 * prompt_tokens_details.cached_tokens (OpenAI, most relays), prompt_cache_hit_tokens
 * (DeepSeek), cached_tokens (Kimi) or cache_read_input_tokens (Claude via relays).
 */
export function openaiUsage(u) {
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const cacheRead = firstNumber(d.cached_tokens, u.prompt_cache_hit_tokens, u.cached_tokens, u.cache_read_input_tokens);
  const cacheWrite = firstNumber(u.cache_creation_input_tokens, d.cache_write_tokens, d.cache_creation_tokens, d.cached_creation_tokens);
  let input = firstNumber(u.prompt_tokens, u.input_tokens);
  // Anthropic-shaped usage passed through as-is: input_tokens excludes the cache.
  if (u.prompt_tokens == null && u.cache_read_input_tokens != null && input != null) input += (cacheRead || 0) + (cacheWrite || 0);
  const out = { input, output: firstNumber(u.completion_tokens, u.output_tokens) };
  const reasoning = firstNumber(u.completion_tokens_details?.reasoning_tokens, u.output_tokens_details?.reasoning_tokens);
  if (reasoning) out.reasoning = reasoning;
  if (cacheRead) out.cacheRead = input != null ? Math.min(cacheRead, input) : cacheRead;
  if (cacheWrite) out.cacheWrite = cacheWrite;
  return out;
}

// OpenRouter sends reasoning_details next to (or instead of) a plain reasoning string.
function reasoningDetailsText(details) {
  if (!Array.isArray(details)) return '';
  return details.map((d) => (d?.type === 'reasoning.text' ? d.text : d?.type === 'reasoning.summary' ? d.summary : '')).filter((x) => typeof x === 'string').join('');
}

const THINK_TAGS = [['<think>', '</think>'], ['<thought>', '</thought>']];

/**
 * Some models only mark reasoning inline: the answer opens with <think>…</think>
 * (DeepSeek-R1 style, Qwen, MiniMax) or <thought>…</thought> (Gemini). Only a tag
 * at the very start counts. push(text)/flush() -> [{type:'delta'|'reasoning', text}].
 */
export function thinkTagFilter() {
  let state = 'start';
  let close = '';
  let pending = '';
  const take = (out) => {
    while (pending) {
      if (state === 'start') {
        const lead = pending.trimStart();
        const tag = THINK_TAGS.find(([open]) => lead.startsWith(open));
        if (tag) { state = 'think'; close = tag[1]; pending = lead.slice(tag[0].length); continue; }
        if (THINK_TAGS.some(([open]) => open.startsWith(lead))) return; // could still become a tag
        state = 'body';
      }
      if (state === 'think') {
        const end = pending.indexOf(close);
        if (end < 0) {
          // Keep the longest tail that could still grow into the closing tag.
          let keep = Math.min(pending.length, close.length - 1);
          while (keep && !pending.endsWith(close.slice(0, keep))) keep--;
          const text = pending.slice(0, pending.length - keep);
          if (text) out.push({ type: 'reasoning', text });
          pending = pending.slice(pending.length - keep);
          return;
        }
        if (end) out.push({ type: 'reasoning', text: pending.slice(0, end) });
        pending = pending.slice(end + close.length).replace(/^\s+/, '');
        state = 'body';
        continue;
      }
      out.push({ type: 'delta', text: pending });
      pending = '';
    }
  };
  return {
    push(text) { const out = []; pending += text; take(out); return out; },
    flush() {
      const out = [];
      if (pending) out.push({ type: state === 'think' ? 'reasoning' : 'delta', text: pending });
      pending = '';
      return out;
    },
  };
}

// Maps one provider payload into zero or more normalized events.
export function normalize(apiType, payload) {
  const out = [];
  if (payload?.error) {
    const e = payload.error;
    out.push({ type: 'error', message: '上游错误：' + String(e.message || e.msg || (typeof e === 'string' ? e : JSON.stringify(e))).slice(0, 600) });
    return out;
  }
  if (apiType === 'responses') {
    const t = payload?.type;
    if (t === 'response.output_text.delta' && typeof payload.delta === 'string') out.push({ type: 'delta', text: payload.delta });
    else if ((t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') && typeof payload.delta === 'string') out.push({ type: 'reasoning', text: payload.delta });
    else if (t === 'response.reasoning_summary_part.added' && payload.summary_index > 0) out.push({ type: 'reasoning', text: '\n\n' });
    else if (t === 'response.output_item.done' && payload.item?.type === 'image_generation_call' && typeof payload.item.result === 'string') {
      out.push({ type: 'image', url: `data:image/png;base64,${payload.item.result}` });
    } else if (t === 'response.completed' || t === 'response.incomplete') {
      const usage = payload.response?.usage;
      if (usage) out.push({ type: 'usage', usage: openaiUsage(usage) });
      out.push({ type: 'finish', reason: t === 'response.incomplete' ? (payload.response?.incomplete_details?.reason || 'incomplete') : 'stop' });
    } else if (t === 'response.failed') {
      out.push({ type: 'error', message: '上游错误：' + String(payload.response?.error?.message || '生成失败').slice(0, 600) });
    } else if (t === 'error') {
      out.push({ type: 'error', message: '上游错误：' + String(payload.message || '生成失败').slice(0, 600) });
    }
    return out;
  }
  const choice = payload?.choices?.[0];
  const delta = choice?.delta || choice?.message;
  if (delta) {
    let reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (typeof reasoning !== 'string' || !reasoning) reasoning = reasoningDetailsText(delta.reasoning_details);
    if (reasoning) out.push({ type: 'reasoning', text: reasoning });
    contentEvents(delta.content, out);
    for (const image of Array.isArray(delta.images) ? delta.images : []) {
      const url = imagePartUrl(image);
      if (url) out.push({ type: 'image', url });
    }
  }
  if (payload?.usage) out.push({ type: 'usage', usage: openaiUsage(payload.usage) });
  if (choice?.finish_reason) out.push({ type: 'finish', reason: choice.finish_reason });
  return out;
}

// Converts a non-streaming JSON body into normalized events.
export function normalizeWhole(apiType, data) {
  if (apiType === 'responses') {
    const out = [];
    for (const item of data?.output || []) {
      if (item.type === 'reasoning') for (const s of item.summary || []) if (s.text) out.push({ type: 'reasoning', text: s.text });
      if (item.type === 'message') for (const c of item.content || []) if (typeof c.text === 'string') out.push({ type: 'delta', text: c.text });
      if (item.type === 'image_generation_call' && typeof item.result === 'string') out.push({ type: 'image', url: `data:image/png;base64,${item.result}` });
    }
    if (typeof data?.output_text === 'string' && !out.some((e) => e.type === 'delta')) out.push({ type: 'delta', text: data.output_text });
    if (data?.usage) out.push({ type: 'usage', usage: openaiUsage(data.usage) });
    out.push({ type: 'finish', reason: 'stop' });
    return out;
  }
  return normalize('chat', data);
}

/**
 * Collects function calls from Chat Completions / Responses payloads (streamed
 * or whole) and builds the native messages a tool loop replays.
 * push(payload) -> progress events { type: 'tool_input', id, name, chars }.
 */
export function toolCallCollector(apiType) {
  const calls = []; // { id, name, args }
  const byKey = new Map();
  let reasoningContent = ''; // DeepSeek-style reasoning_content, which its tool loops expect back
  const slot = (key, id) => {
    if (!byKey.has(key)) {
      const call = { id: id || `call_${calls.length + 1}`, name: '', args: '' };
      byKey.set(key, call);
      calls.push(call);
    }
    return byKey.get(key);
  };
  function push(payload) {
    const out = [];
    if (apiType === 'responses') {
      const t = payload?.type;
      const item = payload?.item;
      if ((t === 'response.output_item.added' || t === 'response.output_item.done') && item?.type === 'function_call') {
        const call = slot(item.id || item.call_id, item.call_id);
        if (item.call_id) call.id = item.call_id;
        if (item.name) call.name = item.name;
        if (t === 'response.output_item.done' && typeof item.arguments === 'string') call.args = item.arguments;
        out.push({ type: 'tool_input', id: call.id, name: call.name, chars: call.args.length });
      } else if (t === 'response.function_call_arguments.delta' && byKey.has(payload.item_id)) {
        const call = byKey.get(payload.item_id);
        call.args += payload.delta || '';
        out.push({ type: 'tool_input', id: call.id, name: call.name, chars: call.args.length });
      } else if (t === 'response.function_call_arguments.done' && byKey.has(payload.item_id) && typeof payload.arguments === 'string') {
        byKey.get(payload.item_id).args = payload.arguments;
      } else if (!t && Array.isArray(payload?.output)) {
        // A whole (non-streamed) response.
        for (const o of payload.output) {
          if (o?.type !== 'function_call') continue;
          const call = slot(o.call_id || o.id, o.call_id);
          call.name = o.name || '';
          call.args = typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments || {});
        }
      }
      return out;
    }
    const choice = payload?.choices?.[0];
    const delta = choice?.delta || choice?.message;
    if (typeof delta?.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
    const list = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    list.forEach((tc, position) => {
      const key = Number.isInteger(tc?.index) ? tc.index : (tc?.id || position);
      const call = slot(key, tc?.id);
      if (tc?.id) call.id = tc.id;
      if (tc?.function?.name) call.name += call.name && call.name === tc.function.name ? '' : tc.function.name;
      const a = tc?.function?.arguments;
      if (typeof a === 'string') call.args += a;
      else if (a && typeof a === 'object') call.args = JSON.stringify(a);
      out.push({ type: 'tool_input', id: call.id, name: call.name, chars: call.args.length });
    });
    return out;
  }
  return {
    push,
    calls: () => calls.filter((c) => c.name),
    /** The assistant turn to replay: text plus its calls. */
    replay(text) {
      const done = calls.filter((c) => c.name);
      if (apiType === 'responses') {
        return [
          ...(text ? [{ role: 'assistant', content: text }] : []),
          ...done.map((c) => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.args || '{}' })),
        ];
      }
      const message = { role: 'assistant', content: text || null, tool_calls: done.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      return [message];
    },
  };
}

/** Tool results in each API's format. results: [{ id, output }] */
export function toolResultMessages(apiType, results) {
  if (apiType === 'anthropic') {
    return [{ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, ...(r.error ? { is_error: true } : {}) })) }];
  }
  if (apiType === 'responses') return results.map((r) => ({ type: 'function_call_output', call_id: r.id, output: r.output }));
  return results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.output }));
}

// Uses whatever capability metadata the provider exposes (new-api
// supported_endpoint_types, Ark modalities/domain, OpenRouter architecture).
export function modelKinds(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const kinds = {};
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
    const types = Array.isArray(m.supported_endpoint_types) ? m.supported_endpoint_types.map(String) : [];
    const output = m.modalities?.output_modalities || m.output_modalities || m.architecture?.output_modalities || [];
    let kind = '';
    if (types.includes('image-generation')) kind = 'image';
    else if (types.some((t) => /video/.test(t))) kind = 'video';
    else if (m.domain === 'ImageGeneration') kind = 'image';
    else if (Array.isArray(output) && output.includes('video')) kind = 'video';
    else if (Array.isArray(output) && output.includes('image') && !output.includes('text')) kind = 'image';
    if (kind) kinds[m.id] = kind;
  }
  return kinds;
}

// Some relays (e.g. new-api for Gemini image models) return generated images as
// markdown `![image](data:image/png;base64,...)` inside the text stream. This
// stateful filter lifts them out as image events so megabytes of base64 never
// reach the chat text.
export function inlineImageFilter() {
  let pending = '';
  const START = /!\[[^\]\n]{0,200}\]\(\s*data:image\//;
  // True when `tail` (starting at "!") could still grow into ![..](data:image/
  const couldStart = (tail) => {
    if (tail === '!') return true;
    if (!tail.startsWith('![')) return false;
    const close = tail.indexOf(']');
    if (close < 0) return tail.length < 203 && !tail.includes('\n');
    const after = tail.slice(close + 1).replace(/^\(\s*/, '(');
    return '(data:image/'.startsWith(after);
  };
  function drain(final) {
    const out = [];
    while (pending) {
      const match = START.exec(pending);
      if (!match) {
        // Hold back a possible beginning of the pattern at the tail.
        const last = pending.lastIndexOf('!');
        const keep = !final && last >= 0 && couldStart(pending.slice(last)) ? last : pending.length;
        if (keep > 0) out.push({ type: 'delta', text: pending.slice(0, keep) });
        pending = pending.slice(keep);
        break;
      }
      if (match.index > 0) out.push({ type: 'delta', text: pending.slice(0, match.index) });
      pending = pending.slice(match.index);
      const close = pending.indexOf(')');
      if (close < 0) {
        if (final) pending = '';
        break;
      }
      const open = pending.indexOf('](') + 1;
      const url = pending.slice(open + 1, close).trim().replace(/\s+/g, '');
      out.push({ type: 'image', url });
      pending = pending.slice(close + 1);
    }
    return out;
  }
  return {
    push(text) {
      pending += text;
      if (pending.length > MAX_IMAGE_BYTES * 1.5) throw new AppError('TOO_LARGE', '上游返回的图片过大', 502);
      return drain(false);
    },
    flush: () => drain(true),
  };
}

// Parses an Images API JSON body into {images:[{b64|url}], usage, notes}.
export function imageResults(data) {
  const images = [];
  const notes = [];
  for (const item of Array.isArray(data?.data) ? data.data : []) {
    if (typeof item?.b64_json === 'string' && item.b64_json) images.push({ b64: item.b64_json });
    else if (typeof item?.url === 'string' && item.url) images.push({ url: item.url });
    else if (item?.error) notes.push(String(item.error.message || item.error.code || '部分图片生成失败').slice(0, 300));
    if (typeof item?.revised_prompt === 'string' && item.revised_prompt) notes.push('优化后的提示词：' + item.revised_prompt.slice(0, 2000));
  }
  const u = data?.usage;
  const usage = u ? { input: u.input_tokens ?? u.prompt_tokens, output: u.output_tokens ?? u.completion_tokens, images: u.generated_images } : undefined;
  return { images, usage, notes };
}

export function modelIds(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  const ids = list.map((m) => (typeof m === 'string' ? m : m?.id || m?.name)).filter((v) => typeof v === 'string' && v.length <= 200);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// Anthropic's own API (and relays that copy it) rejects Bearer keys and wants
// anthropic-version; users often save its base URL without /v1 or as the whole .../v1/messages
// endpoint. Its list is paged, max 1000.
function anthropicModelUrls(baseUrl) {
  const root = endpointUrl(baseUrl, '');
  const path = root.pathname.replace(/\/+$/, '').replace(/\/messages$/i, '');
  return (/\/v1$/i.test(path) ? [path + '/models'] : [path + '/v1/models', path + '/models']).map((p) => {
    const url = new URL(root);
    url.pathname = p;
    url.searchParams.set('limit', '1000');
    return url;
  });
}

/**
 * GET <base>/models -> { models, kinds, allowCustom: true }. With the raw `key`,
 * an auth/404 failure is retried the Anthropic way (x-api-key + anthropic-version).
 */
export async function fetchModelList(baseUrl, header, { key, lookup = safeLookup, agent } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const get = async (url, headers) => {
    const response = await open(url, { method: 'GET', headers: { ...headers, accept: 'application/json' }, signal: controller.signal, lookup, agent });
    return { status: response.statusCode, text: await readText(decoded(response), 4 * 1024 * 1024) };
  };
  const ok = (r) => r.status >= 200 && r.status < 300;
  try {
    let result = await get(endpointUrl(baseUrl, '/models'), { [header[0]]: header[1] });
    if (!ok(result) && key && [400, 401, 403, 404].includes(result.status)) {
      for (const url of anthropicModelUrls(baseUrl)) {
        const retry = await get(url, { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION });
        // A non-404 answer came from an endpoint that exists, so its error is the more useful one.
        if (ok(retry) || retry.status !== 404) result = retry;
        if (ok(retry)) break;
      }
    }
    const { status, text } = result;
    if (!ok(result)) throw new AppError('UPSTREAM', upstreamError(status, text), 502);
    let data;
    try { data = JSON.parse(text); } catch { throw new AppError('UPSTREAM', '上游模型列表不是 JSON', 502); }
    return { models: modelIds(data), kinds: modelKinds(data), allowCustom: true };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('UPSTREAM', networkError(error), 502);
  } finally { clearTimeout(timer); }
}
