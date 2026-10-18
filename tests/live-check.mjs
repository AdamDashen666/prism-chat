// Live check against https://qiuzhang.xyz. Credentials come from env (never printed).
// Usage: node tests/live-check.mjs <playwright-core path> <out dir> [accountName] [model]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [, , pwPath, outDir, wantAccount = 'deepseek', wantModel = 'deepseek-flash'] = process.argv;
const { chromium } = createRequire(import.meta.url)(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const { PRISM_PW: password, PRISM_USER: userName } = process.env;
if (!password || !userName) throw new Error('credentials missing');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) errors.push(label); };
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());
try {
  await page.goto('https://qiuzhang.xyz/');
  await page.fill('#userName', userName);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('.chat-entry-card', { timeout: 20000 });
  check(await page.locator('.chat-entry-card').isVisible(), 'home page shows chat entry card');
  console.log('nav:', (await page.locator('nav[aria-label="主导航"] > *').allTextContents()).join(' | '));
  await page.screenshot({ path: path.join(outDir, 'live-home.png') });
  await page.click('.chat-entry-card');
  await page.waitForURL('**/chat');
  await page.waitForSelector('#account:not([disabled])', { timeout: 20000 });
  const option = await page.locator('#account option').filter({ hasText: wantAccount }).first().getAttribute('value');
  if (option) await page.selectOption('#account', option);
  const has = await page.locator('#model option', { hasText: wantModel }).count();
  if (has) await page.selectOption('#model', wantModel);
  else { await page.selectOption('#model', '__custom__'); await page.fill('#model-custom', wantModel); }

  await page.fill('#composer-input', '从 1 数到 30，每个数字单独一行，不要其他内容。');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.history-item.streaming', { timeout: 10000 });
  await page.click('#new-chat');
  check(await page.locator('#empty').isVisible(), 'new chat opened while first is streaming');
  await page.fill('#composer-input', '只回复“第二个对话成功”。');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.history-item.streaming').length === 0, null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const second = (await page.textContent('.message.assistant .bubble'))?.trim();
  check(/第二个对话成功/.test(second || ''), `second reply: ${JSON.stringify(second?.slice(0, 60))}`);
  await page.locator('.history-open', { hasText: '从 1 数到 30' }).click();
  await page.waitForTimeout(500);
  const first = (await page.innerText('.message.assistant .bubble'))?.trim() || '';
  const lines = first.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  check(lines[0] === '1' && lines.at(-1) === '30', `first reply completed in background (${lines.length} lines, last=${lines.at(-1)})`);
  console.log('meta:', await page.locator('.message.assistant .meta').textContent().catch(() => null));
  await page.screenshot({ path: path.join(outDir, 'live-chat.png') });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('prism-chat:v1:')) localStorage.removeItem(k); });
  await page.goto('https://qiuzhang.xyz/');
  await page.click('button[aria-label="退出登录"]');
  await page.waitForSelector('#password', { timeout: 20000 });
  console.log('signed out');
} finally {
  await browser.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL OK');
