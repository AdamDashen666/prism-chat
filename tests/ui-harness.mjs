// Local UI check: fake Vault + scripted stream + real chat server, driven by Edge via Playwright.
// Usage: node tests/ui-harness.mjs <path-to-playwright-core> <out-dir>
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChatServer } from '../src/server.js';
import { createVaultClient } from '../src/vault.js';
import { createUsageStore } from '../src/usage.js';

const [, , pwPath, outDir] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const navJs = fs.readFileSync(fileURLToPath(new URL('../public/nav.js', import.meta.url)));

const vault = http.createServer((req, res) => {
  const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/auth/me') return send(200, { id: 'owner1', userName: 'QiuZhang666', mustChangePassword: false });
  if (url.pathname === '/api/accounts') return send(200, { items: [
    { id: 'a1', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'], hasApiKey: true, isEnabled: true },
    { id: 'a2', displayName: '', baseUrl: 'https://relay.example.com/v1', models: ['gpt-5.5', 'claude-sonnet-5', 'gpt-image-2', 'seedream-5-0-lite-260128', 'gemini-3-pro-image', 'wan2.7-t2v'], hasApiKey: true, isEnabled: true },
  ], total: 2, page: 1, pageSize: 24 });
  return send(404, {});
});
const vaultPort = await new Promise((r) => vault.listen(0, '127.0.0.1', () => r(vault.address().port)));
// 用量统计: a week of counters for owner1 (30-day totals: 6 requests, 1 failed, 68,300 in, 24,300 out, 2 images).
let usageClock = null;
const usage = createUsageStore({ now: () => usageClock ?? Date.now() });
for (const [ago, kind, accountId, model, input, output, images, status] of [
  [6, 'chat', 'a1', 'deepseek-v4-pro', 12000, 3400, 0, 'completed'],
  [3, 'chat', 'a2', 'claude-sonnet-5', 52000, 9100, 0, 'completed'],
  [3, 'chat', 'a2', 'claude-sonnet-5', 0, 0, 0, 'failed'],
  [1, 'image', 'a2', 'gpt-image-2', 400, 8000, 2, 'completed'],
  [0, 'trace', 'a1', 'deepseek-flash', 900, 2600, 0, 'completed'],
  [0, 'chat', 'a1', 'deepseek-flash', 3000, 1200, 0, 'completed'],
]) {
  usageClock = Date.now() - ago * 86400000;
  usage.record({ userId: 'owner1', kind, accountId, model, status, usage: { input, output, reasoning: Math.round(output / 4) }, images, ms: 1000 });
}
usageClock = null;
const chat = createChatServer({ vault: createVaultClient({ port: vaultPort }), origin: 'http://127.0.0.1', usage });
const chatPort = await new Promise((r) => chat.listen(0, '127.0.0.1', () => r(chat.address().port)));

// Mimics the main SPA's DOM so nav.js can be checked.
const MAIN = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script defer src="/chat-nav.js"></script>
<style>:root{--primary:#2563eb}.nav-item{display:flex;padding:12px 16px}.sidebar{width:232px;float:left}.main-content{margin-left:232px;padding:36px 40px}.mobile-header{display:none}
@media(max-width:600px){.sidebar{display:none}.mobile-header{display:flex}.main-content{margin-left:0;padding:24px 16px}}</style></head><body>
<div class="app-shell"><aside class="sidebar"><nav aria-label="主导航"><button class="button button-secondary nav-item active">API 管理</button><button class="button button-secondary nav-item">设置</button></nav></aside>
<div class="mobile-header"><div class="brand">PRISM</div><button class="button">设置</button></div>
<main class="main-content"><header class="page-header"><h1>API 管理</h1></header><section class="summary">summary</section></main></div></body></html>`;

let streamDelay = 25;
const lastBodies = {};
const jobs = new Map();
let jobSeq = 0;
let dropFirstDownload = false;
const imageRequests = [];
// 64x40 gradient PNG built with zlib so the harness has a real, decodable image.
import zlib from 'node:zlib';
function makePng(w, h, seed) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 4 + seed) & 255; raw[o + 1] = (y * 6) & 255; raw[o + 2] = (200 - seed) & 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_A = makePng(64, 40, 10);
const PNG_B = makePng(64, 64, 120);
const pngUrl = (b) => `data:image/png;base64,${b.toString('base64')}`;
const front = http.createServer((req, res) => {
  if (req.url === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(MAIN); }
  // Fake server-side image jobs: one image every 500 ms, then usage + done.
  if (req.url === '/api/chat/images') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body);
      lastBodies.images = b;
      const job = { id: `job${++jobSeq}`, status: 'running', events: [], files: [], waiters: new Set() };
      jobs.set(job.id, job);
      const push = (e) => { job.events.push({ seq: job.events.length, ...e }); for (const w of job.waiters) w(); job.waiters.clear(); };
      push({ type: 'start', model: b.model, n: b.n });
      let i = 0;
      const delay = /慢/.test(b.prompt) ? 2500 : 500;
      const timer = setInterval(() => {
        if (i < b.n) { const buf = i % 2 ? PNG_B : PNG_A; job.files.push(buf); push({ type: 'image', index: i, mime: 'image/png', bytes: buf.length }); i++; return; }
        clearInterval(timer);
        push({ type: 'usage', usage: { input: 10, output: 4000 } });
        push({ type: 'done', ms: 5200 });
        job.status = 'done';
        for (const w of job.waiters) w();
      }, delay);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jobId: job.id }));
    });
    return;
  }
  const jm = /^\/api\/chat\/jobs\/([^/]+)\/(events|images\/(\d+))(?:\?after=(\d+))?$/.exec(req.url);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"gone"}'); }
    if (jm[2] === 'events') {
      const after = Number(jm[4] || 0);
      const reply = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: job.status, events: job.events.slice(after), next: job.events.length })); };
      if (job.events.length > after || job.status !== 'running') return reply();
      job.waiters.add(reply);
      return;
    }
    const buf = job.files[Number(jm[3])];
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    imageRequests.push({ index: Number(jm[3]), start });
    res.writeHead(range ? 206 : 200, { 'content-type': 'image/png', ...(range ? { 'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}` } : {}) });
    // Simulate a dropped connection on the first download attempt of each image.
    if (dropFirstDownload && !range && !job.dropped?.[jm[3]]) {
      job.dropped = { ...job.dropped, [jm[3]]: true };
      res.write(buf.subarray(0, 40));
      return setTimeout(() => res.destroy(), 50);
    }
    return res.end(buf.subarray(start));
  }
  if (req.url === '/chat-nav.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(navJs); }
  if (req.url === '/api/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastBodies.chat = JSON.parse(body);
      const ask = JSON.parse(body).messages.at(-1).content;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (ask === '写长文') {
        res.end([{ type: 'start' }, { type: 'delta', text: '第一段内容，写到一半' }, { type: 'usage', usage: { input: 61, output: 8192 } }, { type: 'finish', reason: 'length' }, { type: 'done', ms: 1000 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
        return;
      }
      if (ask === '长代码') {
        const code = Array.from({ length: 60 }, (_, k) => `const line${k} = ${k};`).join('\n');
        const text = `短的：\n\n\`\`\`js\nshort();\n\`\`\`\n\n长的：\n\n\`\`\`js\n${code}\n\`\`\`\n\n结束。`;
        const evs = [{ type: 'start' }];
        for (const ch of text.match(/[\s\S]{1,40}/g)) evs.push({ type: 'delta', text: ch });
        evs.push({ type: 'finish', reason: 'stop' }, { type: 'done', ms: 800 });
        let k = 0;
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          if (k >= evs.length) { clearInterval(t); return res.end(); }
          res.write(JSON.stringify(evs[k++]) + '\n');
        }, 15);
        return;
      }
      if (ask === '思考失败') {
        res.end([{ type: 'start' }, { type: 'error', message: '上游返回 400：Unsupported value: reasoning_effort max（思考强度：最高。这个模型或中转站可能不支持该档位，可换一档或选“默认”后重试）' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
        return;
      }
      if (/被截断/.test(ask)) {
        res.end([{ type: 'start' }, { type: 'delta', text: '被打断了，现在写完。' }, { type: 'usage', usage: { input: 80, output: 100 } }, { type: 'finish', reason: 'stop' }, { type: 'done', ms: 500 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
        return;
      }
      const reply = `关于“${ask}”：\n\n## 步骤\n\n1. 安装依赖\n2. 运行 **测试**\n   - 子项 \`npm test\`\n\n\`\`\`js\nconsole.log("hello");\n\`\`\`\n\n| 列 A | 列 B |\n| --- | ---: |\n| 1 | 2 |\n\n> 引用，<script>alert(1)</script> 不会执行。`;
      const events = [{ type: 'start' }, { type: 'reasoning', text: '先分析需求，' }, { type: 'reasoning', text: '再给出步骤。' }, { type: 'first', ms: 420 }];
      for (const ch of reply.match(/[\s\S]{1,8}/g)) events.push({ type: 'delta', text: ch });
      events.push({ type: 'usage', usage: { input: 42, output: 128, reasoning: 30 } }, { type: 'finish', reason: 'stop' }, { type: 'done', ms: 2300 });
      let i = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        if (i >= events.length) { clearInterval(timer); return res.end(); }
        res.write(JSON.stringify(events[i++]) + '\n');
      }, streamDelay);
    });
    return;
  }
  const proxy = http.request({ host: '127.0.0.1', port: chatPort, path: req.url, method: req.method, headers: { ...req.headers, cookie: '__Host-PrismVault=x' } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  req.pipe(proxy);
});
const frontPort = await new Promise((r) => front.listen(0, '127.0.0.1', () => r(front.address().port)));
const base = `http://127.0.0.1:${frontPort}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) errors.push(label); };
const layoutOf = (page) => page.evaluate(() => {
  const overflowX = document.documentElement.scrollWidth > innerWidth;
  const tooWide = [...document.querySelectorAll('.toolbar *, .composer *, .message *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map((e) => e.tagName + '.' + e.className).slice(0, 5);
  return { overflowX, tooWide };
});

try {
  // ---- main site entry ----
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`main ${name}: ${e.message}`));
    await page.goto(base + '/');
    await page.waitForSelector('.chat-entry-card');
    const navTexts = await page.locator('nav[aria-label="主导航"] > *').allTextContents();
    check(navTexts.join('|') === 'API 管理|模型对话|模型检测|用量统计|API 中转|设置', `${name} sidebar order: ${navTexts.join(' | ')}`);
    check(await page.locator('.chat-entry-card').isVisible(), `${name} entry card visible on API 管理 page`);
    if (name === 'mobile') check(await page.locator('.mobile-header [data-chat-link]').first().isVisible(), 'mobile header link visible');
    await page.screenshot({ path: path.join(outDir, `main-${name}.png`) });
    await page.close();
  }

  // ---- chat page ----
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    await page.goto(`${base}/chat`);
    await page.waitForSelector('#account:not([disabled])');
    await page.waitForTimeout(700);
    check((await layoutOf(page)).overflowX === false, `${name} empty: no horizontal overflow`);
    await page.screenshot({ path: path.join(outDir, `${name}-empty.png`) });

    // conversation A, slow stream
    streamDelay = 60;
    await page.selectOption('#account', 'a2');
    await page.selectOption('#model', 'claude-sonnet-5');
    await page.selectOption('#effort', 'high');
    await page.fill('#composer-input', '对话 A');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.message.assistant .caret, .message.assistant .reasoning');
    check(await page.locator('#stop').isVisible(), `${name} stop button shown while streaming`);
    check(await page.locator('#new-chat').isEnabled(), `${name} new-chat enabled while streaming`);

    // new chat mid-stream
    if (name === 'mobile') { await page.click('#open-sidebar'); await page.waitForTimeout(450); }
    await page.click('#new-chat');
    await page.waitForTimeout(450);
    check(await page.locator('#empty').isVisible(), `${name} new chat opened mid-stream`);
    check(await page.locator('#send').isVisible() && !(await page.locator('#stop').isVisible()), `${name} new chat has its own send button`);
    check(await page.locator('.history-item.streaming').count() === 1, `${name} A shows streaming dot in history`);
    streamDelay = 20;
    await page.fill('#composer-input', '对话 B');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.history-item.streaming').length === 2, null, { timeout: 5000 }).then(() => check(true, `${name} two conversations streaming at once`)).catch(() => check(false, `${name} two conversations streaming at once`));
    await page.waitForSelector('.message.assistant .meta', { timeout: 15000 });
    const bText = await page.textContent('.message.assistant .bubble');
    check(bText.includes('对话 B'), `${name} B reply belongs to B`);
    const html = await page.innerHTML('.message.assistant .bubble');
    check(!html.includes('<script>'), `${name} model output not rendered as HTML`);
    check(await page.locator('.code-block pre code').count() === 1 && await page.locator('.bubble table').count() === 1, `${name} markdown code+table`);
    console.log(name, 'meta:', await page.textContent('.message.assistant .meta'));
    check(await page.locator('.message.user .bubble').isVisible() && (await page.textContent('.message.user .bubble')) === '对话 B', `${name} user message shown`);
    // A second turn: earlier user messages get their edit button back once the reply is done.
    await page.fill('#composer-input', '对话 B 第二条');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant .meta').length === 2, null, { timeout: 15000 });
    check(await page.locator('.message.user').evaluateAll((list) => list.length === 2 &&
      list.every((m) => [...m.querySelectorAll('.message-actions button')].some((b) => b.textContent === '编辑'))), `${name} every user message keeps 编辑 after a second turn`);

    // wait for A to finish in background, then switch to it
    await page.waitForFunction(() => document.querySelectorAll('.history-item.streaming').length === 0, null, { timeout: 30000 });
    const titles = await page.locator('.history-title').allTextContents();
    check(titles.length === 2, `${name} history has 2 conversations: ${titles.join(', ')}`);
    if (name === 'mobile') { await page.click('#open-sidebar'); await page.waitForTimeout(450); }
    await page.locator('.history-open', { hasText: '对话 A' }).click();
    await page.waitForTimeout(450);
    const aText = await page.textContent('.message.assistant .bubble');
    check(aText.includes('对话 A') && !aText.includes('对话 B'), `${name} A reply complete and isolated`);
    check(await page.inputValue('#effort') === 'high', `${name} A keeps its effort setting`);
    const lay = await layoutOf(page);
    check(!lay.overflowX && !lay.tooWide.length, `${name} chat: no overflow ${JSON.stringify(lay.tooWide)}`);
    await page.screenshot({ path: path.join(outDir, `${name}-chat.png`) });

    // Ctrl+K new chat, settings drawer
    if (name === 'desktop') {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(300);
      check(await page.locator('#empty').isVisible(), 'Ctrl+K opens new chat');
      await page.click('#toggle-settings');
      await page.waitForTimeout(500);
      const h = await page.evaluate(() => document.getElementById('settings').getBoundingClientRect().height);
      check(h > 100, `settings drawer opens (height ${Math.round(h)})`);
      await page.screenshot({ path: path.join(outDir, `${name}-settings.png`) });
      await page.click('#toggle-settings');
      await page.waitForTimeout(500);
      const h2 = await page.evaluate(() => document.getElementById('settings').getBoundingClientRect().height);
      check(h2 < 2, `settings drawer closes (height ${Math.round(h2)})`);
      await page.reload();
      await page.waitForSelector('#account:not([disabled])');
      check(await page.locator('.history-item').count() === 2, 'history survives reload');
    }

    // ---- long code folds; expand state survives streaming re-renders ----
    const effortOpts = await page.$$eval('#effort option', (o) => o.map((x) => x.textContent));
    check(effortOpts.join('|') === '默认|关闭|最少|低|中|高|很高|最高', `${name} effort options: ${effortOpts.join('|')}`);
    await page.keyboard.press('Control+k');
    await page.selectOption('#account', 'a2');
    await page.selectOption('#model', 'claude-sonnet-5');
    await page.fill('#composer-input', '长代码');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.code-block.folded', { timeout: 10000 });
    await page.click('.code-fold-toggle');
    await page.waitForSelector('.message.assistant .meta', { timeout: 15000 });
    check(await page.locator('.code-block').count() === 2 && await page.locator('.code-block.foldable').count() === 1, `${name} only the long block is foldable`);
    check(await page.locator('.code-block.foldable:not(.folded)').count() === 1, `${name} expanded block stays expanded after streaming`);
    await page.click('.code-fold-toggle');
    const folded = await page.evaluate(() => { const b = document.querySelector('.code-block.foldable'); return { folded: b.classList.contains('folded'), h: b.querySelector('pre').getBoundingClientRect().height, label: b.querySelector('.code-fold-toggle').textContent, live: b.hasAttribute('data-live') }; });
    check(folded.folded && folded.h < 400 && /共 60 行/.test(folded.label) && !folded.live, `${name} folded: ${JSON.stringify(folded)}`);
    await page.locator('.code-block.foldable').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, `${name}-code-fold.png`) });
    await page.click('.code-fold-toggle');
    const copied = await page.evaluate(() => document.querySelector('.code-block.foldable pre').getBoundingClientRect().height);
    check(copied > 900, `${name} expanded shows full code (${Math.round(copied)}px)`);

    // ---- unsupported thinking level: user sees the error ----
    await page.keyboard.press('Control+k');
    await page.selectOption('#effort', 'max');
    await page.fill('#composer-input', '思考失败');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.message-error', { timeout: 10000 });
    check(/思考强度：最高/.test(await page.textContent('.message-error')), `${name} effort failure shown to the user`);
    check(lastBodies.chat.effort === 'max', `${name} Max sent as effort=max`);
    await page.selectOption('#effort', '');

    // ---- truncated reply → continue ----
    await page.keyboard.press('Control+k');
    await page.fill('#composer-input', '写长文');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.message-truncated', { timeout: 10000 });
    check(await page.locator('.message-actions .primary-action').textContent() === '继续生成', `${name} truncated reply offers 继续生成`);
    await page.click('.message-actions .primary-action');
    await page.waitForFunction(() => !document.querySelector('.message-truncated') && document.querySelector('.message.assistant .meta'), null, { timeout: 10000 });
    const sentCont = lastBodies.chat.messages;
    check(sentCont.at(-2).role === 'assistant' && sentCont.at(-2).content === '第一段内容，写到一半' && /被截断/.test(sentCont.at(-1).content), `${name} continuation sends partial text`);
    check((await page.locator('.message.assistant').count()) === 1 && (await page.textContent('.message.assistant .bubble')).includes('写到一半被打断了，现在写完。'), `${name} continuation appended to the same reply`);
    const contMeta = await page.textContent('.message.assistant .meta');
    check(contMeta.includes('↓8292') && contMeta.includes('1.5s') && !contMeta.includes('length'), `${name} continuation meta merged: ${contMeta}`);

    // ---- images ----
    await page.keyboard.press('Control+k');
    await page.selectOption('#account', 'a2');
    const groups = await page.locator('#model optgroup').evaluateAll((gs) => gs.map((g) => g.label));
    check(groups.join('|') === '对话模型|图片模型', `${name} model list grouped: ${groups.join('|')}`);
    // vision chat: attach an image to a chat model
    await page.selectOption('#model', 'gpt-5.5');
    check(!(await page.locator('.shell').evaluate((s) => s.classList.contains('mode-image'))), `${name} chat model stays in chat mode`);
    await page.setInputFiles('#file-input', { name: 'a.png', mimeType: 'image/png', buffer: PNG_A });
    await page.waitForSelector('.attach-item img');
    await page.fill('#composer-input', '图里是什么');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.message.assistant .meta', { timeout: 15000 });
    const sentImages = lastBodies.chat.messages.at(-1).images || [];
    check(sentImages.length === 1 && sentImages[0].startsWith('data:image/png;base64,'), `${name} vision message carries the image`);
    check(await page.locator('.message.user .image-card img').count() === 1, `${name} user image thumbnail shown`);
    check(await page.locator('.attach-item').count() === 0, `${name} tray cleared after send`);

    // image model: generation
    await page.keyboard.press('Control+k');
    await page.selectOption('#model', 'gpt-image-2');
    await page.waitForTimeout(400);
    check(await page.locator('.shell').evaluate((s) => s.classList.contains('mode-image')), `${name} image model switches to image mode`);
    check(await page.locator('#image-size').isVisible() && !(await page.locator('#effort').isVisible()), `${name} size picker replaces effort picker`);
    check((await page.textContent('#model-kind')).includes('图片'), `${name} model chip says 图片`);
    await page.selectOption('#image-size', '1536x1024');
    await page.selectOption('#image-n', '2');
    await page.fill('#composer-input', '一只橘猫');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.image-skeleton');
    check(await page.locator('.image-status').isVisible(), `${name} generating status shown`);
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant .image-card.loaded').length === 2 && !document.querySelector('.image-skeleton'), null, { timeout: 15000 })
      .then(() => check(true, `${name} two generated images rendered`)).catch(() => check(false, `${name} two generated images rendered`));
    check(lastBodies.images.size === '1536x1024' && lastBodies.images.n === 2 && lastBodies.images.prompt === '一只橘猫', `${name} image request params ${JSON.stringify({ ...lastBodies.images, images: undefined })}`);
    console.log(name, 'image meta:', await page.textContent('.message.assistant .meta'));
    const lay2 = await layoutOf(page);
    check(!lay2.overflowX && !lay2.tooWide.length, `${name} image layout: no overflow ${JSON.stringify(lay2.tooWide)}`);
    await page.screenshot({ path: path.join(outDir, `${name}-image.png`) });

    // lightbox + edit from result
    await page.locator('.message.assistant .image-open').first().click();
    await page.waitForTimeout(400);
    check(await page.locator('#lightbox').evaluate((d) => d.open), `${name} lightbox opens`);
    await page.click('#lightbox-edit');
    await page.waitForTimeout(300);
    check(!(await page.locator('#lightbox').evaluate((d) => d.open)) && await page.locator('.attach-item').count() === 1, `${name} "继续编辑" attaches the image`);
    await page.fill('#composer-input', '改成蓝色');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant').length === 2 && !document.querySelector('.image-skeleton'), null, { timeout: 15000 });
    check((lastBodies.images.images || []).length === 1, `${name} edit request carries the reference image`);

    // video models are flagged, not sent
    await page.keyboard.press('Control+k');
    await page.selectOption('#model', 'wan2.7-t2v');
    await page.fill('#composer-input', 'x');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check((await page.textContent('#notice')).includes('视频'), `${name} video model is rejected with a notice`);
    await page.selectOption('#model', 'gemini-3-pro-image');
    check(!(await page.locator('.shell').evaluate((s) => s.classList.contains('mode-image'))) && (await page.textContent('#model-kind')).includes('可出图'), `${name} gemini image stays in chat mode`);

    // images persist through reload (IndexedDB)
    await page.reload();
    await page.waitForSelector('#account:not([disabled])');
    if (name === 'mobile') { await page.click('#open-sidebar'); await page.waitForTimeout(450); }
    await page.locator('.history-open', { hasText: '一只橘猫' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.image-card.loaded').length >= 3, null, { timeout: 5000 })
      .then(() => check(true, `${name} images restored after reload`)).catch(() => check(false, `${name} images restored after reload`));

    // flaky network: first download of each image drops midway → resumed with Range
    dropFirstDownload = true;
    imageRequests.length = 0;
    await page.keyboard.press('Control+k');
    await page.selectOption('#account', 'a2');
    await page.selectOption('#model', 'gpt-image-2');
    await page.selectOption('#image-n', '1');
    await page.fill('#composer-input', '断网测试');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant .image-card.loaded').length === 1 && !document.querySelector('.history-item.streaming'), null, { timeout: 20000 })
      .then(() => check(true, `${name} image survives a dropped download`)).catch(() => check(false, `${name} image survives a dropped download`));
    check(imageRequests.some((r) => r.start > 0) && !(await page.locator('.message.assistant .message-error').count()), `${name} download resumed from offset ${JSON.stringify(imageRequests)}`);
    const restored = await page.locator('.message.assistant .image-card img').evaluate((i) => i.naturalWidth);
    check(restored === 64, `${name} resumed image decodes (${restored}px)`);
    dropFirstDownload = false;

    // reload while generating: the job keeps running and the page reattaches
    await page.keyboard.press('Control+k');
    await page.selectOption('#account', 'a2');
    await page.selectOption('#model', 'gpt-image-2');
    await page.fill('#composer-input', '慢慢画');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.image-skeleton');
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector('#account:not([disabled])');
    if (name === 'mobile') { await page.click('#open-sidebar'); await page.waitForTimeout(450); }
    await page.locator('.history-open', { hasText: '慢慢画' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant .image-card.loaded').length === 1 && !document.querySelector('.image-skeleton'), null, { timeout: 15000 })
      .then(() => check(true, `${name} reload mid-generation reattaches and finishes`)).catch(() => check(false, `${name} reload mid-generation reattaches and finishes`));
    check(!(await page.locator('.message.assistant .message-error').count()), `${name} no error after reattach`);
    await page.close();
  }

  // ---- text attachments, highlighting, history search, presets, IndexedDB ----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(`features: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${base}/chat`);
    await page.waitForSelector('#account:not([disabled])');
    await page.selectOption('#account', 'a1');
    await page.selectOption('#model', 'deepseek-flash');
    await page.setInputFiles('#file-input', [{ name: 'demo.py', mimeType: 'text/x-python', buffer: Buffer.from('def add(a, b):\n    return a + b  # ```\n') }]);
    await page.waitForSelector('.attach-file');
    check((await page.textContent('.attach-file .file-name')) === 'demo.py', 'text file shown in the tray');
    await page.setInputFiles('#file-input', [{ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]) }]);
    await page.waitForFunction(() => /不是纯文本文件/.test(document.getElementById('notice').textContent), null, { timeout: 3000 })
      .then(() => check(true, 'binary file rejected with a notice')).catch(() => check(false, 'binary file rejected with a notice'));
    check(await page.locator('.attach-file').count() === 1, 'only the text file is attached');
    await page.fill('#composer-input', '解释这个文件');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.history-item.streaming') && document.querySelector('.message.assistant .code-block'), null, { timeout: 10000 });
    const sent = lastBodies.chat.messages.at(-1).content;
    check(sent.startsWith('附件：demo.py\n````python\n') && sent.endsWith('````\n\n解释这个文件'), `file sent before the text, in a longer fence: ${JSON.stringify(sent)}`);
    check(await page.locator('.message.user .file-card').count() === 1, 'file card on the sent message');
    await page.click('.message.user .file-card summary');
    await page.waitForSelector('.file-preview .tok-keyword', { timeout: 3000 })
      .then(() => check(true, 'file preview is highlighted')).catch(() => check(false, 'file preview is highlighted'));
    check(await page.locator('.message.assistant .code-block .tok-string').count() > 0 && await page.locator('.message.assistant .code-block .tok-function').count() > 0, 'reply code block highlighted');
    check(await page.locator('.message.assistant script').count() === 0, 'no markup injected');

    await page.keyboard.press('Control+k');
    await page.fill('#composer-input', '第二个话题');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.history-item.streaming') && document.querySelectorAll('.history-item').length >= 2, null, { timeout: 10000 });
    await page.fill('#history-search', 'demo.py');
    await page.waitForTimeout(300);
    const found = await page.locator('.history-title').allTextContents();
    check(found.length === 1 && found[0] === '解释这个文件', `search finds attachment names: ${found.join(' | ')}`);
    await page.fill('#history-search', '第二个');
    await page.waitForTimeout(300);
    check((await page.locator('.history-title').allTextContents()).join() === '第二个话题', 'search finds message text');
    await page.fill('#history-search', '不存在的内容xyz');
    await page.waitForTimeout(300);
    check(/没有找到/.test(await page.textContent('.history')), 'search shows an empty state');
    await page.fill('#history-search', '');
    await page.waitForTimeout(300);

    await page.click('#toggle-settings');
    await page.waitForTimeout(500);
    const drawer = await page.evaluate(() => document.getElementById('settings').getBoundingClientRect().height);
    check(drawer > 100, `features: settings drawer open (${Math.round(drawer)}px)`);
    await page.selectOption('#preset', 'b:translate');
    check((await page.inputValue('#system')).startsWith('你是专业译者'), 'built-in preset fills the system prompt');
    await page.fill('#system', '自定义提示词');
    check(await page.inputValue('#preset') === '', 'editing the prompt clears the preset selection');
    await page.screenshot({ path: path.join(outDir, 'features-settings.png') });

    // 外观: the choice is applied at once and shared by every page (embed.js, before first paint).
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    check(await page.inputValue('#theme') === 'auto' && await theme() === 'light', 'theme follows the system by default');
    await page.selectOption('#theme', 'dark');
    check(await theme() === 'dark', 'choosing 深色 switches to the dark theme');
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.chat')).backgroundColor);
    check(bg === 'rgb(18, 20, 31)', `dark chat background (${bg})`);
    const otherTheme = await page.evaluate(() => new Promise((resolve) => {
      const frame = Object.assign(document.createElement('iframe'), { src: '/chat/usage' });
      frame.onload = () => { resolve(frame.contentDocument.documentElement.dataset.theme); frame.remove(); };
      document.body.append(frame);
    }));
    check(otherTheme === 'dark', 'other pages use the saved theme');
    await page.selectOption('#theme', 'auto');
    check(await theme() === 'light', 'back to 跟随系统');

    const legacy = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('prism-chat:v1:')).length);
    check(legacy === 0, 'conversations are no longer kept in localStorage');
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForSelector('#account:not([disabled])');
    const kept = await page.locator('.history-title').allTextContents();
    check(kept.includes('解释这个文件') && kept.includes('第二个话题'), `conversations restored from IndexedDB: ${kept.join(' | ')}`);

    // ---- delete with undo, export / import, advanced settings ----
    let dialogs = 0;
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => { dialogs++; d.accept(); });
    await page.click('#toggle-settings');
    await page.waitForTimeout(500);
    const before = await page.locator('.history-title').allTextContents();
    await page.hover('.history-item:has-text("第二个话题")');
    await page.click('.history-item:has-text("第二个话题") .history-delete');
    await page.waitForTimeout(200);
    check(dialogs === 0, 'deleting a conversation asks no browser dialog');
    check(!(await page.locator('.history-title').allTextContents()).includes('第二个话题'), 'deleted conversation leaves the list');
    check(await page.locator('#notice .notice-action').isVisible(), 'undo button shown');
    await page.click('#notice .notice-action');
    await page.waitForTimeout(200);
    const restored = await page.locator('.history-title').allTextContents();
    check(restored.length === before.length && restored.includes('第二个话题'), `undo restores it: ${restored.join(' | ')}`);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-chats')]);
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    check(exported.format === 'prism-chat-export' && exported.conversations.length === before.length, `export holds ${exported.conversations?.length} conversations`);
    // Import into a fresh profile: everything comes back.
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await fresh.newPage();
    p2.on('pageerror', (e) => errors.push(`import: ${e.message}`));
    await p2.goto(`${base}/chat`);
    await p2.waitForSelector('#account:not([disabled])');
    check(await p2.locator('.history-item').count() === 0, 'fresh browser has no conversations');
    await p2.setInputFiles('#import-file', { name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await p2.waitForFunction((n) => document.querySelectorAll('.history-item').length === n, before.length, { timeout: 3000 })
      .then(() => check(true, 'import restores the conversations')).catch(() => check(false, 'import restores the conversations'));
    await p2.setInputFiles('#import-file', { name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await p2.waitForTimeout(300);
    check(await p2.locator('.history-item').count() === before.length, 'importing twice adds no duplicates');
    await fresh.close();

    if (!(await page.evaluate(() => document.getElementById('settings').classList.contains('open')))) await page.click('#toggle-settings');
    await page.waitForTimeout(500);
    check(!(await page.locator('#api-type').isVisible()) && await page.locator('#system').isVisible(), 'technical settings start folded');
    await page.click('#advanced > summary');
    check(await page.locator('#api-type').isVisible(), '更多参数 unfolds them');
    await page.close();
  }

  // ---- touch screens: Enter makes a new line, short placeholder ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`touch: ${e.message}`));
    await page.goto(`${base}/chat`);
    await page.waitForSelector('#account:not([disabled])');
    check(await page.getAttribute('#composer-input', 'placeholder') === '输入消息', 'touch: short placeholder');
    await page.fill('#composer-input', '第一行');
    await page.focus('#composer-input');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二行');
    check(await page.inputValue('#composer-input') === '第一行\n第二行', 'touch: Enter inserts a new line');
    check(await page.locator('.message.user').count() === 0, 'touch: Enter does not send');
    const name = await page.evaluate(() => { const s = document.getElementById('account'); return s.scrollWidth <= s.clientWidth + 1 || s.clientWidth >= 170; });
    check(name, 'phone: the API picker has room for its name');
    await page.screenshot({ path: path.join(outDir, 'touch-mobile.png') });
    await ctx.close();
  }

  // ---- 用量统计 ----
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`usage ${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(`usage ${name} console: ${m.text()}`); });
    await page.goto(`${base}/chat/usage`);
    await page.waitForSelector('.kpi');
    const kpis = await page.locator('.kpi-value').allTextContents();
    check(kpis.join('|') === '6|6.8万|2.4万|2', `${name} usage KPI tiles: ${kpis.join(' | ')}`);
    check(await page.locator('#chart svg .bar-input').count() >= 4 && await page.locator('#chart svg .bar-output').count() >= 4, `${name} daily chart has stacked columns`);
    const hit = await page.locator('#chart svg .hit').boundingBox();
    await page.mouse.move(hit.x + hit.width - 3, hit.y + hit.height / 3);
    await page.waitForSelector('.tooltip.show', { timeout: 2000 }).catch(() => {});
    const tip = await page.textContent('.tooltip');
    check(/3,900/.test(tip) && /3,800/.test(tip) && /2 次/.test(tip), `${name} tooltip shows today's numbers: ${tip}`);
    const apis = await page.locator('#by-account td.name').allTextContents();
    check(apis.length === 2 && apis.some((t) => t.startsWith('DeepSeek')) && apis.some((t) => t.startsWith('relay.example.com')), `${name} by-API names: ${apis.join(' | ')}`);
    check(await page.locator('#by-model tbody tr').count() === 4, `${name} by-model rows`);
    await page.selectOption('#filter-kind', 'image');
    check((await page.locator('.kpi-value').allTextContents()).join('|') === '1|400|8,000|2', `${name} type filter`);
    await page.selectOption('#filter-kind', '');
    await page.click('[data-days="1"]');
    await page.waitForFunction(() => document.querySelector('.kpi-value')?.textContent === '2', null, { timeout: 3000 })
      .then(() => check(true, `${name} today range`)).catch(() => check(false, `${name} today range`));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!overflow, `${name} usage: no horizontal overflow`);
    await page.click('[data-days="30"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `usage-${name}.png`), fullPage: true });
    await page.close();
  }

  // ---- two tabs: a tab that loaded while the other was still replying must not overwrite that reply ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const [a, b] = [await ctx.newPage(), await ctx.newPage()];
    for (const p of [a, b]) {
      p.on('pageerror', (e) => errors.push(`two tabs: ${e.message}`));
      await p.goto(`${base}/chat`);
      await p.waitForSelector('#account:not([disabled])');
      await p.selectOption('#account', 'a1');
      await p.selectOption('#model', 'deepseek-flash');
    }
    streamDelay = 90;
    await a.fill('#composer-input', '标签页甲');
    await a.keyboard.press('Enter');
    await b.waitForTimeout(700); // b reloads from a's first save and sees a's reply still pending
    await b.fill('#composer-input', '标签页乙');
    await b.keyboard.press('Enter');
    await a.waitForSelector('.message.assistant .meta', { timeout: 15000 });
    await b.waitForSelector('.message.assistant .meta', { timeout: 15000 });
    await b.waitForTimeout(800); // b's final save
    streamDelay = 25;
    const c = await ctx.newPage();
    await c.goto(`${base}/chat`);
    await c.waitForSelector('.history-item');
    await c.locator('.history-open', { hasText: '标签页甲' }).click();
    await c.waitForTimeout(400);
    const reply = await c.locator('.message.assistant').evaluate((m) => ({ text: m.querySelector('.bubble')?.textContent || '', error: m.querySelector('.message-error')?.textContent || '' }));
    check(reply.text.includes('标签页甲') && !reply.error, `the other tab's finished reply is kept ${JSON.stringify({ ...reply, text: reply.text.slice(0, 30) })}`);
    await ctx.close();
  }

  // ---- 模型检测 still renders after the shared page.css split ----
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(`trace: ${e.message}`));
    await page.goto(`${base}/chat/trace`);
    await page.waitForSelector('#account:not([disabled])');
    await page.waitForSelector('.bank-stat');
    await page.waitForTimeout(800); // entrance animation
    const cardPad = await page.locator('.config-card').evaluate((c) => getComputedStyle(c).paddingLeft);
    check(cardPad === '24px', `trace cards keep their style (${cardPad})`);
    check((await page.locator('.site-nav a').allTextContents()).includes('用量统计'), 'trace nav links to 用量统计');
    await page.screenshot({ path: path.join(outDir, 'trace-desktop.png') });
    await page.close();
  }
} finally {
  await browser.close();
  front.close(); chat.close(); vault.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL OK');
process.exitCode = errors.length ? 1 : 0;
