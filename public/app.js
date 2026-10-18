import { render } from './markdown.js';
import { highlight, languageForFile } from './highlight.js';
import * as img from './images.js';
import * as store from './store.js';
import {
  $, CUSTOM, api, busy, createNotice, createSidebar, fetchModels, fillAccounts, fillModels, friendlyError, loadSession,
  modelsOf, onShown, reducedMotion, request, session, showUser, sleep,
} from './common.js';

const ui = {
  shell: document.querySelector('.shell'), main: $('main'),
  account: $('account'), model: $('model'), modelCustom: $('model-custom'), refreshModels: $('refresh-models'), modelKind: $('model-kind'),
  effort: $('effort'), apiType: $('api-type'), effortFormat: $('effort-format'), temperature: $('temperature'),
  maxTokens: $('max-tokens'), system: $('system'), settings: $('settings'), toggleSettings: $('toggle-settings'),
  imageMode: $('image-mode'), imageSize: $('image-size'), imageN: $('image-n'), imageQuality: $('image-quality'),
  messages: $('messages'), empty: $('empty'), composer: $('composer'), input: $('composer-input'),
  send: $('send'), stop: $('stop'), notice: $('notice'), history: $('history'), newChat: $('new-chat'),
  userName: $('user-name'), userAvatar: $('user-avatar'), live: $('live'), hint: $('composer-hint'),
  sidebar: $('sidebar'), backdrop: $('backdrop'), openSidebar: $('open-sidebar'), closeSidebar: $('close-sidebar'),
  toBottom: $('to-bottom'), attach: $('attach'), fileInput: $('file-input'), tray: $('attachments'),
  lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxDownload: $('lightbox-download'),
  lightboxEdit: $('lightbox-edit'), lightboxClose: $('lightbox-close'),
  fileTools: $('file-tools'), theme: $('theme'),
  exportChats: $('export-chats'), importChats: $('import-chats'), importFile: $('import-file'),
  historySearch: $('history-search'), preset: $('preset'), presetSave: $('preset-save'), presetDelete: $('preset-delete'),
};

const state = {
  accounts: [],
  liveModels: new Map(), // accountId -> string[] fetched from upstream
  liveKinds: new Map(), // accountId -> { model: 'image' | 'video' } from upstream metadata
  autoFetched: new Set(), // accountIds whose empty model list was fetched automatically
  conversations: [],
  currentId: null,
  streams: new Map(), // conversationId -> { controller, reply }
  attachments: [], // image ids waiting in the composer
  files: [], // text files waiting in the composer: { id, name, size, chars, lang }
  search: '', // history filter, lower case
  lightboxId: '',
};

const MAX_ATTACH = 8;
const MAX_ATTACH_BYTES = 14 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 1024 * 1024; // one text file
const MAX_FILE_CHARS = 400_000; // all text files of one message
const PREVIEW_CHARS = 20_000;
const uid = () => session.data.userId;
const { show: notice, clear: clearNotice } = createNotice(ui.notice);
const sidebar = createSidebar({ shell: ui.shell, openButton: ui.openSidebar, closeButton: ui.closeSidebar, backdrop: ui.backdrop, focusOnOpen: ui.newChat });
const closeSidebar = () => sidebar.close();
// Phones and tablets: no Shift key, so Enter makes a new line and the button sends.
const touchInput = matchMedia('(pointer: coarse)');
// Narrow or touch screens get a short placeholder (no drag-and-drop or shortcut hints).
const compactInput = matchMedia('(pointer: coarse), (max-width: 480px)');

// ---------- model kinds ----------
// Images API models (gpt-image, Seedream, Wan image, Flux, ...).
const IMAGE_RE = /(gpt-image|dall-?e|seedream|seededit|wan[\d.]*-image|wanx|flux|imagen|cogview|kolors|ideogram|recraft|stable-diffusion|sdxl|sd3|qwen-image|hunyuan-image|jimeng|midjourney|seed-?image|-t2i|-i2i)/i;
// Chat models that can return images inside the reply (Gemini image family).
const CHAT_IMAGE_RE = /(gemini[\w.-]*image|nano-?banana)/i;
const VIDEO_RE = /(seedance|veo-?\d|sora|kling|hailuo|vidu|seed3d|-t2v|-i2v|-r2v|-flf2v|video)/i;

function guessKind(model) {
  if (!model) return 'chat';
  if (CHAT_IMAGE_RE.test(model)) return 'chat-image';
  const live = state.liveKinds.get(ui.account.value)?.[model];
  if (live) return live;
  if (VIDEO_RE.test(model)) return 'video';
  if (IMAGE_RE.test(model)) return 'image';
  return 'chat';
}

function effectiveKind() {
  if (ui.imageMode.value === 'chat') return 'chat';
  if (ui.imageMode.value === 'image') return 'image';
  return guessKind(selectedModel());
}

const KIND_CHIP = { image: '图片', 'chat-image': '可出图', video: '视频 · 暂不支持' };

function updateMode() {
  const kind = effectiveKind();
  const image = kind === 'image';
  ui.shell.classList.toggle('mode-image', image);
  ui.modelKind.textContent = KIND_CHIP[kind] || '';
  ui.modelKind.dataset.kind = kind;
  ui.modelKind.classList.toggle('show', Boolean(KIND_CHIP[kind]));
  ui.input.placeholder = compactInput.matches
    ? (image ? '描述想要的画面' : '输入消息')
    : image
      ? '描述想要的画面；附上参考图即可改图。Enter 生成'
      : '输入消息，可粘贴或拖入图片和文件。Enter 发送，Shift + Enter 换行';
  autoGrow(); // the placeholder decides the empty height
  ui.send.setAttribute('aria-label', image ? '生成图片' : '发送');
  ui.attach.title = image ? '添加参考图（也可粘贴或拖入）' : '添加图片（也可粘贴或拖入）';
  updateComposer();
}

// ---------- storage (per site user, browser only) ----------
// Conversations live in IndexedDB (store.js); small preferences stay in localStorage.
const prefKey = () => `prism-chat:prefs:v1:${uid()}`;

async function loadConversations() {
  state.conversations = await store.loadConversations(uid());
  for (const c of state.conversations) {
    for (const m of c.messages) {
      if (m.pending && m.jobId && !state.streams.has(c.id)) {
        // Image job kept running on the server; reattach after init.
        m.pending = false;
        m.jobPending = true;
        continue;
      }
      if (m.pending && !state.streams.has(c.id)) {
        m.pending = false;
        if (m.resumeFrom !== undefined) { m.finish = 'length'; delete m.resumeFrom; }
        if (!m.content && !m.images?.length && !m.error) m.error = '页面关闭或刷新时，这条回复被中断了';
      }
    }
  }
}

// Saves run one after another; each writes the state as it is when it runs.
let saving = Promise.resolve();
let storageWarnedAt = 0;
function saveConversations() {
  if (!session.data) return saving;
  const userId = uid();
  saving = saving.then(async () => {
    const list = state.conversations.filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt);
    const result = await store.saveConversations(userId, list);
    if (result.ok || Date.now() - storageWarnedAt < 60000) return;
    storageWarnedAt = Date.now();
    notice(result.dropped
      ? `浏览器存储空间不足，最早的 ${result.dropped} 个对话没能保存到本地。可以删除一些旧对话（尤其是带图片的）。`
      : '浏览器存储空间不足，最近的对话没能保存到本地。可以删除一些旧对话（尤其是带图片的）后再试。');
  }).catch(() => {});
  return saving;
}

// While a reply streams, save every few seconds so a closed tab keeps most of it.
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveConversations(); }, 3000);
}

function prefs() {
  try { return JSON.parse(localStorage.getItem(prefKey()) || '{}') || {}; } catch { return {}; }
}
function savePrefs(update) {
  try { localStorage.setItem(prefKey(), JSON.stringify({ ...prefs(), ...update })); } catch { /* ignore */ }
}

// Images and text attachments share one blob store (images.js).
const blobIds = (m) => [...(m.images || []), ...(m.files || []).map((f) => f.id)];

function referencedIds() {
  const ids = new Set([...state.attachments, ...state.files.map((f) => f.id)]);
  for (const c of state.conversations) for (const m of c.messages) for (const id of blobIds(m)) ids.add(id);
  return ids;
}

// Deletes stored images that nothing references any more.
function releaseImages(ids) {
  const used = referencedIds();
  img.remove((ids || []).filter((id) => !used.has(id)));
}

// ---------- conversation model ----------
const current = () => state.conversations.find((c) => c.id === state.currentId) || null;
const isStreaming = (id) => state.streams.has(id);

function settingsFromUi() {
  return {
    accountId: ui.account.value,
    model: selectedModel(),
    effort: ui.effort.value,
    effortFormat: ui.effortFormat.value,
    apiMode: ui.apiType.value,
    temperature: ui.temperature.value,
    maxTokens: ui.maxTokens.value,
    fileTools: ui.fileTools.checked,
    system: ui.system.value,
    imageMode: ui.imageMode.value,
    size: ui.imageSize.value,
    n: ui.imageN.value,
    quality: ui.imageQuality.value,
  };
}

function createConversation() {
  const conversation = { id: crypto.randomUUID(), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...settingsFromUi() };
  state.conversations.unshift(conversation);
  state.currentId = conversation.id;
  return conversation;
}

function persistSettings() {
  const s = settingsFromUi();
  savePrefs({ ...s, system: undefined, lastModel: { ...(prefs().lastModel || {}), [s.accountId]: s.model } });
  const conversation = current();
  if (conversation) {
    Object.assign(conversation, s);
    if (conversation.messages.length) saveConversations();
  }
}

// ---------- selectors ----------
const account = () => state.accounts.find((a) => a.id === ui.account.value);
const selectedModel = () => (ui.model.value === CUSTOM ? ui.modelCustom.value.trim() : ui.model.value);

function renderAccounts() {
  fillAccounts(ui.account, state.accounts, { emptyLabel: '没有可用的 API（需要已保存密钥）', short: matchMedia('(max-width: 480px)').matches });
}

// APIs and grants may have changed while the page was out of view (added in API 管理,
// grant used up…); reload them and keep the selected API and model when still usable.
async function reloadAccounts() {
  let data;
  try { data = await api('/api/chat/accounts'); } catch { return; }
  const keepAccount = ui.account.value;
  const keepModel = selectedModel();
  state.accounts = data.accounts || [];
  renderAccounts();
  const kept = state.accounts.some((a) => a.id === keepAccount && a.usable);
  if (kept) ui.account.value = keepAccount;
  renderModels(kept ? keepModel : undefined);
}

function renderModels(preferred) {
  const a = account();
  fillModels(ui.model, modelsOf(a, state.liveModels), {
    // A grant with a model list only allows those models.
    custom: !a?.grant?.restricted,
    preferred: preferred || prefs().lastModel?.[a?.id],
    customInput: ui.modelCustom,
    groups: (list) => [['对话模型', list.filter((m) => guessKind(m) !== 'image')], ['图片模型', list.filter((m) => guessKind(m) === 'image')]],
  });
  ui.model.disabled = !a;
  updateMode();
  // An API without a saved model list would only offer "type a model ID": fetch its list once.
  if (a && !modelsOf(a, state.liveModels).length && !state.autoFetched.has(a.id)) {
    state.autoFetched.add(a.id);
    refreshModels({ quiet: true });
  }
}

async function refreshModels({ quiet = false } = {}) {
  const a = account();
  if (!a) return;
  const keep = selectedModel();
  await busy(ui.refreshModels, async () => {
    try {
      const data = await fetchModels(a.id);
      state.liveModels.set(a.id, data.models || []);
      state.liveKinds.set(a.id, data.kinds || {});
      if (account()?.id !== a.id) return; // another API was picked meanwhile
      renderModels(keep);
      if (quiet) return;
      const imageCount = (data.models || []).filter((m) => guessKind(m) === 'image').length;
      notice(`已获取 ${data.models?.length || 0} 个模型${imageCount ? `，其中 ${imageCount} 个图片模型` : ''}`, 'success');
    } catch (error) {
      if (!quiet) notice(`获取模型列表失败：${error.message}`);
    }
  });
}

// Settings saved before the auto mode existed stored apiType 'chat' as the default.
const API_MODES = ['auto', 'chat', 'responses', 'anthropic'];
const apiModeOf = (s) => (API_MODES.includes(s?.apiMode) ? s.apiMode : s?.apiType === 'responses' ? 'responses' : 'auto');

function applyConversationSettings(c) {
  if (c.accountId && state.accounts.some((a) => a.id === c.accountId && a.usable)) ui.account.value = c.accountId;
  ui.imageMode.value = c.imageMode || 'auto';
  ui.imageSize.value = c.size ?? '';
  ui.imageN.value = c.n || '1';
  ui.imageQuality.value = c.quality ?? '';
  ui.effort.value = c.effort ?? '';
  ui.effortFormat.value = c.effortFormat || 'effort';
  ui.apiType.value = apiModeOf(c);
  ui.temperature.value = c.temperature ?? '';
  ui.maxTokens.value = c.maxTokens ?? '';
  ui.fileTools.checked = c.fileTools !== false;
  ui.system.value = c.system ?? '';
  syncPreset();
  renderModels(c.model);
}

// ---------- system prompt presets ----------
// Built-in presets plus the user's own (kept with the other preferences).
const BUILTIN_PRESETS = [
  { id: 'b:concise', name: '简洁的中文助手', text: '你是一名简洁、准确的中文助手。先给结论，再给必要的理由；不确定时直接说明。' },
  { id: 'b:code', name: '代码助手', text: '你是一名资深软件工程师。给出可以直接运行的完整代码，说明关键改动和可能的风险；代码块标注语言。' },
  { id: 'b:translate', name: '中英互译', text: '你是专业译者。用户发中文就译成英文，发其他语言就译成中文。只输出译文，保留原有格式、术语和语气。' },
  { id: 'b:polish', name: '文字润色', text: '你是一名中文编辑。在不改变原意的前提下润色用户给出的文字，使其通顺、专业；最后用一两句话说明主要改动。' },
];
const userPresets = () => (Array.isArray(prefs().presets) ? prefs().presets : [])
  .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.text === 'string');

function renderPresets() {
  ui.preset.replaceChildren(new Option('选择预设…', ''));
  for (const [label, list] of [['内置', BUILTIN_PRESETS], ['我的预设', userPresets()]]) {
    if (!list.length) continue;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const p of list) g.append(new Option(p.name, p.id));
    ui.preset.append(g);
  }
  syncPreset();
}

// The picker shows the preset whose text is in the box, if any.
function syncPreset() {
  const text = ui.system.value;
  const match = text ? [...BUILTIN_PRESETS, ...userPresets()].find((p) => p.text === text) : null;
  ui.preset.value = match?.id || '';
  ui.presetDelete.hidden = !match || match.id.startsWith('b:');
}

function applyPreset() {
  const p = [...BUILTIN_PRESETS, ...userPresets()].find((x) => x.id === ui.preset.value);
  if (!p) return;
  ui.system.value = p.text;
  syncPreset();
  persistSettings();
}

function savePreset() {
  const text = ui.system.value.trim();
  if (!text) { notice('先写好系统提示词，再保存为预设', 'info'); ui.system.focus(); return; }
  const name = prompt('预设名称', text.replace(/\s+/g, ' ').slice(0, 16))?.trim().slice(0, 40);
  if (!name) return;
  const list = userPresets().filter((p) => p.name !== name);
  list.push({ id: `u:${crypto.randomUUID()}`, name, text });
  savePrefs({ presets: list.slice(-50) });
  ui.system.value = text;
  renderPresets();
  persistSettings();
  notice(`已保存预设“${name}”`, 'success');
}

function deletePreset() {
  const p = userPresets().find((x) => x.id === ui.preset.value);
  if (!p || !confirm(`删除预设“${p.name}”？当前对话的系统提示词不受影响。`)) return;
  savePrefs({ presets: userPresets().filter((x) => x.id !== p.id) });
  renderPresets();
}

// ---------- attachments ----------
// Images go to the model as images; any other file must be plain text (code,
// Markdown, CSV, logs…) and is sent as text in front of the message.
const isImageFile = (f) => f.type?.startsWith('image/') && f.type !== 'image/svg+xml';

async function readTextFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`文件过大：${file.name}（文本文件每个最多 1 MB）`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new Error(`${file.name} 不是纯文本文件。可以添加图片和文本/代码文件；PDF、Word 等请先复制其中的文字`);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    // Chinese Windows tools often save GBK.
    try { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { text = new TextDecoder().decode(bytes); }
  }
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

async function addFiles(files) {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length || !session.data) return;
  for (const file of list) {
    if (isImageFile(file)) {
      if (state.attachments.length >= MAX_ATTACH) { notice(`一次最多添加 ${MAX_ATTACH} 张图片`); break; }
      try {
        const blob = await img.prepareFile(file);
        let total = blob.size;
        for (const id of state.attachments) total += (await img.blobOf(id))?.size || 0;
        if (total > MAX_ATTACH_BYTES) { notice('图片总大小超过 14 MB，请减少图片'); break; }
        const id = img.putBlob(uid(), blob);
        state.attachments.push(id);
        renderAttachments(id);
      } catch (error) { notice(error.message || '图片添加失败'); }
      continue;
    }
    if (state.files.length >= MAX_FILES) { notice(`一次最多添加 ${MAX_FILES} 个文件`); break; }
    try {
      const text = await readTextFile(file);
      const used = state.files.reduce((n, f) => n + f.chars, 0);
      if (used + text.length > MAX_FILE_CHARS) { notice('附件文字总量超过 40 万字，请减少文件'); break; }
      const id = img.putBlob(uid(), new Blob([text], { type: 'text/plain;charset=utf-8' }));
      state.files.push({ id, name: file.name || '未命名.txt', size: file.size, chars: text.length, lang: languageForFile(file.name) });
      renderAttachments(id);
    } catch (error) { notice(error.message || '文件添加失败'); }
  }
  updateComposer();
}

function attachExisting(id) {
  if (!id) return;
  if (!state.attachments.includes(id)) {
    if (state.attachments.length >= MAX_ATTACH) { notice(`一次最多添加 ${MAX_ATTACH} 张图片`); return; }
    state.attachments.push(id);
    renderAttachments(id);
  }
  updateComposer();
  if (ui.lightbox.open) ui.lightbox.close();
  closeSidebar();
  ui.input.focus();
  if (effectiveKind() !== 'image') notice('已添加为参考图。选择图片模型并描述修改要求即可改图。', 'info');
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((x) => x !== id);
  state.files = state.files.filter((f) => f.id !== id);
  renderAttachments();
  releaseImages([id]);
  updateComposer();
  ui.input.focus();
}

const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function svgIcon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

// Text attachments on a sent message: name and size; opening one shows a highlighted preview.
function fileCards(m) {
  const wrap = document.createElement('div');
  wrap.className = 'file-cards';
  for (const f of m.files) {
    const card = document.createElement('details');
    card.className = 'file-card';
    const summary = document.createElement('summary');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = fileSize(f.size);
    summary.append(svgIcon('i-file'), name, meta);
    const pre = document.createElement('pre');
    pre.className = 'file-preview';
    card.append(summary, pre);
    card.addEventListener('toggle', async () => {
      if (!card.open || pre.dataset.loaded) return;
      pre.dataset.loaded = '1';
      const blob = await img.blobOf(f.id);
      if (!blob) { pre.textContent = '文件已不在本地存储中'; return; }
      const text = await blob.text();
      pre.replaceChildren(highlight(text.slice(0, PREVIEW_CHARS), f.lang));
      if (text.length > PREVIEW_CHARS) pre.append(`\n…（只显示前 ${PREVIEW_CHARS.toLocaleString('zh-CN')} 个字符）`);
    });
    wrap.append(card);
  }
  return wrap;
}

// File-tool steps of a reply: what the model is doing / did (写入 index.html …).
const TOOL_ICON = { running: 'i-spark', input: 'i-spark', done: 'i-check', error: 'i-x' };
function toolSteps(m) {
  const list = document.createElement('ol');
  list.className = 'tool-steps';
  for (const t of m.tools) {
    const li = document.createElement('li');
    li.className = `tool-step ${t.status}`;
    const busyNow = m.pending && (t.status === 'running' || t.status === 'input');
    if (busyNow) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      li.append(spinner);
    } else li.append(svgIcon(TOOL_ICON[t.status] || 'i-file'));
    const label = document.createElement('span');
    label.className = 'tool-label';
    label.textContent = t.label || t.name;
    li.append(label);
    const detail = t.status === 'input' && t.chars ? `已写 ${fileSize(t.chars)}` : t.summary && t.status !== 'done' ? t.summary : '';
    if (detail) {
      const d = document.createElement('span');
      d.className = 'tool-detail';
      d.textContent = detail;
      li.append(d);
    }
    if (!m.pending && (t.status === 'running' || t.status === 'input')) li.classList.add('stopped');
    list.append(li);
  }
  return list;
}

// Files the model created on the server: kept 24 h, downloaded on demand.
function outputCards(m) {
  const wrap = document.createElement('div');
  wrap.className = 'output-files';
  for (const f of m.outputs) {
    const expired = f.removed || f.expiresAt <= Date.now();
    const card = document.createElement('div');
    card.className = 'output-file' + (expired ? ' expired' : '');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.path;
    name.title = f.path;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = f.removed ? '已删除' : expired ? '已过期' : `${fileSize(f.size)} · 保留到 ${new Date(f.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const text = document.createElement('span');
    text.className = 'output-text';
    text.append(name, meta);
    card.append(svgIcon('i-file'), text);
    if (!expired) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'output-download';
      b.append(svgIcon('i-download'), '下载');
      b.addEventListener('click', () => downloadOutput(f, b));
      card.append(b);
    }
    wrap.append(card);
  }
  return wrap;
}

async function downloadOutput(f, button) {
  button.disabled = true;
  try {
    const response = await request(`/api/chat/files/${encodeURIComponent(f.id)}`);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || `下载失败（${response.status}）`);
    }
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name || f.path.split('/').pop();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    notice(friendlyError(error));
    if (/过期|不存在/.test(error.message)) { f.removed = true; saveConversations(); renderMessages(); }
  } finally { button.disabled = false; }
}

function setImageSrc(image, id, holder) {
  const cached = img.cachedUrl(id);
  if (cached) { image.src = cached; return; }
  img.urlOf(id).then((url) => {
    if (url) image.src = url;
    else holder.classList.add('missing');
  });
}

function renderAttachments(enterId = '') {
  ui.tray.replaceChildren();
  state.attachments.forEach((id, index) => {
    const item = document.createElement('div');
    item.className = 'attach-item' + (id === enterId ? ' enter' : '');
    const image = document.createElement('img');
    image.alt = `待发送的图片 ${index + 1}`;
    setImageSrc(image, id, item);
    image.addEventListener('click', () => openLightbox(id, { editable: false }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attach-remove';
    remove.setAttribute('aria-label', `移除图片 ${index + 1}`);
    remove.innerHTML = '<svg><use href="#i-x"/></svg>';
    remove.addEventListener('click', () => removeAttachment(id));
    item.append(image, remove);
    ui.tray.append(item);
  });
  for (const f of state.files) {
    const item = document.createElement('div');
    item.className = 'attach-file' + (f.id === enterId ? ' enter' : '');
    item.title = `${f.name} · ${fileSize(f.size)}`;
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = fileSize(f.size);
    const text = document.createElement('span');
    text.className = 'file-text';
    text.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attach-remove';
    remove.setAttribute('aria-label', `移除文件 ${f.name}`);
    remove.append(svgIcon('i-x'));
    remove.addEventListener('click', () => removeAttachment(f.id));
    item.append(svgIcon('i-file', 'file-icon'), text, remove);
    ui.tray.append(item);
  }
  ui.tray.classList.toggle('has-items', state.attachments.length + state.files.length > 0);
}

// ---------- lightbox ----------
function openLightbox(id, { editable = true } = {}) {
  state.lightboxId = id;
  ui.lightboxImg.removeAttribute('src');
  setImageSrc(ui.lightboxImg, id, ui.lightbox);
  ui.lightboxEdit.hidden = !editable;
  if (!ui.lightbox.open) ui.lightbox.showModal();
}

async function downloadImage(id) {
  const blob = await img.blobOf(id);
  if (!blob) { notice('图片已不在本地存储中'); return; }
  const a = document.createElement('a');
  a.href = await img.urlOf(id);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  a.download = `prism-image-${stamp}.${img.extensionOf(blob)}`;
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- history sidebar ----------
function dayGroup(ts) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (ts >= start.getTime()) return '今天';
  if (ts >= start.getTime() - day) return '昨天';
  if (ts >= start.getTime() - 6 * day) return '7 天内';
  if (ts >= start.getTime() - 29 * day) return '30 天内';
  return '更早';
}

// Search: title, message text and attachment names.
function matchesSearch(c, q) {
  if (!q) return true;
  if ((c.title || '').toLowerCase().includes(q)) return true;
  return c.messages.some((m) => (m.content || '').toLowerCase().includes(q) || m.files?.some((f) => f.name.toLowerCase().includes(q)));
}

function renderHistory({ animateId } = {}) {
  ui.history.replaceChildren();
  const list = state.conversations
    .filter((c) => (c.messages.length || isStreaming(c.id)) && matchesSearch(c, state.search))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = state.search ? `没有找到包含“${ui.historySearch.value.trim()}”的对话` : '还没有对话';
    ui.history.append(empty);
    return;
  }
  let group = '';
  for (const c of list) {
    const label = dayGroup(c.updatedAt);
    if (label !== group) {
      group = label;
      const h = document.createElement('h2');
      h.className = 'history-group';
      h.textContent = label;
      ui.history.append(h);
    }
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');
    if (c.id === state.currentId) item.classList.add('active');
    if (isStreaming(c.id)) item.classList.add('streaming');
    if (c.id === animateId) item.classList.add('enter');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    const dot = document.createElement('span');
    dot.className = 'history-dot';
    dot.setAttribute('aria-hidden', 'true');
    open.append(dot);
    if (c.messages.some((m) => m.kind === 'image' || m.images?.length)) open.append(svgIcon('i-image', 'history-icon'));
    else if (c.messages.some((m) => m.files?.length)) open.append(svgIcon('i-file', 'history-icon file'));
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = c.title || '新对话';
    open.append(title);
    open.title = `${c.title}${c.model ? '\n' + c.model : ''}${isStreaming(c.id) ? '\n正在生成…' : ''}`;
    if (c.id === state.currentId) open.setAttribute('aria-current', 'true');
    open.addEventListener('click', () => { openConversation(c.id); closeSidebar(); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-delete';
    del.innerHTML = '<svg><use href="#i-x"/></svg>';
    del.setAttribute('aria-label', `删除对话：${c.title}`);
    del.addEventListener('click', () => deleteConversation(c));
    item.append(open, del);
    ui.history.append(item);
  }
}

// Deleted at once, with a few seconds to undo. Its images and server files are
// only released when the undo window closes (startup GC covers a closed tab).
const UNDO_MS = 6000;
function deleteConversation(c) {
  state.streams.get(c.id)?.controller.abort();
  state.streams.delete(c.id);
  const index = state.conversations.indexOf(c);
  state.conversations = state.conversations.filter((x) => x.id !== c.id);
  saveConversations();
  if (c.id === state.currentId) startNew();
  else renderHistory();
  let undone = false;
  const finish = setTimeout(() => {
    if (undone) return;
    if (c.messages.some((m) => m.outputs?.length)) api('/api/chat/files/clear', { method: 'POST', body: { conversationId: c.id } }).catch(() => {});
    releaseImages(c.messages.flatMap(blobIds));
  }, UNDO_MS);
  notice(`已删除“${c.title}”`, 'info', {
    label: '撤销',
    run: () => {
      undone = true;
      clearTimeout(finish);
      if (state.conversations.some((x) => x.id === c.id)) return;
      state.conversations.splice(Math.min(Math.max(index, 0), state.conversations.length), 0, c);
      saveConversations();
      openConversation(c.id);
      renderHistory();
    },
    ms: UNDO_MS,
  });
}

// ---------- export / import (a JSON file with the conversations and their images) ----------
const EXPORT_FORMAT = 'prism-chat-export';

async function exportConversations() {
  await saveConversations();
  const list = state.conversations.filter((c) => c.messages.length && !isStreaming(c.id));
  if (!list.length) { notice('还没有可以导出的对话', 'info'); return; }
  const blobs = {};
  for (const id of new Set(list.flatMap((c) => c.messages.flatMap(blobIds)))) {
    const data = await img.dataUrlOf(id).catch(() => '');
    if (data) blobs[id] = data;
  }
  const file = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), conversations: list, blobs })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = `prism-对话-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  notice(`已导出 ${list.length} 个对话`, 'success');
}

async function importConversations(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.conversations)) { notice('这不是从这里导出的对话文件'); return; }
  const have = new Set(state.conversations.map((c) => c.id));
  const blobs = data.blobs && typeof data.blobs === 'object' ? data.blobs : {};
  const newIds = new Map(); // exported blob id -> id in this browser
  const blobFor = (id) => {
    if (!newIds.has(id)) {
      const blob = typeof blobs[id] === 'string' ? img.dataUrlToBlob(blobs[id]) : null;
      newIds.set(id, blob ? img.putBlob(uid(), blob) : '');
    }
    return newIds.get(id);
  };
  let added = 0;
  for (const c of data.conversations) {
    if (!c || typeof c.id !== 'string' || !Array.isArray(c.messages) || have.has(c.id)) continue;
    for (const m of c.messages) {
      m.pending = false;
      delete m.jobId;
      delete m.jobPending;
      if (Array.isArray(m.images)) m.images = m.images.map(blobFor).filter(Boolean);
      if (Array.isArray(m.files)) m.files = m.files.map((f) => ({ ...f, id: blobFor(f.id) })).filter((f) => f.id);
    }
    c.title = String(c.title || '导入的对话');
    c.updatedAt = Number(c.updatedAt) || Date.now();
    state.conversations.push(c);
    have.add(c.id);
    added++;
  }
  if (!added) { notice('文件里的对话都已经在这里了', 'info'); return; }
  await saveConversations();
  renderHistory();
  notice(`已导入 ${added} 个对话`, 'success');
}

function openConversation(id) {
  if (id === state.currentId) return;
  dropEmptyCurrent();
  state.currentId = id;
  applyConversationSettings(current());
  renderMessages({ transition: true });
  renderHistory();
  updateComposer();
  ui.input.focus({ preventScroll: true });
}

function dropEmptyCurrent() {
  const c = current();
  if (c && !c.messages.length && !isStreaming(c.id)) {
    state.conversations = state.conversations.filter((x) => x.id !== c.id);
  }
}

// Always allowed, even while other conversations are still generating.
function startNew() {
  const c = current();
  if (c && !c.messages.length) { ui.input.focus(); closeSidebar(); pulse(ui.empty); return; }
  dropEmptyCurrent();
  createConversation();
  renderMessages({ transition: true });
  renderHistory();
  updateComposer();
  closeSidebar();
  ui.input.value = '';
  autoGrow();
  ui.input.focus();
}

function pulse(node) {
  if (!node || reducedMotion()) return;
  node.classList.remove('pulse');
  void node.offsetWidth;
  node.classList.add('pulse');
}

// ---------- message rendering ----------
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = '已复制';
    button.classList.add('done');
    setTimeout(() => { button.textContent = label; button.classList.remove('done'); }, 1500);
  } catch { notice('复制失败，请手动选择文本'); }
}

const EFFORT_LABEL = { none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

// Which long code blocks the user expanded, per message (not persisted; WeakMap so it never reaches storage).
const openFolds = new WeakMap();
function foldsFor(m) {
  return {
    isOpen: (i) => openFolds.get(m)?.has(i) || false,
    toggle: (i, open) => {
      const set = openFolds.get(m) || new Set();
      if (open) set.add(i); else set.delete(i);
      openFolds.set(m, set);
    },
  };
}

// A folded block that is still streaming shows its newest lines.
function pinLiveCode(root) {
  for (const pre of root.querySelectorAll('.code-block.folded[data-live] pre')) pre.scrollTop = pre.scrollHeight;
}

function metaText(m) {
  const parts = [];
  if (m.model) parts.push(m.model);
  if (m.kind === 'image') {
    if (m.size) parts.push(m.size);
    if (m.images?.length) parts.push(`${m.images.length} 张`);
  } else if (m.effort) parts.push(`思考 ${EFFORT_LABEL[m.effort] || m.effort}`);
  if (m.usage) {
    const u = m.usage;
    const bits = [];
    if (u.input != null) bits.push(`↑${u.input}`);
    if (u.output != null) bits.push(`↓${u.output}`);
    if (u.reasoning) bits.push(`推理 ${u.reasoning}`);
    if (bits.length) parts.push(bits.join(' ') + ' tokens');
    if (u.cacheRead) parts.push(`缓存命中 ${u.cacheRead}${u.input ? `（${Math.round((100 * u.cacheRead) / u.input)}%）` : ''}`);
    if (u.cacheWrite) parts.push(`写入缓存 ${u.cacheWrite}`);
  }
  if (m.firstMs && m.kind !== 'image') parts.push(`首字 ${(m.firstMs / 1000).toFixed(1)}s`);
  if (m.ms) parts.push(`共 ${(m.ms / 1000).toFixed(1)}s`);
  if (m.finish === 'refusal') parts.push('模型按安全策略拒绝了这次回答');
  else if (m.finish && !['stop', 'end_turn', 'completed', 'stopped', ...LENGTH_REASONS].includes(m.finish)) parts.push(`结束原因：${m.finish}`);
  return parts.join(' · ');
}

function actionButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function iconButton(icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'image-tool';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function ratioOf(size) {
  const m = /^(\d+)x(\d+)$/.exec(size || '');
  return m ? `${m[1]} / ${m[2]}` : '1 / 1';
}

function imageGrid(m, role) {
  const ids = m.images || [];
  const waiting = m.pending && m.kind === 'image' ? Math.max(0, (m.expected || 1) - ids.length) : 0;
  const total = ids.length + waiting;
  const grid = document.createElement('div');
  grid.className = `image-grid ${role} count-${Math.min(total, 4)}`;
  ids.forEach((id, index) => {
    const card = document.createElement('figure');
    card.className = 'image-card';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'image-open';
    open.setAttribute('aria-label', `查看大图 ${index + 1}`);
    const image = document.createElement('img');
    image.alt = role === 'user' ? `附图 ${index + 1}` : `生成的图片 ${index + 1}`;
    image.decoding = 'async';
    if (role === 'assistant' && m.kind === 'image') image.style.aspectRatio = ratioOf(m.size);
    image.addEventListener('load', () => { card.classList.add('loaded'); image.style.aspectRatio = ''; }, { once: true });
    setImageSrc(image, id, card);
    open.append(image);
    open.addEventListener('click', () => openLightbox(id, { editable: true }));
    card.append(open);
    if (role === 'assistant') {
      const tools = document.createElement('div');
      tools.className = 'image-tools';
      tools.append(
        iconButton('i-wand', '以此图继续编辑', () => attachExisting(id)),
        iconButton('i-download', '下载', () => downloadImage(id)),
        iconButton('i-expand', '查看大图', () => openLightbox(id, { editable: true })),
      );
      card.append(tools);
    }
    grid.append(card);
  });
  for (let k = 0; k < waiting; k++) {
    const sk = document.createElement('div');
    sk.className = 'image-skeleton';
    sk.style.aspectRatio = ratioOf(m.size);
    sk.innerHTML = '<svg><use href="#i-image"/></svg>';
    grid.append(sk);
  }
  return grid;
}

function messageNode(m, index, conversation, { animate = false } = {}) {
  const wrap = document.createElement('article');
  wrap.className = `message ${m.role}`;
  if (animate) wrap.classList.add('enter');
  wrap.dataset.index = index;
  const label = document.createElement('h2');
  label.className = 'visually-hidden';
  label.textContent = m.role === 'user' ? '你' : '助手';
  wrap.append(label);

  if (m.role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'assistant-avatar' + (m.pending ? ' thinking' : '') + (m.kind === 'image' ? ' painter' : '');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = m.kind === 'image' ? '<svg><use href="#i-wand"/></svg>' : '<svg><use href="#i-spark"/></svg>';
    wrap.append(avatar);
  }
  const body = document.createElement('div');
  body.className = 'message-body';
  wrap.append(body);

  if (m.role === 'user' && m.images?.length) body.append(imageGrid(m, 'user'));
  if (m.role === 'user' && m.files?.length) body.append(fileCards(m));

  if (m.role === 'assistant' && m.reasoning) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    if (m.pending && !m.content) details.open = true;
    const summary = document.createElement('summary');
    summary.innerHTML = '<svg><use href="#i-brain"/></svg>';
    summary.append(m.pending && !m.content ? '思考中…' : '思考过程');
    const inner = document.createElement('div');
    inner.className = 'reasoning-body';
    inner.textContent = m.reasoning;
    details.append(summary, inner);
    body.append(details);
  }

  if (m.role === 'assistant' && m.kind === 'image' && m.pending) {
    const status = document.createElement('p');
    status.className = 'image-status';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const done = m.images?.length || 0;
    const want = m.expected || 1;
    const text = document.createElement('span');
    const p = m.progress;
    const mb = (n) => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1);
    text.textContent = p
      ? `正在下载第 ${done + 1} 张 · ${mb(p.received)}${p.total ? ` / ${mb(p.total)}` : ''} MB`
      : done ? `已生成 ${done} / ${want} 张` : `正在生成${want > 1 ? ` ${want} 张` : ''}图片`;
    if (p?.total) {
      const bar = document.createElement('span');
      bar.className = 'download-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const pct = Math.min(100, Math.round((p.received / p.total) * 100));
      bar.setAttribute('aria-valuenow', String(pct));
      const fill = document.createElement('i');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      text.append(bar);
    }
    const elapsed = document.createElement('span');
    elapsed.className = 'elapsed';
    elapsed.dataset.start = m.startedAt || Date.now();
    elapsed.textContent = elapsedText(elapsed.dataset.start);
    status.append(spinner, text, elapsed);
    body.append(status);
  }

  if (m.role === 'assistant' && m.tools?.length) body.append(toolSteps(m));

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.role === 'user') bubble.textContent = m.content;
  else if (m.content) {
    bubble.append(render(m.content, { onCopy: copyText, folds: foldsFor(m) }));
    if (m.pending) {
      let target = bubble.lastElementChild;
      while (target && ['UL', 'OL'].includes(target.tagName)) target = target.lastElementChild;
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.setAttribute('aria-hidden', 'true');
      (target && ['P', 'LI', 'H3', 'H4', 'H5', 'H6'].includes(target.tagName) ? target : bubble).append(caret);
    }
  } else if (m.pending && !m.reasoning && !m.tools?.length && m.kind !== 'image' && !m.images?.length) {
    const dots = document.createElement('span');
    dots.className = 'typing';
    dots.setAttribute('aria-label', '正在等待回复');
    dots.innerHTML = '<i></i><i></i><i></i>';
    bubble.append(dots);
  }
  if ((m.role === 'user' && m.content) || (m.role === 'assistant' && bubble.childNodes.length)) body.append(bubble);

  if (m.role === 'assistant' && (m.images?.length || (m.kind === 'image' && m.pending))) body.append(imageGrid(m, 'assistant'));
  if (m.role === 'assistant' && m.outputs?.length) body.append(outputCards(m));
  if (m.pending && m.status) {
    const st = document.createElement('p');
    st.className = 'message-status';
    st.textContent = m.status;
    body.append(st);
  }

  if (m.notice) {
    const n = document.createElement('p');
    n.className = 'message-notice';
    n.textContent = m.notice;
    body.append(n);
  }
  if (m.error) {
    const e = document.createElement('p');
    e.className = 'message-error';
    e.textContent = m.error;
    body.append(e);
  }
  if (!m.pending && truncated(m) && !m.error) {
    const t = document.createElement('p');
    t.className = 'message-truncated';
    t.textContent = `回复达到了这个模型（或中转站）允许的单次输出上限${m.usage?.output ? `（${m.usage.output} tokens）` : ''}，内容没写完。点“继续生成”接着写${m.effort && m.effort !== 'none' ? '；调低思考强度也能留更多额度给正文' : ''}。`;
    body.append(t);
  }

  const actions = actionsNode(m, index, conversation);
  if (actions) body.append(actions);
  return wrap;
}

// Copy/edit/regenerate under a message. Which ones show depends on whether the
// conversation is generating, so syncActions() refreshes them when that changes.
function actionsNode(m, index, conversation) {
  if (m.pending) return null;
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const busy = isStreaming(conversation.id);
  if (m.content) actions.append(actionButton('复制', (e) => copyText(m.content, e.currentTarget)));
  const isLast = index === conversation.messages.length - 1;
  if (truncated(m) && isLast && !busy) {
    const more = actionButton('继续生成', () => continueReply());
    more.className = 'primary-action';
    actions.prepend(more);
  }
  if (m.role === 'assistant' && isLast && !busy) actions.append(actionButton(m.kind === 'image' ? '再画一次' : '重新生成', () => regenerate()));
  if (m.role === 'user' && !busy) actions.append(actionButton('编辑', () => editFrom(index)));
  const meta = metaText(m);
  if (m.role === 'assistant' && meta) {
    const span = document.createElement('span');
    span.className = 'meta';
    span.textContent = meta;
    actions.append(span);
  }
  return actions.childElementCount ? actions : null;
}

function syncActions(c) {
  if (c.id !== state.currentId) return;
  for (const node of ui.messages.querySelectorAll('.message[data-index]')) {
    const index = Number(node.dataset.index);
    const m = c.messages[index];
    if (!m || m.pending) continue;
    const body = node.querySelector('.message-body');
    const old = body.querySelector(':scope > .message-actions');
    const next = actionsNode(m, index, c);
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) body.append(next);
  }
}

function elapsedText(start) {
  const s = Math.max(0, Math.floor((Date.now() - Number(start)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}
setInterval(() => {
  for (const node of document.querySelectorAll('.elapsed[data-start]')) node.textContent = elapsedText(node.dataset.start);
}, 1000);

function nearBottom() {
  const el = ui.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

function scrollToBottom(smooth = false) {
  ui.messages.scrollTo({ top: ui.messages.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

function updateToBottom() {
  const show = !nearBottom() && ui.messages.scrollHeight > ui.messages.clientHeight + 10;
  ui.toBottom.classList.toggle('show', show);
  ui.toBottom.tabIndex = show ? 0 : -1;
}

function renderMessages({ transition = false, animateFrom = Infinity } = {}) {
  const c = current();
  ui.messages.replaceChildren();
  if (transition && !reducedMotion()) {
    ui.messages.classList.remove('switching');
    void ui.messages.offsetWidth;
    ui.messages.classList.add('switching');
  }
  if (!c || !c.messages.length) {
    ui.empty.classList.remove('pulse');
    ui.messages.append(ui.empty);
    ui.shell.classList.add('is-empty');
    updateToBottom();
    return;
  }
  ui.shell.classList.remove('is-empty');
  c.messages.forEach((m, index) => ui.messages.append(messageNode(m, index, c, { animate: index >= animateFrom })));
  scrollToBottom();
  // Images load asynchronously; keep the view pinned to the newest content.
  for (const image of ui.messages.querySelectorAll('.message:last-of-type img')) {
    image.addEventListener('load', () => { if (nearBottom() || c.messages.at(-1)?.pending) scrollToBottom(); updateToBottom(); }, { once: true });
  }
  updateToBottom();
}

const frames = new Map();
function scheduleReplyRender(conversationId) {
  if (conversationId !== state.currentId || frames.has(conversationId)) return;
  frames.set(conversationId, requestAnimationFrame(() => {
    frames.delete(conversationId);
    const c = current();
    if (!c || c.id !== conversationId) return;
    const index = c.messages.length - 1;
    const stick = nearBottom();
    const old = ui.messages.querySelector(`.message[data-index="${index}"]`);
    const next = messageNode(c.messages[index], index, c);
    const oldDetails = old?.querySelector('details.reasoning');
    const newDetails = next.querySelector('details.reasoning');
    if (oldDetails && newDetails) {
      if (oldDetails.dataset.touched) { newDetails.open = oldDetails.open; newDetails.dataset.touched = '1'; }
      const ob = oldDetails.querySelector('.reasoning-body');
      const nb = newDetails.querySelector('.reasoning-body');
      if (ob && nb && ob.scrollHeight - ob.scrollTop - ob.clientHeight < 30) requestAnimationFrame(() => { nb.scrollTop = nb.scrollHeight; });
      else if (ob && nb) nb.scrollTop = ob.scrollTop;
    }
    // Keep already-loaded images from re-animating on every token.
    const loaded = new Set([...(old?.querySelectorAll('.image-card.loaded img') || [])].map((i) => i.src));
    for (const card of next.querySelectorAll('.image-card')) {
      const i = card.querySelector('img');
      if (i?.src && loaded.has(i.src)) { card.classList.add('loaded', 'settled'); i.style.aspectRatio = ''; }
    }
    if (old) old.replaceWith(next); else ui.messages.append(next);
    pinLiveCode(next);
    if (stick) scrollToBottom();
    updateToBottom();
  }));
}

// ---------- sending ----------
function updateComposer() {
  const c = current();
  const busy = c ? isStreaming(c.id) : false;
  const ready = Boolean(account()) && Boolean(selectedModel());
  const imageMode = ui.shell.classList.contains('mode-image');
  const hasText = Boolean(ui.input.value.trim());
  const hasAttachments = state.attachments.length > 0 || state.files.length > 0;
  ui.input.disabled = !account();
  ui.attach.disabled = !account();
  ui.send.disabled = busy || !ready || !(hasText || (!imageMode && hasAttachments));
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  ui.model.disabled = !account();
  const others = [...state.streams.keys()].filter((id) => id !== c?.id).length;
  ui.hint.textContent = busy
    ? (imageMode ? '图片生成通常需要 10–60 秒。' : '正在生成回复。') + '可以随时点左侧“新对话”同时开始另一个对话。'
    : others ? `另有 ${others} 个对话正在后台生成` : '';
  ui.hint.classList.toggle('show', Boolean(ui.hint.textContent));
}

function autoGrow() {
  ui.input.style.height = 'auto';
  ui.input.style.height = Math.min(ui.input.scrollHeight, 220) + 'px';
}

function titleFrom(text, fallback) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 28 ? line.slice(0, 28) + '…' : line || fallback;
}

function kindForSend() {
  const kind = effectiveKind();
  if (kind === 'video') { notice('视频生成模型暂不支持，请换一个对话或图片模型'); return null; }
  return kind === 'image' ? 'image' : 'chat';
}

async function submit() {
  const text = ui.input.value.trim();
  const existing = current();
  if (existing && isStreaming(existing.id)) return;
  if (!selectedModel()) { notice('请选择或填写模型'); return; }
  const kind = kindForSend();
  if (!kind) return;
  if (kind === 'image' && !text) { notice('请描述想要生成的画面'); ui.input.focus(); return; }
  if (kind === 'image' && state.files.length) { notice('图片模型读不了文本附件，请移除文件或换一个对话模型'); return; }
  if (!text && !state.attachments.length && !state.files.length) return;
  const c = existing || createConversation();
  Object.assign(c, settingsFromUi());
  const first = !c.messages.length;
  if (first) c.title = titleFrom(text, state.files[0]?.name || (kind === 'image' ? '图片生成' : '图片对话'));
  const message = { role: 'user', content: text, kind };
  if (state.attachments.length) message.images = [...state.attachments];
  if (state.files.length) message.files = [...state.files];
  c.messages.push(message);
  state.attachments = [];
  state.files = [];
  renderAttachments();
  ui.input.value = '';
  autoGrow();
  await generate(c, { first });
}

async function regenerate() {
  const c = current();
  if (!c || isStreaming(c.id)) return;
  const kind = kindForSend();
  if (!kind) return;
  // Check before dropping the old reply: a refused retry must not lose it (or its images).
  const replaced = c.messages.at(-1)?.role === 'assistant';
  const last = c.messages.at(replaced ? -2 : -1);
  if (last?.role !== 'user') return;
  if (kind === 'image' && !last.content) { notice('这条消息没有文字描述，无法用图片模型生成'); return; }
  if (kind === 'image' && last.files?.length) { notice('图片模型读不了文本附件，请换一个对话模型'); return; }
  if (replaced) releaseImages(c.messages.pop().images);
  last.kind = kind;
  Object.assign(c, settingsFromUi());
  await generate(c, {});
}

function editFrom(index) {
  const c = current();
  if (!c || isStreaming(c.id)) return;
  const m = c.messages[index];
  if (index < c.messages.length - 1 && !confirm('编辑这条消息会删除它之后的所有回复，继续吗？')) return;
  const removed = c.messages.slice(index);
  c.messages = c.messages.slice(0, index);
  state.attachments = [...(m.images || [])];
  state.files = [...(m.files || [])];
  releaseImages(removed.flatMap(blobIds));
  renderAttachments();
  ui.input.value = m.content;
  autoGrow();
  saveConversations();
  renderMessages();
  renderHistory();
  ui.input.focus();
  updateComposer();
}

const CHAT_IMAGE_BYTES = 11 * 1024 * 1024;
const CHAT_IMAGE_COUNT = 16;

// Text attachments go in front of the message, each in a fence longer than any
// backtick run inside it so the file cannot close the block early.
async function withFiles(m) {
  if (!m.files?.length) return m.content || '';
  const parts = [];
  for (const f of m.files) {
    const blob = await img.blobOf(f.id);
    if (!blob) { parts.push(`（附件 ${f.name} 已不在本地存储中）`); continue; }
    const text = await blob.text();
    let longest = 0;
    for (const run of text.matchAll(/`{3,}/g)) longest = Math.max(longest, run[0].length);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    parts.push(`附件：${f.name}\n${fence}${f.lang || ''}\n${text}\n${fence}`);
  }
  if (m.content) parts.push(m.content);
  return parts.join('\n\n');
}

// A reply that wrote files tells later turns about them (the workspace keeps them for 24 h).
function assistantText(m) {
  const files = (m.outputs || []).filter((f) => !f.removed).map((f) => f.path);
  if (!files.length) return m.content || '';
  return `${m.content || ''}\n\n[已在本对话的临时工作区写入文件：${[...new Set(files)].join('、')}]`.trim();
}

// Chat history for the upstream. Image prompts/replies are skipped; attached
// images are re-sent newest-first within a size budget.
async function chatHistory(c) {
  const list = c.messages.filter((m) => !m.pending && m.kind !== 'image' && (!m.error || (m.role === 'assistant' && m.content)) &&
    (m.role === 'user' ? (m.content || m.images?.length || m.files?.length) : m.role === 'assistant' && (m.content || m.outputs?.length)));
  let bytes = 0;
  let count = 0;
  let omitted = 0;
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const entry = { role: m.role, content: m.role === 'user' ? await withFiles(m) : assistantText(m) };
    if (m.role === 'user' && m.images?.length) {
      const urls = [];
      for (const id of m.images) {
        const blob = await img.blobOf(id);
        if (!blob || bytes + blob.size > CHAT_IMAGE_BYTES || count >= CHAT_IMAGE_COUNT) { omitted++; continue; }
        bytes += blob.size;
        count++;
        urls.push(await img.blobToDataUrl(blob));
      }
      if (urls.length) entry.images = urls;
      if (!entry.content && !urls.length) entry.content = '[图片]';
    }
    out.unshift(entry);
  }
  return { messages: out, omitted };
}

const LENGTH_REASONS = ['length', 'max_tokens', 'max_output_tokens'];
const CONTINUE_PROMPT = '你的上一条回复被截断了（输出上限或网络/上游中断）。请从中断的地方直接接着写，不要重复已经写过的内容，也不要加任何开场白；如果断在代码块里，就直接续写代码。';
// Cut off at the output limit, or by an upstream/network error after some text came: both can be continued.
const truncated = (m) => m.role === 'assistant' && m.kind !== 'image' && (LENGTH_REASONS.includes(m.finish) || Boolean(m.error && m.content));

// Continues a reply that stopped at the output limit, appending to the same message.
async function continueReply() {
  const c = current();
  const last = c?.messages.at(-1);
  if (!c || isStreaming(c.id) || !last || !truncated(last)) return;
  if (kindForSend() !== 'chat') { notice('请先切回对话模型再继续生成'); return; }
  Object.assign(c, settingsFromUi());
  await generate(c, { resume: last });
}

async function generate(c, { first, resume } = {}) {
  clearNotice();
  const settings = settingsFromUi();
  const prompt = resume ? c.messages.at(-2) : c.messages.at(-1);
  const imageJob = !resume && prompt.kind === 'image';
  let reply;
  if (resume) {
    reply = resume;
    reply.resumeFrom = reply.content.length;
    Object.assign(reply, { pending: true, finish: undefined, error: undefined, notice: undefined, status: undefined, startedAt: Date.now(), model: settings.model, effort: settings.effort });
    reply.prevMs = (reply.prevMs || 0) + (reply.ms || 0);
    reply.prevUsage = sumUsage(reply.prevUsage, reply.usage);
    reply.usage = undefined;
    reply.ms = undefined;
  } else {
    reply = imageJob
      ? { role: 'assistant', kind: 'image', content: '', images: [], pending: true, model: settings.model, size: settings.size, expected: Number(settings.n) || 1, startedAt: Date.now() }
      : { role: 'assistant', content: '', reasoning: '', images: [], pending: true, model: settings.model, effort: settings.effort, startedAt: Date.now() };
  }
  const controller = new AbortController();
  state.streams.set(c.id, { controller, reply });
  let path;
  let body;
  try {
    if (imageJob) {
      const refs = (await Promise.all((prompt.images || []).map(img.dataUrlOf))).filter(Boolean);
      path = '/api/chat/images';
      body = {
        accountId: settings.accountId, model: settings.model, prompt: prompt.content, images: refs.length ? refs : undefined,
        size: settings.size || undefined, quality: settings.quality || undefined, n: Number(settings.n) || 1,
      };
    } else {
      // While resuming, `reply` is still the last message; chatHistory skips it
      // because it is pending, so add the partial text back explicitly.
      const { messages, omitted } = await chatHistory(c);
      if (resume) messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: CONTINUE_PROMPT });
      if (omitted) reply.notice = `较早的 ${omitted} 张图片没有重新发送（超出单次请求大小）。`;
      path = '/api/chat/completions';
      body = {
        accountId: settings.accountId, model: settings.model, messages,
        system: settings.system || undefined, effort: settings.effort || undefined,
        effortFormat: settings.effortFormat, apiType: settings.apiMode,
        temperature: settings.temperature === '' ? undefined : Number(settings.temperature),
        maxTokens: settings.maxTokens === '' ? undefined : Number(settings.maxTokens),
        conversationId: c.id, fileTools: settings.fileTools !== false,
      };
    }
  } catch {
    state.streams.delete(c.id);
    if (resume) Object.assign(reply, { pending: false, finish: 'length' });
    notice('读取本地图片失败');
    renderMessages();
    updateComposer();
    return;
  }
  if (!resume) c.messages.push(reply);
  c.updatedAt = Date.now();
  if (c.id === state.currentId) {
    if (resume) { scheduleReplyRender(c.id); syncActions(c); }
    else renderMessages({ animateFrom: c.messages.length - 2 });
  }
  renderHistory({ animateId: first ? c.id : undefined });
  updateComposer();
  if (c.id === state.currentId) ui.live.textContent = imageJob ? '正在生成图片' : '正在生成回复';
  saveConversations();

  try {
    if (imageJob) {
      const started = await api(path, { method: 'POST', signal: controller.signal, body });
      reply.jobId = started.jobId;
      reply.jobNext = 0;
      saveConversations();
      await followImageJob(c, reply, controller.signal);
      return;
    }
    const response = await request(path, { method: 'POST', signal: controller.signal, body });
    if (!response.ok || !response.body) {
      let data;
      try { data = await response.json(); } catch { data = undefined; }
      throw new Error(data?.error || `请求失败（${response.status}）`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (handleEvent(reply, event)) {
          if (event.type === 'image') saveConversations(); else saveSoon();
          scheduleReplyRender(c.id);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') reply.finish = reply.finish || 'stopped';
    else reply.error = friendlyError(error);
  } finally {
    finishReply(c, reply, controller, { resume, imageJob });
  }
}

// Image jobs run on the server; this follows their events with short polls and
// downloads finished images, retrying through flaky connections and reloads.
async function followImageJob(c, reply, signal) {
  const base = `/api/chat/jobs/${encodeURIComponent(reply.jobId)}`;
  let failures = 0;
  let status = 'running';
  const fetched = new Set(reply.jobFetched || []);
  while (!signal.aborted) {
    let data;
    try {
      const response = await fetch(`${base}/events?after=${reply.jobNext || 0}`, { credentials: 'same-origin', cache: 'no-store', signal });
      if (response.status === 401) { window.top.location.href = '/'; return; }
      if (response.status === 404) { reply.error = reply.images.length ? undefined : '这次生成的记录已过期（服务器只保留 24 小时）'; return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      failures++;
      reply.notice = failures > 2 ? '网络不稳定，正在重连…图片仍在服务器上生成，不会丢失。' : reply.notice;
      scheduleReplyRender(c.id);
      await sleep(Math.min(15000, 1000 * 2 ** Math.min(failures, 4)), signal);
      continue;
    }
    if (failures === 0 && reply.notice?.startsWith('网络不稳定')) reply.notice = undefined;
    let changed = false;
    for (const event of data.events) {
      if (event.type === 'image') {
        if (fetched.has(event.index)) continue;
        const id = await downloadJobImage(`${base}/images/${event.index}`, event, signal, (p) => { reply.progress = p; scheduleReplyRender(c.id); });
        if (!id) break; // aborted
        fetched.add(event.index);
        reply.jobFetched = [...fetched];
        reply.images = [...reply.images, id];
        reply.progress = undefined;
        saveConversations();
        changed = true;
      } else if (handleEvent(reply, event)) changed = true;
      reply.jobNext = event.seq + 1;
    }
    if (changed) scheduleReplyRender(c.id);
    status = data.status;
    if (status !== 'running' && (reply.jobNext || 0) >= data.next) break;
  }
  if (signal.aborted && status === 'running') {
    request(`${base}/cancel`, { method: 'POST', body: {} }).catch(() => {});
  }
}

// Downloads one image with resume (HTTP Range) so a dropped connection on a
// large 4K PNG continues where it stopped. Returns the stored image id.
async function downloadJobImage(url, info, signal, onProgress) {
  const parts = [];
  let received = 0;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal, headers: received ? { Range: `bytes=${received}-` } : {} });
      if (response.status === 416 && received) break;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (received && response.status !== 206) { parts.length = 0; received = 0; }
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.length;
        onProgress?.({ received, total: info.bytes });
      }
      if (!info.bytes || received >= info.bytes) break;
      throw new Error('incomplete');
    } catch (error) {
      if (signal.aborted) return null;
      if (++failures > 30) throw new Error('图片下载多次中断，请检查网络后点“重新生成”下方的重试');
      await sleep(Math.min(10000, 800 * 2 ** Math.min(failures, 4)), signal);
    }
  }
  if (signal.aborted) return null;
  return img.putBlob(uid(), new Blob(parts, { type: info.mime || 'image/png' }));
}

// Re-attaches to image jobs that were still running when the page was closed.
function resumeImageJobs() {
  for (const c of state.conversations) {
    const reply = c.messages.at(-1);
    if (!reply?.jobId || !reply.jobPending || isStreaming(c.id)) continue;
    const controller = new AbortController();
    reply.pending = true;
    reply.error = undefined;
    state.streams.set(c.id, { controller, reply });
    followImageJob(c, reply, controller.signal)
      .catch((error) => { reply.error = friendlyError(error); })
      .finally(() => finishReply(c, reply, controller, { imageJob: true }));
  }
  renderHistory();
}

function finishReply(c, reply, controller, { resume, imageJob }) {
  {
    reply.pending = false;
    reply.progress = undefined;
    reply.status = undefined;
    if (imageJob && reply.jobId) {
      // Page closed mid-job → resume on next load; anything else is final.
      reply.jobPending = false;
    }
    if (resume) {
      reply.ms = (reply.prevMs || 0) + (reply.ms || 0);
      reply.usage = sumUsage(reply.prevUsage, reply.usage);
      delete reply.prevMs;
      delete reply.prevUsage;
      delete reply.resumeFrom;
      // A failed continuation keeps the earlier text; let the user try again.
      if (controller.signal.aborted && !reply.error) reply.finish = reply.finish === 'stopped' ? 'stopped' : 'length';
    }
    if (controller.signal.aborted && !reply.error) reply.notice = [reply.notice, '已手动停止。'].filter(Boolean).join(' ');
    if (!reply.content && !reply.reasoning && !reply.images.length && !reply.outputs?.length && !reply.error && !controller.signal.aborted) {
      reply.error = imageJob ? '上游没有返回图片' : '上游没有返回内容';
    }
    state.streams.delete(c.id);
    c.updatedAt = Date.now();
    const stillExists = state.conversations.includes(c);
    if (stillExists) saveConversations();
    else releaseImages(reply.images);
    if (c.id === state.currentId) {
      const stick = nearBottom();
      const index = c.messages.length - 1;
      const old = ui.messages.querySelector(`.message[data-index="${index}"]`);
      if (old) {
        const next = messageNode(reply, index, c);
        for (const card of next.querySelectorAll('.image-card')) {
          const i = card.querySelector('img');
          if ([...old.querySelectorAll('.image-card.loaded img')].some((o) => o.src === i?.src)) { card.classList.add('loaded', 'settled'); i.style.aspectRatio = ''; }
        }
        old.replaceWith(next);
        // Earlier messages were drawn while busy (no edit/regenerate buttons).
        syncActions(c);
      } else renderMessages();
      if (stick) scrollToBottom();
      ui.live.textContent = reply.error ? `出错：${reply.error}` : imageJob ? `已生成 ${reply.images.length} 张图片` : '回复完成';
    } else if (stillExists && !reply.error) {
      notice(`“${c.title}”已${imageJob ? '生成图片' : '生成完成'}`, 'info');
    }
    renderHistory();
    updateComposer();
  }
}

function sumUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const add = (x, y) => (x == null && y == null ? undefined : (x || 0) + (y || 0));
  // input is re-sent on every continuation, so keep the largest instead of summing
  const larger = b.input != null && (a.input == null || b.input >= a.input) ? b : a;
  return {
    input: Math.max(a.input || 0, b.input || 0) || undefined, output: add(a.output, b.output), reasoning: add(a.reasoning, b.reasoning),
    cacheRead: larger.cacheRead, cacheWrite: add(a.cacheWrite, b.cacheWrite),
  };
}

function handleEvent(reply, event) {
  switch (event.type) {
    case 'delta':
      reply.status = undefined;
      // Join a continuation cleanly when the model restarts mid-word with a space/newline.
      if (reply.resumeFrom !== undefined && reply.content.length === reply.resumeFrom) {
        reply.content += event.text.replace(/^\n{3,}/, '\n\n');
        return true;
      }
      reply.content += event.text;
      return true;
    case 'reasoning': reply.reasoning = (reply.reasoning || '') + event.text; return true;
    case 'image': {
      const blob = typeof event.url === 'string' ? img.dataUrlToBlob(event.url) : null;
      if (!blob) return false;
      reply.images = [...(reply.images || []), img.putBlob(uid(), blob)];
      return true;
    }
    case 'start': if (event.n) reply.expected = event.n; return false;
    case 'usage': reply.usage = event.usage; return false;
    case 'finish': reply.finish = event.reason; return false;
    case 'first': reply.firstMs = event.ms; return false;
    case 'done': reply.ms = event.ms; return false;
    case 'notice':
      // Retry/resume progress is shown while it lasts, not kept with the reply.
      if (event.transient) { reply.status = event.message; return true; }
      reply.notice = [reply.notice, event.message].filter(Boolean).join('\n');
      return true;
    case 'tool': {
      const tools = reply.tools || (reply.tools = []);
      const t = tools.find((x) => x.id === event.id);
      const next = { id: event.id, name: event.name, status: event.status, label: event.label || t?.label || event.name, chars: event.chars, summary: event.summary };
      if (t) Object.assign(t, next); else tools.push(next);
      reply.status = undefined;
      return true;
    }
    case 'file': {
      const outputs = reply.outputs || (reply.outputs = []);
      const i = outputs.findIndex((f) => f.path === event.file.path);
      if (i >= 0) outputs[i] = event.file; else outputs.push(event.file);
      saveSoon();
      return true;
    }
    case 'file_removed':
      for (const f of reply.outputs || []) if (f.path === event.path) f.removed = true;
      return true;
    case 'error': reply.error = event.message; return true;
    default: return false;
  }
}

// ---------- panels ----------
function setSettingsOpen(open) {
  ui.settings.classList.toggle('open', open);
  ui.settings.setAttribute('aria-hidden', String(!open));
  ui.settings.inert = !open;
  ui.toggleSettings.setAttribute('aria-expanded', String(open));
  ui.toggleSettings.classList.toggle('active', open);
}

// ---------- wiring ----------
function bind() {
  ui.composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchInput.matches) { e.preventDefault(); submit(); }
  });
  compactInput.addEventListener('change', () => { updateMode(); autoGrow(); });
  ui.exportChats.addEventListener('click', () => busy(ui.exportChats, exportConversations));
  ui.importChats.addEventListener('click', () => ui.importFile.click());
  ui.importFile.addEventListener('change', () => { const file = ui.importFile.files[0]; ui.importFile.value = ''; if (file) importConversations(file); });
  ui.input.addEventListener('input', () => { autoGrow(); updateComposer(); });
  // Also when the main site first shows this page: it may have been loaded in a hidden frame.
  addEventListener('resize', autoGrow);
  ui.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(files);
  });
  ui.attach.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => { addFiles(ui.fileInput.files); ui.fileInput.value = ''; });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  ui.main.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; ui.shell.classList.add('dragging'); });
  ui.main.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  ui.main.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; ui.shell.classList.remove('dragging'); } });
  ui.main.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    ui.shell.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  ui.stop.addEventListener('click', () => state.streams.get(state.currentId)?.controller.abort());
  ui.newChat.addEventListener('click', startNew);
  ui.account.addEventListener('change', () => { renderModels(); persistSettings(); });
  ui.model.addEventListener('change', () => {
    ui.modelCustom.hidden = ui.model.value !== CUSTOM;
    if (!ui.modelCustom.hidden) ui.modelCustom.focus();
    updateMode();
    persistSettings();
  });
  ui.modelCustom.addEventListener('input', () => { updateMode(); persistSettings(); });
  ui.refreshModels.addEventListener('click', () => refreshModels());
  ui.imageMode.addEventListener('change', () => { updateMode(); persistSettings(); });
  for (const control of [ui.effort, ui.effortFormat, ui.apiType, ui.temperature, ui.maxTokens, ui.fileTools, ui.system, ui.imageSize, ui.imageN, ui.imageQuality]) {
    control.addEventListener('change', persistSettings);
  }
  ui.toggleSettings.addEventListener('click', () => setSettingsOpen(!ui.settings.classList.contains('open')));
  // 外观 is a site-wide choice (embed.js applies it on every page), not a per-conversation setting.
  if (window.prismTheme) {
    ui.theme.value = window.prismTheme.get();
    ui.theme.addEventListener('change', () => window.prismTheme.set(ui.theme.value));
  } else ui.theme.closest('.field').hidden = true;
  ui.preset.addEventListener('change', applyPreset);
  ui.presetSave.addEventListener('click', savePreset);
  ui.presetDelete.addEventListener('click', deletePreset);
  ui.system.addEventListener('input', syncPreset);
  let searchTimer;
  ui.historySearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = ui.historySearch.value.trim().toLowerCase(); renderHistory(); }, 120);
  });
  ui.historySearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ui.historySearch.value) return;
    e.stopPropagation();
    ui.historySearch.value = '';
    state.search = '';
    renderHistory();
  });
  ui.messages.addEventListener('scroll', updateToBottom, { passive: true });
  ui.messages.addEventListener('toggle', (e) => { if (e.target.matches?.('details.reasoning')) e.target.dataset.touched = '1'; }, true);
  ui.toBottom.addEventListener('click', () => scrollToBottom(true));
  ui.empty.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-prompt]');
    if (!b) return;
    ui.input.value = b.dataset.prompt;
    autoGrow();
    updateComposer();
    ui.input.focus();
    ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length);
  });

  ui.lightboxClose.addEventListener('click', () => ui.lightbox.close());
  ui.lightbox.addEventListener('click', (e) => { if (e.target === ui.lightbox) ui.lightbox.close(); });
  ui.lightboxDownload.addEventListener('click', (e) => { e.preventDefault(); downloadImage(state.lightboxId); });
  ui.lightboxEdit.addEventListener('click', () => attachExisting(state.lightboxId));

  document.addEventListener('keydown', (e) => {
    if (ui.lightbox.open) return;
    if (e.key === 'Escape' && ui.settings.classList.contains('open')) setSettingsOpen(false);
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); startNew(); }
  });
  window.addEventListener('pagehide', saveConversations);
}

// Another tab saved: show its changes, unless this tab is in the middle of a reply.
async function reloadFromOtherTab() {
  if (state.streams.size) return;
  const keep = state.currentId;
  await loadConversations();
  if (!state.conversations.some((c) => c.id === keep)) createConversation(); else state.currentId = keep;
  renderHistory();
  renderMessages();
}

async function init() {
  bind();
  setSettingsOpen(false);
  autoGrow(); // the placeholder wraps to two lines on phones
  ui.shell.classList.add('ready');
  try {
    showUser(await loadSession());
    const data = await api('/api/chat/accounts');
    state.accounts = data.accounts || [];
  } catch (error) {
    notice(error.message || '加载失败');
    ui.account.replaceChildren(new Option('加载失败', ''));
    return;
  }
  renderAccounts();
  const p = prefs();
  if (p.accountId && state.accounts.some((a) => a.id === p.accountId && a.usable)) ui.account.value = p.accountId;
  if (p.effort !== undefined) ui.effort.value = p.effort;
  if (p.effortFormat) ui.effortFormat.value = p.effortFormat;
  ui.apiType.value = apiModeOf(p);
  if (p.temperature !== undefined) ui.temperature.value = p.temperature;
  if (p.maxTokens !== undefined) ui.maxTokens.value = p.maxTokens;
  if (p.imageMode) ui.imageMode.value = p.imageMode;
  if (p.size !== undefined) ui.imageSize.value = p.size;
  if (p.n) ui.imageN.value = p.n;
  if (p.quality !== undefined) ui.imageQuality.value = p.quality;
  renderPresets();
  renderModels(p.lastModel?.[ui.account.value]);
  await loadConversations();
  store.onExternalChange(uid(), reloadFromOtherTab);
  createConversation();
  renderHistory();
  renderMessages();
  updateComposer();
  img.collectGarbage(uid(), referencedIds());
  onShown(reloadAccounts);
  resumeImageJobs();
  if (current() && isStreaming(current().id)) renderMessages();
  updateComposer();
  if (!state.accounts.some((a) => a.usable)) notice('还没有保存密钥的 API。请先到“API 管理”添加。', 'info');
  ui.input.focus();
}

init();
