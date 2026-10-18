// Conversation history in IndexedDB. The old store, localStorage, holds only
// ~5 MB and silently dropped the oldest conversations when it was full;
// IndexedDB gets a share of the disk. Records are keyed `<userId>:<id>` and
// only conversations that changed are written. Tabs tell each other about
// saves over a BroadcastChannel (localStorage's storage event did this before).
// Without IndexedDB (some private modes) localStorage is still used.

const DB_NAME = 'prism-chat-data';
const STORE = 'conversations';
const legacyKey = (userId) => `prism-chat:v1:${userId}`;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('prism-chat-conversations') : null;
const written = new Map(); // conversation id -> JSON as last written by this tab
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

// Resolves with the request's result when the transaction commits; rejects on error (e.g. quota).
function transact(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let result;
    try {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    } catch (error) { reject(error); }
  });
}

const valid = (list) => (Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages)) : []);

function readLegacy(userId) {
  try { return valid(JSON.parse(localStorage.getItem(legacyKey(userId)) || '[]')); } catch { return []; }
}

/** All saved conversations of this user (moving any left in localStorage over). */
export async function loadConversations(userId) {
  const db = await openDb();
  written.clear();
  if (!db) return readLegacy(userId);
  const range = IDBKeyRange.bound(`${userId}:`, `${userId}:￿`);
  let list = valid(await transact(db, 'readonly', (store) => store.getAll(range)).catch(() => []));
  for (const c of list) written.set(c.id, JSON.stringify(c));
  const legacy = readLegacy(userId).filter((c) => !written.has(c.id));
  if (legacy.length) {
    try {
      await transact(db, 'readwrite', (store) => { for (const c of legacy) store.put(c, `${userId}:${c.id}`); });
      for (const c of legacy) written.set(c.id, JSON.stringify(c));
      list = [...list, ...legacy];
      localStorage.removeItem(legacyKey(userId));
    } catch { /* stays in localStorage; tried again next time */ }
  } else {
    try { localStorage.removeItem(legacyKey(userId)); } catch { /* ignore */ }
  }
  return list;
}

/**
 * Saves `list` (the conversations worth keeping). Resolves with
 * { ok: true } or { ok: false, dropped } when storage is full.
 */
export async function saveConversations(userId, list) {
  const db = await openDb();
  if (!db) return saveLegacy(userId, list);
  const keep = new Set();
  const changed = [];
  for (const c of list) {
    keep.add(c.id);
    const json = JSON.stringify(c);
    if (written.get(c.id) !== json) changed.push([c, json]);
  }
  const removed = [...written.keys()].filter((id) => !keep.has(id));
  if (!changed.length && !removed.length) return { ok: true };
  try {
    await transact(db, 'readwrite', (store) => {
      // The JSON snapshot, not the live object: exactly what was compared above.
      for (const [c, json] of changed) store.put(JSON.parse(json), `${userId}:${c.id}`);
      for (const id of removed) store.delete(`${userId}:${id}`);
    });
  } catch {
    return { ok: false, dropped: 0 };
  }
  for (const [c, json] of changed) written.set(c.id, json);
  for (const id of removed) written.delete(id);
  channel?.postMessage({ userId });
  return { ok: true };
}

// Fallback: newest first; when even that does not fit, the oldest are dropped and reported.
function saveLegacy(userId, list) {
  for (let keepCount = list.length; keepCount >= 0; keepCount--) {
    try {
      localStorage.setItem(legacyKey(userId), JSON.stringify(list.slice(0, keepCount)));
      return keepCount === list.length ? { ok: true } : { ok: false, dropped: list.length - keepCount };
    } catch { /* quota: try with fewer */ }
  }
  return { ok: false, dropped: list.length };
}

/** Calls fn when another tab saved this user's conversations. */
export function onExternalChange(userId, fn) {
  if (channel) channel.addEventListener('message', (e) => { if (e.data?.userId === userId) fn(); });
  window.addEventListener('storage', (e) => { if (e.key === legacyKey(userId)) fn(); });
}
