// Temporary files the model creates with its file tools (see tools.js). Each
// conversation has its own small workspace; the owner downloads files through
// /api/chat/files/<id>. Everything expires (24 h by default) and is bounded per
// file, per user and in total, so a busy model cannot fill the disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AppError } from './vault.js';
import { writeAtomic } from './util.js';

export const FILE_LIMITS = {
  fileBytes: 10 * 1024 * 1024, // one file
  convFiles: 60, // files per conversation
  userBytes: 80 * 1024 * 1024, // all of one user's files
  totalBytes: 1024 * 1024 * 1024, // the whole store; oldest files go first
  ttlMs: 24 * 3600 * 1000,
};

const ID = /^[a-f0-9]{32}$/;
const userKey = (userId) => crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);

/**
 * A workspace path: relative, '/'-separated, at most 6 levels, no '.'/'..'
 * segments and no characters that are unsafe in a download name.
 */
export function cleanPath(raw) {
  if (typeof raw !== 'string') throw new AppError('INVALID_PATH', '文件路径无效', 400);
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.length > 6 || parts.some((p) => p === '..' || p.length > 120 || /[\u0000-\u001f<>:"|?*\u007f]/.test(p) || /^\s|\s$/.test(p))) {
    throw new AppError('INVALID_PATH', `文件路径无效：${String(raw).slice(0, 200)}`, 400);
  }
  const clean = parts.join('/');
  if (clean.length > 300) throw new AppError('INVALID_PATH', '文件路径过长', 400);
  return clean;
}

const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'application/xml', svg: 'image/svg+xml',
  py: 'text/x-python', ts: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', zip: 'application/zip', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', ico: 'image/x-icon',
};
export const mimeOf = (name) => MIME[(/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase()] || 'application/octet-stream';

export function createFileStore({ dir = null, limits = FILE_LIMITS, log = () => {} } = {}) {
  const L = { ...FILE_LIMITS, ...limits };
  const files = new Map(); // id -> meta { id, user, conv, path, size, createdAt, updatedAt, expiresAt }
  const memory = new Map(); // id -> Buffer (when there is no dir: tests, local runs)
  let total = 0;

  const blobFile = (m) => path.join(dir, m.user, `${m.id}.bin`);
  const metaFile = (m) => path.join(dir, m.user, `${m.id}.json`);

  function load() {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const user of fs.readdirSync(dir)) {
      const folder = path.join(dir, user);
      let names;
      try { names = fs.readdirSync(folder); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
          if (!ID.test(m.id) || m.user !== user || !fs.existsSync(blobFile(m))) throw new Error('stale');
          files.set(m.id, m);
          total += m.size;
        } catch { fs.rmSync(path.join(folder, name), { force: true }); }
      }
      // Blobs without metadata (a crash between the two writes).
      for (const name of names) if (name.endsWith('.bin') && !files.has(name.slice(0, -4))) fs.rmSync(path.join(folder, name), { force: true });
    }
    sweep();
  }

  function remove(m) {
    files.delete(m.id);
    memory.delete(m.id);
    total -= m.size;
    if (dir) {
      fs.rmSync(blobFile(m), { force: true });
      fs.rmSync(metaFile(m), { force: true });
    }
  }

  /** Drops expired files, then the oldest ones while the store is over its total size. */
  function sweep(now = Date.now()) {
    let removed = 0;
    for (const m of [...files.values()]) if (m.expiresAt <= now) { remove(m); removed++; }
    if (total > L.totalBytes) {
      for (const m of [...files.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
        if (total <= L.totalBytes * 0.9) break;
        remove(m);
        removed++;
      }
    }
    if (dir) for (const user of fs.readdirSync(dir)) {
      try { fs.rmdirSync(path.join(dir, user)); } catch { /* not empty */ }
    }
    if (removed) log({ event: 'files_swept', removed, totalMb: Math.round(total / 1048576) });
    return removed;
  }

  const inConv = (userId, conv) => {
    const user = userKey(userId);
    return [...files.values()].filter((m) => m.user === user && m.conv === conv).sort((a, b) => a.path.localeCompare(b.path));
  };
  const find = (userId, conv, p) => inConv(userId, conv).find((m) => m.path === p);

  async function read(m) {
    if (!dir) return memory.get(m.id) || Buffer.alloc(0);
    return fs.promises.readFile(blobFile(m));
  }

  async function write(userId, conv, rawPath, data) {
    const p = cleanPath(rawPath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (buffer.length > L.fileBytes) throw new AppError('TOO_LARGE', `单个文件不能超过 ${L.fileBytes / 1048576} MB`, 413);
    const user = userKey(userId);
    const old = find(userId, conv, p);
    if (!old && inConv(userId, conv).length >= L.convFiles) throw new AppError('TOO_MANY', `每个对话最多 ${L.convFiles} 个文件，请先删除不需要的文件`, 409);
    const used = [...files.values()].filter((m) => m.user === user).reduce((n, m) => n + m.size, 0) - (old?.size || 0);
    if (used + buffer.length > L.userBytes) throw new AppError('TOO_LARGE', `临时文件总量已达上限（${L.userBytes / 1048576} MB），请删除一些文件或等待过期清理`, 413);
    const now = Date.now();
    const m = old ? { ...old } : { id: crypto.randomBytes(16).toString('hex'), user, conv, path: p, createdAt: now };
    Object.assign(m, { size: buffer.length, updatedAt: now, expiresAt: now + L.ttlMs });
    if (dir) {
      await fs.promises.mkdir(path.join(dir, user), { recursive: true, mode: 0o700 });
      const tmp = `${blobFile(m)}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, buffer, { mode: 0o600 });
      await fs.promises.rename(tmp, blobFile(m));
      writeAtomic(metaFile(m), JSON.stringify(m));
    } else memory.set(m.id, buffer);
    total += buffer.length - (old?.size || 0);
    files.set(m.id, m);
    if (total > L.totalBytes) sweep();
    return view(m);
  }

  function view(m) {
    return { id: m.id, path: m.path, name: path.posix.basename(m.path), size: m.size, expiresAt: m.expiresAt };
  }

  /** The owner's file by id, or null. */
  function owned(userId, id) {
    if (!ID.test(String(id))) return null;
    const m = files.get(id);
    return m && m.user === userKey(userId) && m.expiresAt > Date.now() ? m : null;
  }

  const timer = setInterval(() => { try { sweep(); } catch (error) { log({ event: 'files_sweep_failed', code: error?.code }); } }, 10 * 60 * 1000);
  timer.unref();
  load();

  return {
    limits: L,
    get totalBytes() { return total; },
    get count() { return files.size; },
    list: (userId, conv) => inConv(userId, conv).map(view),
    find: (userId, conv, p) => { const m = find(userId, conv, cleanPath(p)); return m ? { meta: m, view: view(m) } : null; },
    write,
    read,
    async remove(userId, conv, rawPath) {
      const m = find(userId, conv, cleanPath(rawPath));
      if (!m) return false;
      remove(m);
      return true;
    },
    clear(userId, conv) { for (const m of inConv(userId, conv)) remove(m); },
    owned,
    view,
    sweep,
    close: () => clearInterval(timer),
  };
}

// ---------- zip (stored or deflated, no zip64) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data: Buffer }] -> zip Buffer (UTF-8 names). */
export function zipBuffer(entries, date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
