// Write guards: every state-changing request needs the site's own Origin, a JSON
// body and a CSRF token bound to the caller's Vault session.
import crypto from 'node:crypto';
import { AppError, parseCookies } from './vault.js';

const SESSION_COOKIE = /^(__Host-PrismVault|PrismVault\.Local)$/;

function sessionValue(cookieHeader) {
  for (const [name, value] of parseCookies(cookieHeader)) if (SESSION_COOKIE.test(name)) return value;
  return '';
}

// `key` should survive restarts (see loadOrCreateKey), otherwise every open page
// gets "安全令牌已失效" after a deploy.
export function createGuards({ key, origin }) {
  const tokenFor = (cookie) => crypto.createHmac('sha256', key).update(sessionValue(cookie)).digest('hex');

  function check(req, cookie) {
    if (req.headers.origin !== origin) throw new AppError('CSRF', '请求来源无效', 403);
    const expected = tokenFor(cookie);
    const got = req.headers['x-chat-csrf'];
    if (typeof got !== 'string' || got.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      throw new AppError('CSRF', '安全令牌已失效，请刷新页面', 403);
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new AppError('CONTENT_TYPE', '仅接受 JSON', 415);
    }
  }

  return { tokenFor, check };
}
