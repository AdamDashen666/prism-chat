// Request validation for chat, image and trace requests.
import { AppError } from './vault.js';
import { EFFORTS, parseDataImage, toDataUrl } from './upstream.js';
import { isUuid } from './util.js';

export const MAX_IMAGE_INPUT = 15 * 1024 * 1024; // decoded bytes of all attached images per request
const IMAGE_SIZE = /^(auto|\d{3,5}x\d{3,5}|[1-8]K)$/i;
const IMAGE_QUALITY = ['auto', 'low', 'medium', 'high', 'standard', 'hd'];
const empty = (v) => v === undefined || v === null || v === '';

export function text(v, max, name) {
  if (empty(v)) return '';
  if (typeof v !== 'string' || v.length > max) throw new AppError('INVALID', `${name}无效或过长`, 400);
  return v;
}

export function checkId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError('INVALID_ACCOUNT', '请选择 API', 400);
  return id;
}

export function checkModel(value) {
  const model = text(value, 200, '模型').trim();
  if (!model || /[\u0000-\u001f]/.test(model)) throw new AppError('INVALID_MODEL', '请选择或填写模型', 400);
  return model;
}

/** undefined when not set, otherwise a number in 0–2. */
export function checkTemperature(value) {
  if (empty(value)) return undefined;
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new AppError('INVALID', '温度需在 0–2 之间', 400);
  return temperature;
}

// Decodes data-URL images, checks magic bytes and enforces count/size budgets.
export function checkImages(list, budget, maxCount) {
  if (!Array.isArray(list)) throw new AppError('INVALID_IMAGE', '图片参数无效', 400);
  return list.map((url) => {
    if (typeof url !== 'string' || url.length > MAX_IMAGE_INPUT * 1.4) throw new AppError('INVALID_IMAGE', '图片过大', 413);
    const image = parseDataImage(url);
    if (!image) throw new AppError('INVALID_IMAGE', '只支持 PNG、JPEG、WebP、GIF 图片', 400);
    budget.bytes += image.buffer.length;
    budget.count++;
    if (budget.count > maxCount) throw new AppError('INVALID_IMAGE', `图片最多 ${maxCount} 张`, 400);
    if (budget.bytes > MAX_IMAGE_INPUT) throw new AppError('TOO_LARGE', '图片总大小超过 15 MB，请减少图片', 413);
    return image;
  });
}

export function validateImageJob(b) {
  const prompt = text(b.prompt, 32000, '描述').trim();
  if (!prompt) throw new AppError('INVALID', '请输入图片描述', 400);
  const size = b.size ? String(b.size) : '';
  if (size && !IMAGE_SIZE.test(size)) throw new AppError('INVALID', '图片尺寸格式应为 1024x1024、2K 或 auto', 400);
  const quality = b.quality ? String(b.quality) : '';
  if (quality && !IMAGE_QUALITY.includes(quality)) throw new AppError('INVALID', '图片质量无效', 400);
  const n = empty(b.n) ? 1 : Number(b.n);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new AppError('INVALID', '数量需为 1–4', 400);
  const images = b.images === undefined ? [] : checkImages(b.images, { bytes: 0, count: 0 }, 8);
  return { accountId: checkId(b.accountId), model: checkModel(b.model), prompt, size, quality, n, images: images.map((i) => ({ ...i, url: toDataUrl(i) })) };
}

export function validateChat(b) {
  const model = checkModel(b.model);
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 400) {
    throw new AppError('INVALID_MESSAGES', '对话消息无效', 400);
  }
  let size = 0;
  const budget = { bytes: 0, count: 0 };
  const messages = b.messages.map((m) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      throw new AppError('INVALID_MESSAGES', '对话消息无效', 400);
    }
    size += m.content.length;
    const out = { role: m.role, content: m.content };
    if (m.images !== undefined && m.role === 'user') out.images = checkImages(m.images, budget, 20).map(toDataUrl);
    if (!out.content && !out.images?.length) throw new AppError('INVALID_MESSAGES', '消息不能为空', 400);
    return out;
  });
  if (size > 1_500_000) throw new AppError('TOO_LARGE', '对话内容过长，请新建对话或删减历史', 413);
  if (messages.at(-1).role !== 'user') throw new AppError('INVALID_MESSAGES', '最后一条必须是用户消息', 400);
  const effort = empty(b.effort) ? '' : b.effort;
  if (effort && !EFFORTS.includes(effort)) throw new AppError('INVALID_EFFORT', '思考强度无效', 400);
  const effortFormat = b.effortFormat || 'effort';
  if (!['effort', 'thinking', 'both'].includes(effortFormat)) throw new AppError('INVALID', '思考参数格式无效', 400);
  // auto: Claude models try the native Anthropic Messages API first, everything else Chat Completions.
  const apiType = b.apiType || 'auto';
  if (!['auto', 'chat', 'responses', 'anthropic'].includes(apiType)) throw new AppError('INVALID', '接口类型无效', 400);
  let maxTokens;
  if (!empty(b.maxTokens)) {
    maxTokens = Number(b.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000) throw new AppError('INVALID', '最大输出需为正整数', 400);
  }
  // File tools need the conversation the workspace belongs to.
  const conversationId = empty(b.conversationId) ? '' : String(b.conversationId);
  if (conversationId && !isUuid(conversationId)) throw new AppError('INVALID', '对话 ID 无效', 400);
  return {
    accountId: checkId(b.accountId), model, messages, system: text(b.system, 20000, '系统提示词'),
    effort, effortFormat, apiType, temperature: checkTemperature(b.temperature), maxTokens,
    conversationId, fileTools: b.fileTools === true && Boolean(conversationId),
  };
}
