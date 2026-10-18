// API keys for the Codex 转发 endpoint (/chat/codex/v1): created and revoked by
// an admin, copyable again later (they live in the encrypted state file).
import crypto from 'node:crypto';
import { AppError } from '../vault.js';

const PREFIX = 'sk-codex-';
const TOKEN = /^sk-codex-[A-Za-z0-9_-]{32}$/;
const MAX_KEYS = 20;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createCodexKeys({ store, now = Date.now }) {
  const byHash = new Map();
  const reindex = () => {
    byHash.clear();
    for (const k of store.state.keys) byHash.set(k.keyHash, k);
  };
  reindex();

  const view = (k) => ({
    id: k.id, name: k.name, tail: k.token.slice(-4), createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null,
    requests: k.requests || 0, errors: k.errors || 0,
  });
  const find = (id) => {
    const k = store.state.keys.find((x) => x.id === String(id));
    if (!k) throw new AppError('NOT_FOUND', 'Key 不存在', 404);
    return k;
  };

  return {
    list: () => [...store.state.keys].sort((a, b) => b.createdAt - a.createdAt).map(view),
    create({ name, userId }) {
      if (store.state.keys.length >= MAX_KEYS) throw new AppError('TOO_MANY', `最多 ${MAX_KEYS} 个 Key，请先撤销不用的`, 409);
      const token = PREFIX + crypto.randomBytes(24).toString('base64url');
      const key = { id: crypto.randomBytes(8).toString('hex'), name: name || '未命名', keyHash: sha256(token), token, createdAt: now(), createdBy: String(userId || ''), requests: 0, errors: 0 };
      store.state.keys.push(key);
      byHash.set(key.keyHash, key);
      store.save();
      return { key: view(key), token };
    },
    token: (id) => find(id).token,
    rename(id, name) {
      const k = find(id);
      k.name = name || k.name;
      store.save();
      return view(k);
    },
    revoke(id) {
      const k = find(id);
      store.state.keys = store.state.keys.filter((x) => x !== k);
      byHash.delete(k.keyHash);
      store.save();
    },
    /** The key record for a presented token, or null. */
    resolve(token) {
      if (!TOKEN.test(String(token || ''))) return null;
      return byHash.get(sha256(token)) || null;
    },
    touch(k, ok) {
      k.requests = (k.requests || 0) + 1;
      if (!ok) k.errors = (k.errors || 0) + 1;
      k.lastUsedAt = now();
      store.saveSoon();
    },
    get count() { return store.state.keys.length; },
  };
}
