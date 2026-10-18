// Temporary files the model created (downloads, listing, cleanup) and the
// management API of API 中转 (relay keys).
import { AppError } from '../vault.js';
import { json, readBody } from '../http.js';
import { checkId, text } from '../validate.js';
import { isUuid } from '../util.js';
import { isCodex, isGrant } from '../accounts.js';
import { mimeOf } from '../files.js';

const conversationOf = (value) => {
  if (!isUuid(value)) throw new AppError('INVALID', '对话 ID 无效', 400);
  return value;
};

// RFC 6266: an ASCII fallback plus the UTF-8 name.
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createFileRoutes({ files }) {
  async function download(req, res, me, id) {
    const m = files.owned(me.id, id);
    if (!m) throw new AppError('NOT_FOUND', '文件不存在或已过期（临时文件保留 24 小时）', 404);
    const data = await files.read(m);
    const name = m.path.split('/').pop();
    // Never rendered on this origin: an attachment, sandboxed even if opened directly.
    res.writeHead(200, {
      'Content-Type': mimeOf(name).startsWith('text/') || /json|xml|svg/.test(mimeOf(name)) ? `${mimeOf(name)}; charset=utf-8` : mimeOf(name),
      'Content-Length': data.length,
      'Content-Disposition': disposition(name),
      'Content-Security-Policy': 'sandbox; default-src \'none\'',
    });
    res.end(data);
  }

  function list(res, me, url) {
    return json(res, 200, { files: files.list(me.id, conversationOf(url.searchParams.get('conversation'))) });
  }

  async function clear(req, res, me) {
    const b = await readBody(req);
    files.clear(me.id, conversationOf(b.conversationId));
    return json(res, 200, { ok: true });
  }

  async function remove(req, res, me) {
    const b = await readBody(req);
    const m = files.owned(me.id, b.id);
    if (m) await files.remove(me.id, m.conv, m.path);
    return json(res, 200, { ok: true });
  }

  return { download, list, clear, remove };
}

export function createRelayRoutes({ relays, accounts, origin }) {
  const base = `${origin}/chat/relay`;

  async function secretFor(cookie, accountId, me) {
    const id = checkId(accountId);
    if (isGrant(id)) throw new AppError('FORBIDDEN', '管理员授权的 API 不能创建中转', 403);
    if (isCodex(id)) throw new AppError('INVALID', 'Codex 转发本身就是一个 API（见“Codex 转发”页面），不需要再中转', 400);
    const { account, header, key } = await accounts.credentials(cookie, id, me, 'models');
    const host = (() => { try { return new URL(account.baseUrl).host; } catch { return ''; } })();
    return { account, host, secret: { baseUrl: account.baseUrl, header, key, custom: account.protocolProfileId === 'custom' } };
  }

  const list = (res, me) => json(res, 200, { base, relays: relays.list(me.id) });

  async function create(req, res, cookie, me) {
    const b = await readBody(req);
    const { account, host, secret } = await secretFor(cookie, b.accountId, me);
    const name = text(b.name, 60, '名称').trim() || account.displayName || host;
    return json(res, 200, { base, ...relays.create(me.id, { accountId: account.id, name, host }, secret) });
  }

  async function action(req, res, cookie, me, id, verb) {
    const b = await readBody(req);
    if (verb === 'delete') { relays.remove(me.id, id); return json(res, 200, { ok: true }); }
    if (verb === 'key') return json(res, 200, { value: relays.token(me.id, id) });
    if (verb === 'update') {
      const name = b.name === undefined ? undefined : text(b.name, 60, '名称').trim();
      return json(res, 200, { relay: relays.update(me.id, id, { name: name || undefined, enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined }) });
    }
    if (verb === 'rotate') {
      // Re-reads the current endpoint and key from Vault, then issues a new relay key.
      const { host, secret } = await secretFor(cookie, relays.get(me.id, id).accountId, me);
      return json(res, 200, { base, ...relays.rotate(me.id, id, secret, host) });
    }
    throw new AppError('NOT_FOUND', '不存在', 404);
  }

  return { list, create, action };
}
