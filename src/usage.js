// 用量统计: per-user counters of requests, tokens and images by day (Asia/Shanghai,
// the same calendar as grant quotas), API and model. Counters only: no prompt,
// reply, endpoint or key is ever kept here. Each user's counters live in one
// small JSON file under `dir`, written shortly after a change.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './util.js';

export const USAGE_TIMEZONE = 'Asia/Shanghai';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const usageDay = (ms) => dayFormat.format(ms); // YYYY-MM-DD
const DAY_MS = 24 * 3600 * 1000; // Asia/Shanghai has no DST
export const USAGE_KINDS = ['chat', 'image', 'trace', 'pelican'];
const COUNTERS = ['requests', 'failed', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'images', 'ms'];
const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

export function createUsageStore({ dir = null, retentionDays = 400, flushMs = 5000, now = Date.now, log = (e) => console.warn(JSON.stringify(e)) } = {}) {
  if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const users = new Map(); // userId -> { file, labels, days: Map<day, Map<key, row>>, dirty }
  let timer = null;

  const keyOf = (r) => `${r.kind}\n${r.accountId}\n${r.model}`;
  const fileFor = (userId) => dir && path.join(dir, `${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)}.json`);

  function prune(user) {
    const oldest = usageDay(now() - (retentionDays - 1) * DAY_MS);
    for (const day of user.days.keys()) if (day < oldest) { user.days.delete(day); user.dirty = true; }
  }

  function load(userId) {
    let user = users.get(userId);
    if (user) return user;
    user = { file: fileFor(userId), labels: {}, days: new Map(), dirty: false };
    if (user.file) {
      try {
        const data = JSON.parse(fs.readFileSync(user.file, 'utf8'));
        if (data?.labels && typeof data.labels === 'object') user.labels = data.labels;
        for (const [day, rows] of Object.entries(data?.days || {})) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(rows)) continue;
          const map = new Map();
          for (const r of rows) {
            if (!USAGE_KINDS.includes(r?.kind) || typeof r.accountId !== 'string' || typeof r.model !== 'string') continue;
            const row = { kind: r.kind, accountId: r.accountId, model: r.model };
            for (const c of COUNTERS) row[c] = count(r[c]);
            map.set(keyOf(row), row);
          }
          user.days.set(day, map);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') log({ event: 'usage_load_failed', code: error.code || error.name });
      }
    }
    users.set(userId, user);
    prune(user);
    return user;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const user of users.values()) {
      if (!user.dirty || !user.file) continue;
      const days = {};
      for (const [day, rows] of user.days) days[day] = [...rows.values()];
      try {
        writeAtomic(user.file, JSON.stringify({ v: 1, labels: user.labels, days }));
        user.dirty = false;
      } catch (error) { log({ event: 'usage_save_failed', code: error.code || error.name }); }
    }
  }

  return {
    /**
     * One upstream request. status: 'completed' | 'stopped' | 'failed'.
     * usage: { input, output, reasoning, cacheRead, cacheWrite } as normalized by upstream.js
     * (input includes the cached part).
     */
    record({ userId, kind, accountId, label, model, status, usage, images = 0, ms = 0 }) {
      if (!userId || !USAGE_KINDS.includes(kind) || !accountId || !model) return;
      const user = load(userId);
      const day = usageDay(now());
      let rows = user.days.get(day);
      if (!rows) { user.days.set(day, rows = new Map()); prune(user); }
      const key = keyOf({ kind, accountId, model });
      let row = rows.get(key);
      if (!row) rows.set(key, row = { kind, accountId, model, ...Object.fromEntries(COUNTERS.map((c) => [c, 0])) });
      row.requests++;
      if (status === 'failed') row.failed++;
      row.input += count(usage?.input);
      row.output += count(usage?.output);
      row.reasoning += count(usage?.reasoning);
      row.cacheRead += count(usage?.cacheRead);
      row.cacheWrite += count(usage?.cacheWrite);
      row.images += count(images);
      row.ms += count(ms);
      if (label) user.labels[accountId] = String(label).slice(0, 200);
      user.dirty = true;
      if (dir && !timer) {
        timer = setTimeout(flush, flushMs);
        timer.unref();
      }
    },

    /** Rows of the last `days` days (today included), oldest first. */
    query(userId, { days = 30 } = {}) {
      const user = load(userId);
      const today = usageDay(now());
      const from = usageDay(now() - (days - 1) * DAY_MS);
      const rows = [];
      for (const [day, map] of [...user.days].sort(([a], [b]) => a.localeCompare(b))) {
        if (day < from || day > today) continue;
        for (const row of map.values()) rows.push({ day, ...row });
      }
      return { timezone: USAGE_TIMEZONE, today, from, days, rows, labels: { ...user.labels } };
    },

    flush,
    get users() { return users.size; },
    close: flush,
  };
}
