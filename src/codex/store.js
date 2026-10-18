// Codex 转发: the whole connection state (OAuth tokens, API keys, error log) lives
// in one small file, encrypted with a server key (AES-256-GCM). The file alone is
// useless without `codex.key`, which sits next to it in the private state dir.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../util.js';

const emptyState = () => ({
  v: 1,
  tokens: null, // { id_token, access_token, refresh_token, account_id }
  lastRefresh: null,
  info: null, // { email, plan, accountId, userId } from the id_token
  needsLogin: '', // why signing in again is required (permanent refresh failure)
  pending: null, // { state, verifier, redirect, createdAt } while a login is under way
  errors: [], // [{ at, kind, message }] newest first, no secrets
  models: null, // { fetchedAt, items: [{ id, name, description }], debug } as last read from the backend
  customModels: [], // model ids the admin added by hand (used when the backend list is empty or wrong)
  limits: null, // last rate-limit snapshot read from response headers
  keys: [], // API keys for /chat/codex/v1 (see keys.js)
});

export function encryptState(key, state) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptState(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
}

/**
 * `dir` null = memory only (tests, local runs). `key` is the 32-byte server key.
 * `save()` writes at once (token changes must never be lost: a refresh token that
 * was rotated upstream and then forgotten means signing in again); `saveSoon()`
 * batches counters.
 */
export function createCodexStore({ dir = null, key = crypto.randomBytes(32), log = () => {} } = {}) {
  const file = dir ? path.join(dir, 'codex.json') : null;
  let state = emptyState();
  let loadError = '';
  let timer = null;

  if (file) {
    try {
      state = { ...emptyState(), ...decryptState(key, JSON.parse(fs.readFileSync(file, 'utf8'))) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A wrong key or a damaged file: keep the file untouched (a restored key may still open it)
        // and say so on the admin page instead of silently starting empty over it.
        loadError = error?.code === 'ERR_OSSL_BAD_DECRYPT' || /auth/i.test(error?.message || '') ? '状态文件无法解密（codex.key 与文件不匹配）' : '状态文件无法读取';
        log({ event: 'codex_state_unreadable', code: error?.code });
      }
    }
  }

  function save() {
    clearTimeout(timer);
    timer = null;
    if (!file || loadError) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(file, JSON.stringify(encryptState(key, state)));
  }
  const saveSoon = () => { if (file && !timer) { timer = setTimeout(save, 20000); timer.unref(); } };

  return {
    get state() { return state; },
    get loadError() { return loadError; },
    key,
    save,
    saveSoon,
    reset() { Object.assign(state, emptyState()); save(); },
    /** Drops everything tied to the ChatGPT login, keeping API keys. */
    clearLogin() {
      Object.assign(state, { tokens: null, lastRefresh: null, info: null, needsLogin: '', pending: null, models: null, limits: null }); // customModels stay
      save();
    },
    close: save,
  };
}
