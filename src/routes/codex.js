// Admin API of Codex 转发: connection status, login, token refresh, API keys.
// Everything here needs an admin session (the site's own login, as for the chat pages).
import { AppError } from '../vault.js';
import { json, readBody } from '../http.js';
import { text } from '../validate.js';

export function createCodexRoutes({ codex, keys, origin }) {
  const base = `${origin}/chat/codex/v1`;
  const admin = (me) => {
    if (!me.isAdmin) throw new AppError('FORBIDDEN', '只有管理员可以使用 Codex 转发', 403);
  };
  const view = () => ({ base, ...codex.status(), keys: keys.list() });

  function get(res, me) {
    admin(me);
    return json(res, 200, view());
  }

  /** `action`: login/start | login/complete | login/cancel | import | refresh | test | models/custom | disconnect | keys */
  async function post(req, res, me, action) {
    admin(me);
    const b = await readBody(req, action === 'import' ? 256 * 1024 : undefined);
    switch (action) {
      case 'login/start': {
        const redirect = b.redirect === 'loopback' ? 'loopback' : 'localhost';
        return json(res, 200, { login: codex.startLogin({ redirect }), ...view() });
      }
      case 'login/complete':
        await codex.completeLogin(text(b.url, 8000, '回调地址'));
        return json(res, 200, view());
      case 'login/cancel':
        codex.cancelLogin();
        return json(res, 200, view());
      case 'import':
        await codex.importAuthJson(text(b.json, 200000, 'auth.json'));
        return json(res, 200, view());
      case 'refresh':
        await codex.refresh({ reason: 'manual' });
        return json(res, 200, view());
      case 'test': {
        // Reports failures inline instead of as an HTTP error, so the page can show them next to the button.
        try {
          const fetched = await codex.fetchModels({ force: true });
          const visible = fetched.items.filter((m) => m.visible);
          if (!visible.length) {
            const d = fetched.debug;
            const what = fetched.items.length ? `只返回了未列出的模型（${fetched.items.map((m) => m.id).join('、')}）` : '返回的模型列表是空的';
            return json(res, 200, { ok: false, message: `已连上 ChatGPT，但它${what}（HTTP ${d?.status}，已试版本 ${d?.versions?.join('、')}）。可以在下面“手动添加模型 ID”，请求本身不受影响`, ...view() });
          }
          return json(res, 200, { ok: true, message: `连接正常，可用模型 ${visible.length} 个`, ...view() });
        } catch (error) {
          return json(res, 200, { ok: false, message: error instanceof AppError ? error.message : '测试失败', ...view() });
        }
      }
      case 'models/custom': {
        const ids = String(text(b.models, 4000, '模型') || '').split(/[\s,，、;；]+/).filter(Boolean);
        codex.setCustomModels(ids);
        return json(res, 200, view());
      }
      case 'disconnect': {
        const { revoked } = await codex.disconnect();
        return json(res, 200, { revoked, ...view() });
      }
      case 'keys': {
        const name = text(b.name, 60, '名称').trim();
        return json(res, 200, { ...keys.create({ name, userId: me.id }), ...view() });
      }
      default:
        throw new AppError('NOT_FOUND', '不存在', 404);
    }
  }

  /** `verb`: key (copy) | update (rename) | delete (revoke) */
  async function keyAction(req, res, me, id, verb) {
    admin(me);
    const b = await readBody(req);
    if (verb === 'key') return json(res, 200, { value: keys.token(id) });
    if (verb === 'update') {
      const name = text(b.name, 60, '名称').trim();
      if (!name) throw new AppError('INVALID', '名称不能为空', 400);
      keys.rename(id, name);
      return json(res, 200, view());
    }
    keys.revoke(id);
    return json(res, 200, view());
  }

  return { get, post, keyAction };
}
