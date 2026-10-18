// Adds the 模型对话 entry to the main PRISM site:
//  - a sidebar nav item styled like the built-in ones
//  - a compact link in the mobile header
//  - an entry card on the API 管理 page
(() => {
  const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>';
  const TRACE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.5"/><path d="m14.5 14.5 3 3"/></svg>';
  const USAGE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 7v10M19 12v5"/></svg>';
  const RELAY_ICON = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';
  // The entry card is a small window onto the landing page's night sky.
  const STYLE = `
.chat-entry-card{position:relative;overflow:hidden;isolation:isolate;display:flex;align-items:center;gap:20px;margin:0 0 28px;padding:22px 24px;border:1px solid rgb(255 255 255/8%);border-radius:16px;background:radial-gradient(55% 150% at 0% 0%,rgb(79 124 255/42%),transparent 62%),radial-gradient(45% 130% at 100% 100%,rgb(166 77 255/34%),transparent 66%),#0b0d1c;color:#eef0f8;text-decoration:none;box-shadow:inset 0 1px 0 rgb(255 255 255/8%),0 26px 50px -32px rgb(61 90 254/70%);animation:chat-entry-in 680ms cubic-bezier(.16,1,.3,1) calc(var(--arrive,0ms) + 40ms) backwards;transition:transform 360ms cubic-bezier(.22,1,.36,1),box-shadow 360ms cubic-bezier(.22,1,.36,1)}
.chat-entry-card::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:radial-gradient(1.2px 1.2px at 8% 72%,#fff,transparent),radial-gradient(1px 1px at 21% 24%,#c9d6ff,transparent),radial-gradient(1.4px 1.4px at 37% 82%,#fff,transparent),radial-gradient(1px 1px at 46% 18%,#e3c8ff,transparent),radial-gradient(1px 1px at 58% 64%,#fff,transparent),radial-gradient(1.3px 1.3px at 69% 28%,#c9d6ff,transparent),radial-gradient(1px 1px at 81% 76%,#fff,transparent),radial-gradient(1.2px 1.2px at 91% 38%,#e3c8ff,transparent),radial-gradient(1px 1px at 30% 50%,#fff,transparent),radial-gradient(1px 1px at 74% 52%,#fff,transparent);opacity:.55;animation:chat-entry-stars 4.5s ease-in-out infinite alternate}
.chat-entry-card::after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(110deg,transparent 35%,rgb(255 255 255/10%) 50%,transparent 65%);transform:translateX(-110%);transition:transform 1s cubic-bezier(.22,1,.36,1)}
.chat-entry-card:hover{transform:translateY(-2px);box-shadow:inset 0 1px 0 rgb(255 255 255/10%),0 30px 60px -30px rgb(109 93 252/80%)}
.chat-entry-card:hover::after{transform:translateX(110%)}
.chat-entry-card:focus-visible{outline:2px solid var(--primary,#3d5afe);outline-offset:3px}
.chat-entry-icon{flex:none;width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#4f7cff,#6d5dfc 52%,#a64dff);color:#fff;box-shadow:0 10px 30px -8px rgb(109 93 252/80%);transition:transform 420ms cubic-bezier(.22,1,.36,1)}
.chat-entry-card:hover .chat-entry-icon{transform:rotate(-6deg) scale(1.05)}
.chat-entry-icon svg{width:24px;height:24px}
.chat-entry-text{flex:1;min-width:0}
.chat-entry-text strong{display:block;font-size:17px;font-weight:650;margin-bottom:4px;color:#fff}
.chat-entry-text span{display:block;font-size:14px;color:rgb(226 230 245/66%);line-height:1.6}
.chat-entry-go{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:42px;padding:8px 20px;border-radius:999px;background:#eef0f8;color:#05060c;font-size:14px;font-weight:650;letter-spacing:.04em;transition:gap 260ms cubic-bezier(.22,1,.36,1),background 200ms,box-shadow 360ms}
.chat-entry-card:hover .chat-entry-go{gap:10px;background:#fff;box-shadow:0 12px 32px -10px #a64dff}
.mobile-header .chat-mobile-link{display:inline-flex;align-items:center;gap:6px;min-height:44px;min-width:44px;justify-content:center;padding:8px 12px;border-radius:8px;color:var(--primary,#3d5afe);font-size:14px;font-weight:550;text-decoration:none;white-space:nowrap;flex:none}
@media (max-width:440px){.mobile-header .chat-mobile-link{padding:8px 6px}.mobile-header .chat-mobile-link span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}
@keyframes chat-entry-in{from{opacity:0;transform:translateY(14px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes chat-entry-stars{from{opacity:.35}to{opacity:.7}}
@media (max-width:900px){.sidebar .nav-item[data-chat-link]{gap:6px;padding:12px 4px;justify-content:center;flex-direction:column}}
@media (max-width:600px){.chat-entry-card{padding:16px;gap:14px;margin-bottom:24px}.chat-entry-icon{width:42px;height:42px}.chat-entry-go{display:none}.chat-entry-text strong{font-size:16px}}
@media (prefers-reduced-motion:reduce){.chat-entry-card,.chat-entry-card::before,.chat-entry-card::after,.chat-entry-go{animation:none!important;transition:none!important}}
[data-reduced-motion="true"] .chat-entry-card,[data-reduced-motion="true"] .chat-entry-card::before{animation:none!important}`;

  let scheduled = false;
  function ensureStyle() {
    if (document.getElementById('chat-entry-style')) return;
    const style = document.createElement('style');
    style.id = 'chat-entry-style';
    style.textContent = STYLE;
    document.head.append(style);
  }

  function sidebarLink(nav) {
    if (nav.querySelector('[data-chat-link]')) return;
    const a = document.createElement('a');
    a.href = '/chat';
    a.dataset.chatLink = 'true';
    a.className = 'button button-secondary nav-item';
    a.innerHTML = ICON + '<span>模型对话</span>';
    // place right after the built-in "API 管理" item
    const first = nav.querySelector('.nav-item');
    if (first) first.after(a); else nav.prepend(a);
    const t = document.createElement('a');
    t.href = '/chat/trace';
    t.dataset.chatLink = 'trace';
    t.className = 'button button-secondary nav-item';
    t.innerHTML = TRACE_ICON + '<span>模型检测</span>';
    a.after(t);
    // Sidebar only: the mobile header has room for two links (see mobileLink).
    const u = document.createElement('a');
    u.href = '/chat/usage';
    u.dataset.chatLink = 'usage';
    u.className = 'button button-secondary nav-item';
    u.innerHTML = USAGE_ICON + '<span>用量统计</span>';
    t.after(u);
    const r = document.createElement('a');
    r.href = '/chat/relays';
    r.dataset.chatLink = 'relay';
    r.className = 'button button-secondary nav-item';
    r.innerHTML = RELAY_ICON + '<span>API 中转</span>';
    u.after(r);
  }

  function mobileLink(header) {
    if (header.querySelector('[data-chat-link]')) return;
    const a = document.createElement('a');
    a.href = '/chat';
    a.dataset.chatLink = 'true';
    a.className = 'chat-mobile-link';
    a.innerHTML = ICON + '<span>对话</span>';
    a.title = '模型对话';
    const t = document.createElement('a');
    t.href = '/chat/trace';
    t.dataset.chatLink = 'trace';
    t.className = 'chat-mobile-link';
    t.innerHTML = TRACE_ICON + '<span>检测</span>';
    t.title = '模型检测';
    const settings = header.querySelector('button');
    if (settings) { settings.before(a); settings.before(t); } else header.append(a, t);
  }

  function entryCard() {
    const header = document.querySelector('.main-content .page-header');
    const onAccounts = header && header.querySelector('h1')?.textContent?.trim() === 'API 管理';
    const existing = document.querySelector('.chat-entry-card');
    if (!onAccounts) { existing?.remove(); return; }
    if (existing) return;
    const a = document.createElement('a');
    a.href = '/chat';
    a.className = 'chat-entry-card';
    a.dataset.chatLink = 'true';
    a.innerHTML = `<span class="chat-entry-icon">${ICON}</span>` +
      '<span class="chat-entry-text"><strong>模型对话</strong><span>选择已保存的 API 和模型，调整思考强度，直接开始对话。</span></span>' +
      '<span class="chat-entry-go">开始对话 <span aria-hidden="true">→</span></span>';
    header.after(a);
  }

  function apply() {
    scheduled = false;
    ensureStyle();
    for (const nav of document.querySelectorAll('nav[aria-label="主导航"]')) sidebarLink(nav);
    for (const header of document.querySelectorAll('.mobile-header')) mobileLink(header);
    entryCard();
  }

  new MutationObserver(() => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(apply); }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
})();
