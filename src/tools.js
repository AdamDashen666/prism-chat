// File tools offered to chat models: a temporary workspace per conversation
// (files.js) that the model can write, edit, read and bundle, and the user can
// download. Definitions are provider-neutral JSON Schema; anthropic.js and
// upstream.js wrap them in each API's tool format.
import path from 'node:path';
import { AppError } from './vault.js';
import { zipBuffer } from './files.js';

const MAX_READ_CHARS = 60_000;

export const FILE_TOOLS = [
  {
    name: 'write_file',
    description: 'Create, overwrite or append to a file in this conversation\'s temporary workspace on the server. ' +
      'The user immediately gets a download button for it. Use this whenever the user asks for a file, a document, ' +
      'a complete program or web page, or any long content they will save (code, HTML, CSV, Markdown, JSON, SVG...), ' +
      'instead of pasting very long content into the reply; then briefly say what the file contains. ' +
      'For very large files, write the first part and append the rest in further calls. ' +
      'Files are deleted automatically after 24 hours (max 10 MB each).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, e.g. "index.html" or "src/app.js".' },
        content: { type: 'string', description: 'Text to write (UTF-8), or base64 when encoding is "base64".' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Default "overwrite".' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default "utf8". Use base64 only for binary files.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact piece of text in an existing workspace file (the old text must appear exactly once). ' +
      'Prefer this over rewriting a whole file for small changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to find; include enough context to be unique.' },
        new_text: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the workspace. Long files are returned in pieces: pass offset (in characters) to continue.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description: 'List the files in this conversation\'s workspace with their sizes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'create_zip',
    description: 'Bundle workspace files into a .zip the user can download in one click (e.g. a multi-file project).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Name of the zip, e.g. "project.zip".' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths to include; all other files when omitted.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(FILE_TOOLS.map((t) => t.name));
export const isFileTool = (name) => TOOL_NAMES.has(name);

const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const str = (v, name) => {
  if (typeof v !== 'string') throw new AppError('INVALID', `参数 ${name} 必须是字符串`, 400);
  return v;
};

/** Short Chinese label for the UI while a call runs: 写入 index.html. */
export function toolLabel(name, args = {}) {
  const p = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'write_file': return `${args.mode === 'append' ? '追加' : '写入'} ${p}`;
    case 'edit_file': return `修改 ${p}`;
    case 'read_file': return `读取 ${p}`;
    case 'list_files': return '查看文件列表';
    case 'delete_file': return `删除 ${p}`;
    case 'create_zip': return `打包 ${p}`;
    default: return name;
  }
}

/**
 * Runs one tool call. Returns { output (string for the model), summary (for the
 * UI), file? (a file view to offer for download), removed? (path) }. Errors are
 * returned as { output, summary, error: true } so the model can correct itself.
 */
export async function runFileTool(store, userId, conv, name, args) {
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AppError('INVALID', '参数必须是 JSON 对象', 400);
    switch (name) {
      case 'write_file': {
        const p = str(args.path, 'path');
        const content = str(args.content, 'content');
        let data = args.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
        if (args.mode === 'append') {
          const old = store.find(userId, conv, p);
          if (old) data = Buffer.concat([await store.read(old.meta), data]);
        }
        const file = await store.write(userId, conv, p, data);
        return { output: `OK: ${file.path} (${file.size} bytes). The user can download it now.`, summary: `${file.path} · ${kb(file.size)}`, file };
      }
      case 'edit_file': {
        const p = str(args.path, 'path');
        const oldText = str(args.old_text, 'old_text');
        const newText = str(args.new_text, 'new_text');
        const found = store.find(userId, conv, p);
        if (!found) throw new AppError('NOT_FOUND', `文件不存在：${p}`, 404);
        const text = (await store.read(found.meta)).toString('utf8');
        if (!oldText) throw new AppError('INVALID', 'old_text 不能为空', 400);
        const first = text.indexOf(oldText);
        if (first < 0) throw new AppError('NOT_FOUND', 'old_text 在文件中不存在（必须逐字匹配，包括空格和换行）', 400);
        if (text.indexOf(oldText, first + 1) >= 0) throw new AppError('AMBIGUOUS', 'old_text 在文件中出现了多次，请包含更多上下文', 400);
        const file = await store.write(userId, conv, p, text.slice(0, first) + newText + text.slice(first + oldText.length));
        return { output: `OK: edited ${file.path} (${file.size} bytes).`, summary: `${file.path} · ${kb(file.size)}`, file };
      }
      case 'read_file': {
        const p = str(args.path, 'path');
        const found = store.find(userId, conv, p);
        if (!found) throw new AppError('NOT_FOUND', `文件不存在：${p}`, 404);
        const text = (await store.read(found.meta)).toString('utf8');
        const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
        const piece = text.slice(offset, offset + MAX_READ_CHARS);
        const rest = text.length - offset - piece.length;
        return {
          output: piece + (rest > 0 ? `\n\n[... ${rest} more characters; call read_file with offset ${offset + piece.length} to continue]` : ''),
          summary: `${found.view.path} · ${kb(found.view.size)}`,
        };
      }
      case 'list_files': {
        const list = store.list(userId, conv);
        return {
          output: list.length ? list.map((f) => `${f.path}\t${f.size} bytes`).join('\n') : '(the workspace is empty)',
          summary: `${list.length} 个文件`,
        };
      }
      case 'delete_file': {
        const p = str(args.path, 'path');
        const ok = await store.remove(userId, conv, p);
        if (!ok) throw new AppError('NOT_FOUND', `文件不存在：${p}`, 404);
        return { output: `OK: deleted ${p}.`, summary: p, removed: p };
      }
      case 'create_zip': {
        const target = str(args.path, 'path');
        const zipName = target.toLowerCase().endsWith('.zip') ? target : `${target}.zip`;
        const all = store.list(userId, conv).filter((f) => f.path !== zipName && !f.path.toLowerCase().endsWith('.zip'));
        const wanted = Array.isArray(args.files) && args.files.length ? args.files.map((f) => str(f, 'files')) : null;
        const chosen = wanted ? wanted.map((w) => {
          const hit = store.find(userId, conv, w);
          if (!hit) throw new AppError('NOT_FOUND', `文件不存在：${w}`, 404);
          return hit.view;
        }) : all;
        if (!chosen.length) throw new AppError('INVALID', '没有可以打包的文件', 400);
        const entries = [];
        for (const f of chosen) entries.push({ name: f.path, data: await store.read(store.find(userId, conv, f.path).meta) });
        const file = await store.write(userId, conv, zipName, zipBuffer(entries));
        return { output: `OK: ${file.path} with ${entries.length} files (${file.size} bytes).`, summary: `${file.path} · ${entries.length} 个文件 · ${kb(file.size)}`, file };
      }
      default:
        throw new AppError('UNKNOWN_TOOL', `没有这个工具：${name}`, 400);
    }
  } catch (error) {
    const message = error instanceof AppError ? error.message : '工具执行失败';
    if (!(error instanceof AppError)) console.warn(JSON.stringify({ event: 'tool_failed', tool: name, code: error?.code }));
    return { output: `Error: ${message}`, summary: message, error: true };
  }
}

/** Parses tool-call arguments (a JSON string or an object). Returns { args } or { error }. */
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return { args: raw };
  const text = String(raw ?? '').trim();
  if (!text) return { args: {} };
  try {
    const args = JSON.parse(text);
    return args && typeof args === 'object' && !Array.isArray(args) ? { args } : { error: 'arguments must be a JSON object' };
  } catch {
    return { error: 'the arguments were not valid JSON (possibly cut off by the output limit); write smaller pieces, using mode "append"' };
  }
}

export const downloadName = (p) => path.posix.basename(p);
