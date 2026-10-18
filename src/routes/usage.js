// GET /api/chat/usage?days=30 -> the caller's own counters for the 用量统计 page.
import { json } from '../http.js';

export function createUsageRoutes({ accounts, usage }) {
  return async function summary(req, res, url, cookie, me) {
    const days = Math.min(400, Math.max(1, Number.parseInt(url.searchParams.get('days') || '30', 10) || 30));
    const data = usage.query(me.id, { days });
    // Current names win over the label saved with the request (APIs get renamed);
    // deleted APIs and revoked grants keep their saved label.
    const names = { ...data.labels };
    try { for (const a of await accounts.list(cookie, me)) names[a.id] = a.name; } catch { /* labels are enough */ }
    const { labels, ...rest } = data;
    json(res, 200, { ...rest, names });
  };
}
