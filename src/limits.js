// Concurrency limits. The host has ~1 GB RAM shared with Vault, so image
// traffic ("heavy" requests) is bounded tightly.
import { AppError } from './vault.js';

export function createLimiter({ perUser = 6, total = 24, heavy = 2 } = {}) {
  const active = new Map(); // userId -> count
  let running = 0;
  let heavyCount = 0;

  return {
    heavyLimit: heavy,
    get streams() { return running; },

    // Reserves a slot before the (possibly large) body is read. A request is
    // heavy when it is over 1 MB or of unknown size (attached images).
    acquire(req, res, me) {
      const isHeavy = Number(req.headers['content-length'] || 0) > 1024 * 1024 || !req.headers['content-length'];
      const count = active.get(me.id) || 0;
      if (count >= perUser || running >= total) throw new AppError('BUSY', '同时进行的请求过多，请等待当前回复完成', 429);
      if (isHeavy && heavyCount >= heavy) throw new AppError('BUSY', '同时进行的图片任务过多，请稍等片刻再试', 429);
      active.set(me.id, count + 1);
      running++;
      if (isHeavy) heavyCount++;
      const controller = new AbortController();
      let finished = false;
      const release = () => {
        if (finished) return;
        finished = true;
        running--;
        if (isHeavy) heavyCount--;
        const n = (active.get(me.id) || 1) - 1;
        if (n <= 0) active.delete(me.id); else active.set(me.id, n);
      };
      res.on('close', () => { if (!res.writableEnded) controller.abort(); release(); });
      return { controller, release };
    },

    /** Runs fn while holding a heavy slot (an image job's body is read and checked). */
    async withHeavy(fn) {
      if (heavyCount >= heavy) throw new AppError('BUSY', '服务器正忙，请稍等片刻再试', 429);
      heavyCount++;
      try { return await fn(); } finally { heavyCount--; }
    },
  };
}
