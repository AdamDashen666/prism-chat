// Image storage for chat history. Blobs live in IndexedDB (localStorage is far
// too small for images); messages only keep ids. Falls back to memory when
// IndexedDB is unavailable (e.g. some private-browsing modes).

const DB_NAME = 'prism-chat-images';
const STORE = 'images';
const memory = new Map(); // id -> Blob (fallback + write-through cache)
const urls = new Map(); // id -> object URL
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    let result;
    try {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

// Ids carry a timestamp so garbage collection can skip fresh blobs that another
// tab may not have saved into its history yet.
export function newId(userId) {
  return `${userId}:${Date.now().toString(36)}:${crypto.randomUUID()}`;
}

// Stores a blob and returns its id. The object URL is available immediately.
export function putBlob(userId, blob) {
  const id = newId(userId);
  memory.set(id, blob);
  urls.set(id, URL.createObjectURL(blob));
  run('readwrite', (store) => store.put(blob, id));
  return id;
}

export function cachedUrl(id) {
  return urls.get(id) || '';
}

export async function blobOf(id) {
  if (memory.has(id)) return memory.get(id);
  const blob = await run('readonly', (store) => store.get(id));
  if (blob instanceof Blob) memory.set(id, blob);
  return blob instanceof Blob ? blob : null;
}

export async function urlOf(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await blobOf(id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlOf(id) {
  const blob = await blobOf(id);
  return blob ? blobToDataUrl(blob) : '';
}

// Decodes a data: URL without fetch (CSP connect-src does not allow data:).
export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

export function remove(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  for (const id of list) {
    memory.delete(id);
    const url = urls.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.delete(id);
  }
  run('readwrite', (store) => { for (const id of list) store.delete(id); });
}

// Deletes stored images for this user that no message references any more.
export async function collectGarbage(userId, keep) {
  const keys = await run('readonly', (store) => store.getAllKeys());
  if (!Array.isArray(keys)) return;
  const prefix = `${userId}:`;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  remove(keys.filter((k) => {
    if (typeof k !== 'string' || !k.startsWith(prefix) || keep.has(k)) return false;
    const created = parseInt(k.slice(prefix.length).split(':')[0], 36);
    return Number.isFinite(created) && created < cutoff;
  }));
}

const MAX_SIDE = 2048;
const MAX_BYTES = 3.5 * 1024 * 1024;
export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Downscales large photos before upload. Small images and GIFs pass through.
export async function prepareFile(file) {
  if (!ACCEPTED.includes(file.type)) throw new Error(`不支持的图片格式：${file.name || file.type}`);
  if (file.size > 40 * 1024 * 1024) throw new Error(`图片过大：${file.name}`);
  if (file.type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new Error('GIF 图片不能超过 3.5 MB');
    return file;
  }
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`无法读取图片：${file.name || ''}`); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES) { bitmap.close?.(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const type = file.type === 'image/png' && file.size <= MAX_BYTES * 2 ? 'image/png' : 'image/jpeg';
  let blob = await new Promise((r) => canvas.toBlob(r, type, 0.9));
  if (blob && blob.size > MAX_BYTES && type === 'image/png') blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) throw new Error('图片处理失败');
  return blob;
}

export function extensionOf(blob) {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[blob?.type] || 'png';
}
