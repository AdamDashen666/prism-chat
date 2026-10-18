// Background image jobs. Generation runs on the server independent of the
// browser connection; results are kept on disk so a slow or interrupted
// network (or a page reload) can resume instead of losing a paid image.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isUuid, waitFor, wake } from './util.js';

export function createJobStore({ dir, ttlMs = 24 * 3600 * 1000, maxDiskBytes = 1536 * 1024 * 1024 } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jobs = new Map();
  const metaPath = (id) => path.join(dir, `${id}.json`);
  const filePath = (id, index) => path.join(dir, `${id}-${index}.img`);

  function persist(job) {
    const { waiters, controller, ...meta } = job;
    try { fs.writeFileSync(metaPath(job.id), JSON.stringify(meta), { mode: 0o600 }); } catch { /* disk issues must not kill the job */ }
  }

  function removeFiles(job) {
    for (let i = 0; i < (job.files || 0); i++) fs.rmSync(filePath(job.id, i), { force: true });
    fs.rmSync(metaPath(job.id), { force: true });
  }

  // Restore finished jobs after a restart; jobs that were running are lost upstream.
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!isUuid(meta.id)) continue;
      const job = { ...meta, waiters: new Set(), controller: null };
      if (Date.now() - job.createdAt > ttlMs) { removeFiles(job); continue; }
      if (job.status === 'running') {
        job.status = 'failed';
        job.events.push({ seq: job.events.length, type: 'error', message: '服务重启，这次生成被中断了，请重新生成' });
        persist(job);
      }
      jobs.set(job.id, job);
    } catch { /* skip corrupt metadata */ }
  }
  // Orphan image files without metadata.
  for (const name of fs.readdirSync(dir)) {
    const m = /^(.+)-\d+\.img$/.exec(name);
    if (m && !jobs.has(m[1])) fs.rmSync(path.join(dir, name), { force: true });
  }

  function remove(job) {
    job.controller?.abort();
    jobs.delete(job.id);
    removeFiles(job);
    wake(job);
  }

  function sweep() {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.status !== 'running' && now - (job.finishedAt || job.createdAt) > ttlMs) remove(job);
    }
    // Keep total disk use bounded: drop the oldest finished jobs first.
    let total = [...jobs.values()].reduce((sum, j) => sum + (j.bytes || 0), 0);
    const finished = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
    while (total > maxDiskBytes && finished.length) {
      const job = finished.shift();
      total -= job.bytes || 0;
      remove(job);
    }
  }
  const timer = setInterval(sweep, 10 * 60 * 1000);
  timer.unref();

  return {
    create(userId, info) {
      const job = {
        id: crypto.randomUUID(), userId, status: 'running', createdAt: Date.now(), events: [], files: 0, bytes: 0,
        model: info.model, waiters: new Set(), controller: new AbortController(),
      };
      jobs.set(job.id, job);
      persist(job);
      return job;
    },
    get(id, userId) {
      if (!isUuid(id)) return null;
      const job = jobs.get(id);
      return job && job.userId === userId ? job : null;
    },
    push(job, event) {
      if (!jobs.has(job.id)) return;
      job.events.push({ seq: job.events.length, ...event });
      persist(job);
      wake(job);
    },
    addImage(job, { mime, buffer }) {
      if (!jobs.has(job.id)) return;
      const index = job.files++;
      fs.writeFileSync(filePath(job.id, index), buffer, { mode: 0o600 });
      job.bytes += buffer.length;
      this.push(job, { type: 'image', index, mime, bytes: buffer.length });
      sweep();
    },
    finish(job, status) {
      if (!jobs.has(job.id) || job.status !== 'running') return;
      job.status = status;
      job.finishedAt = Date.now();
      job.controller = null;
      persist(job);
      wake(job);
    },
    // Resolves when there are events after `after`, the job ends, or the timeout passes.
    wait(job, after, timeoutMs, signal) {
      return waitFor(job, () => job.events.length > after || job.status !== 'running', timeoutMs, signal);
    },
    image(job, index) {
      const event = job.events.find((e) => e.type === 'image' && e.index === index);
      return event ? { path: filePath(job.id, index), mime: event.mime, bytes: event.bytes } : null;
    },
    cancel(job) {
      if (job.status !== 'running') return;
      job.controller?.abort();
    },
    remove,
    running(userId) {
      let n = 0;
      for (const job of jobs.values()) if (job.status === 'running' && (userId === undefined || job.userId === userId)) n++;
      return n;
    },
    close() { clearInterval(timer); },
  };
}
