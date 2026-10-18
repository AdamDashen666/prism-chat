// Colour theme: html[data-theme] = light | dark, resolved before the first paint from the
// saved choice (localStorage prism-theme: auto | light | dark, set in the chat settings and
// shared by every page) and the system setting. app.css keys the dark tokens on it.
(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    let choice = 'auto';
    try { choice = localStorage.getItem('prism-theme') || 'auto'; } catch { /* storage blocked */ }
    const dark = choice === 'dark' || (choice !== 'light' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#12141f' : '#ffffff');
  };
  apply();
  media.addEventListener('change', apply);
  addEventListener('storage', (event) => { if (event.key === 'prism-theme') apply(); });
  window.prismTheme = {
    get: () => { try { return localStorage.getItem('prism-theme') || 'auto'; } catch { return 'auto'; } },
    set: (choice) => { try { localStorage.setItem('prism-theme', choice); } catch { /* storage blocked */ } apply(); },
  };
})();

// The main site shows these pages inside its workspace (an iframe), next to its own sidebar.
// There, this page's own site chrome is hidden (html.embedded, see app.css) and navigation is
// handed back to the workspace instead of loading another page in the frame.
// Loaded as a classic script in <head> so the class is set before the first paint.
(() => {
  let embedded = false;
  try { embedded = window.top !== window && window.top.location.origin === location.origin; } catch { embedded = false; }
  if (!embedded) return;
  document.documentElement.classList.add('embedded');
  const VIEWS = { '/': 'accounts', '/chat': 'chat', '/chat/': 'chat', '/chat/trace': 'trace', '/chat/usage': 'usage', '/chat/relays': 'relay', '/chat/codex': 'codex' };
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return;
    event.preventDefault();
    const view = VIEWS[url.pathname];
    if (view) window.parent.postMessage({ type: 'prism:navigate', view }, location.origin);
    else window.top.location.href = url.href;
  });
})();
