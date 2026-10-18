// Small helpers shared by the chat, image and trace modules.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (id) => typeof id === 'string' && UUID.test(id);

/** Resolves after `ms`, or as soon as `signal` aborts. */
export const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Normalized usage ({ input, output, reasoning }) -> the counters Vault bills. */
export const tokenTotals = (usage) => ({
  inputTokens: Number(usage?.input) || 0,
  outputTokens: Number(usage?.output) || 0,
  reasoningTokens: Number(usage?.reasoning) || 0,
});

// Long-polling: image jobs, trace runs and pelican tests keep a `waiters` Set,
// and every change wakes all of them.
export function wake(target) {
  for (const done of target.waiters) done();
  target.waiters.clear();
}

/** Resolves when `ready()` already holds, on the next wake(target), on timeout, or when `signal` aborts. */
export function waitFor(target, ready, timeoutMs, signal) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); target.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    signal?.addEventListener('abort', done, { once: true });
    target.waiters.add(done);
  });
}

export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Reads a random secret kept in `file`, creating it (0600) on first use. */
export function loadOrCreateKey(file, bytes = 32) {
  try {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length === bytes) return key;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const key = crypto.randomBytes(bytes);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, key.toString('hex'));
  return key;
}
