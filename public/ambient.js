// Night-sky backdrop for the sidebar: a few dozen slow motes drifting upward, faint links between
// close neighbours, and a little extra light around the pointer. A quiet echo of the landing scene,
// drawn on a 2D canvas at ~30 fps. Same algorithm as the main site's web/src/components/ambient.ts.
(() => {
  const COLORS = [[255, 255, 255], [157, 184, 255], [199, 150, 255]];
  const LINK = 74;
  const FRAME_MS = 33;

  function startAmbient(canvas, { still = false } = {}) {
    // The context is taken on the first real layout: a closed mobile drawer never draws.
    let ctx = null;
    let width = 0, height = 0, frame = 0, last = 0, born = 0, running = false;
    let motes = [];
    const pointer = { x: 0, y: 0, on: false };

    const seed = () => {
      const count = Math.round(Math.min(46, Math.max(16, (width * height) / 8500)));
      motes = Array.from({ length: count }, () => ({
        x: Math.random() * width, y: Math.random() * height,
        r: 0.45 + Math.random() ** 2 * 1.35,
        vy: 3 + Math.random() * 8, sway: 4 + Math.random() * 12, phase: Math.random() * Math.PI * 2,
        twinkle: 0.6 + Math.random() * 1.6, base: 0.22 + Math.random() * 0.5,
        hue: Math.random() < 0.5 ? 0 : Math.random() < 0.6 ? 1 : 2,
      }));
    };

    const draw = (now) => {
      if (!ctx) return;
      const t = now / 1000;
      const fade = still ? 1 : Math.min(1, (now - born) / 1400);
      ctx.clearRect(0, 0, width, height);
      const points = motes.map((m) => ({ m, x: m.x + Math.sin(t * 0.35 + m.phase) * m.sway, y: m.y }));
      ctx.lineWidth = 0.6;
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
          if (d > LINK) continue;
          ctx.strokeStyle = `rgba(157, 184, 255, ${((1 - d / LINK) * 0.11 * fade).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(points[i].x, points[i].y); ctx.lineTo(points[j].x, points[j].y); ctx.stroke();
        }
      }
      for (const { m, x, y } of points) {
        let alpha = m.base * (0.65 + 0.35 * Math.sin(t * m.twinkle + m.phase));
        if (pointer.on) {
          const d = Math.hypot(x - pointer.x, y - pointer.y);
          if (d < 120) {
            alpha = Math.min(1, alpha + (1 - d / 120) * 0.55);
            ctx.strokeStyle = `rgba(199, 170, 255, ${((1 - d / 120) * 0.16 * fade).toFixed(3)})`;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(pointer.x, pointer.y); ctx.stroke();
          }
        }
        const [r, g, b] = COLORS[m.hue];
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(alpha * fade).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, m.r, 0, Math.PI * 2); ctx.fill();
        if (m.r > 1.3) {
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(alpha * 0.12 * fade).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(x, y, m.r * 4, 0, Math.PI * 2); ctx.fill();
        }
      }
    };

    const step = (now) => {
      frame = requestAnimationFrame(step);
      if (now - last < FRAME_MS) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      for (const m of motes) {
        m.y -= m.vy * dt;
        if (m.y < -8) { m.y = height + 8; m.x = Math.random() * width; }
      }
      draw(now);
    };

    const start = () => {
      if (running || !width || !height) return;
      running = true;
      if (still) { draw(performance.now()); return; }
      last = 0;
      frame = requestAnimationFrame(step);
    };
    const stop = () => { running = false; cancelAnimationFrame(frame); };

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const w = Math.round(box.width), h = Math.round(box.height);
      if (!w || !h) { stop(); width = height = 0; return; }
      ctx ??= canvas.getContext('2d');
      if (!ctx) return;
      const reseed = !motes.length || Math.abs(w * h - width * height) > 20000;
      width = w; height = h;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (reseed) seed();
      if (!born) born = performance.now();
      stop(); start();
    };

    const host = canvas.parentElement;
    host.addEventListener('pointermove', (event) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = event.clientX - box.left; pointer.y = event.clientY - box.top; pointer.on = event.pointerType === 'mouse';
    });
    host.addEventListener('pointerleave', () => { pointer.on = false; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
    resize();
  }

  const attach = () => {
    // Inside the main site's workspace its own sidebar already carries the sky.
    if (document.documentElement.classList.contains('embedded')) return;
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || sidebar.querySelector(':scope > .ambient')) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient';
    canvas.setAttribute('aria-hidden', 'true');
    sidebar.prepend(canvas);
    startAmbient(canvas, { still: matchMedia('(prefers-reduced-motion: reduce)').matches });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach, { once: true });
  else attach();
})();
