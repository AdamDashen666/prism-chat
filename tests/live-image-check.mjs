// Live check of image features on https://qiuzhang.xyz. Credentials from env (never printed).
// Usage: node tests/live-image-check.mjs <playwright-core> <outdir> <imageModel> <visionModel>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [, , pwPath, outDir, imageModel = 'gpt-image-2', visionModel = 'doubao-seed-1-6-flash-250828'] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const { PRISM_PW: password, PRISM_USER: userName } = process.env;
if (!password || !userName) throw new Error('credentials missing');

// Solid red 64x64 PNG for the vision check.
function redPng() {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((64 * 3 + 1) * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw[y * 193 + 1 + x * 3] = 230;
  const h = Buffer.alloc(13); h.writeUInt32BE(64, 0); h.writeUInt32BE(64, 4); h[8] = 8; h[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) errors.push(label); };
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

async function pickAccountWith(model) {
  const values = await page.locator('#account option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  for (const v of values) {
    await page.selectOption('#account', v);
    if (await page.locator(`#model option[value="${model}"]`).count()) { await page.selectOption('#model', model); return true; }
  }
  return false;
}

try {
  await page.goto('https://qiuzhang.xyz/');
  await page.fill('#userName', userName);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.chat-entry-card', { timeout: 20000 });
  await page.goto('https://qiuzhang.xyz/chat');
  await page.waitForSelector('#account:not([disabled])', { timeout: 20000 });

  // 1) image generation
  if (imageModel !== 'skip') {
  check(await pickAccountWith(imageModel), `found account with ${imageModel}`);
  await page.waitForTimeout(300);
  check(await page.locator('.shell').evaluate((s) => s.classList.contains('mode-image')), 'image mode active');
  await page.selectOption('#image-size', '1024x1024');
  await page.selectOption('#image-n', '1');
  await page.click('#toggle-settings');
  await page.selectOption('#image-quality', 'low');
  await page.click('#toggle-settings');
  await page.fill('#composer-input', '一个简单的扁平风格图标：蓝色圆形背景上一只白色纸飞机');
  const began = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.history-item.streaming') && document.querySelector('.message.assistant .message-actions'), null, { timeout: 300000 });
  const err = await page.locator('.message.assistant .message-error').textContent().catch(() => null);
  const notes = await page.locator('.message.assistant .message-notice').textContent().catch(() => null);
  if (notes) console.log('notice:', notes.slice(0, 300));
  check(!err, `no error${err ? ': ' + err : ''}`);
  const size = await page.locator('.message.assistant .image-card img').first().evaluate((i) => (i.complete ? `${i.naturalWidth}x${i.naturalHeight}` : 'not loaded')).catch(() => 'none');
  check(/^\d+x\d+$/.test(size), `generated image decoded (${size}) in ${((Date.now() - began) / 1000).toFixed(1)}s`);
  console.log('meta:', await page.locator('.message.assistant .meta').textContent().catch(() => null));
  await page.screenshot({ path: path.join(outDir, 'live-image.png') });
  }

  // 2) vision chat
  await page.keyboard.press('Control+k');
  check(await pickAccountWith(visionModel), `found account with ${visionModel}`);
  await page.setInputFiles('#file-input', { name: 'red.png', mimeType: 'image/png', buffer: redPng() });
  await page.waitForSelector('.attach-item img');
  await page.fill('#composer-input', '这张图片主要是什么颜色？只回答颜色。');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.history-item.streaming') && document.querySelector('.message.assistant .message-actions'), null, { timeout: 120000 });
  const verr = await page.locator('.message.assistant .message-error').textContent().catch(() => null);
  const answer = (await page.locator('.message.assistant .bubble').textContent().catch(() => '')) || '';
  check(!verr && /红/.test(answer), `vision answer: ${JSON.stringify(answer.trim().slice(0, 40))}${verr ? ' error: ' + verr : ''}`);

  // cleanup: delete local history + images, sign out
  await page.evaluate(async () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('prism-chat:v1:')) localStorage.removeItem(k);
    await new Promise((r) => { const q = indexedDB.deleteDatabase('prism-chat-images'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  });
  await page.goto('https://qiuzhang.xyz/');
  await page.click('button[aria-label="退出登录"]');
  await page.waitForSelector('#password', { timeout: 20000 });
  console.log('signed out');
} finally {
  await browser.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL OK');
