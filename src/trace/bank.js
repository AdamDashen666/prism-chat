// ModelTrace fingerprint bank: loads the active bank and keeps it in sync with
// github.com/xqy2006/ModelTrace. Only *data* (data/unified_bank.json) is ever
// taken from GitHub; it is schema-checked and must pass a self-test on real
// reference outputs before it replaces the current bank. Upstream code is
// never executed — when the algorithm files change we only flag it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from '../util.js';
import { DIMENSION, analyzeGlobalOutputs } from './fingerprint-core.js';

const REPO = 'xqy2006/ModelTrace';
const BRANCH = 'main';
const BANK_PATH = 'data/unified_bank.json';
const ALGORITHM_FILES = ['fingerprint.py', 'static/fingerprint-core.js', 'static/challenge-browser.js', 'challenge_suite.py'];
const MAX_BANK_BYTES = 16 * 1024 * 1024;
const BUNDLED_DIR = fileURLToPath(new URL('../../data/modeltrace/', import.meta.url));

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);
const matrix = (m, rows, n) => Array.isArray(m) && (rows === undefined || m.length === rows) && m.every((r) => vec(r, n));

/** Throws with a readable reason when the bank does not match what fingerprint-core.js expects. */
export function validateBank(bank) {
  const fail = (why) => { throw new Error(`指纹库格式不兼容：${why}`); };
  if (!bank || typeof bank !== 'object') fail('不是 JSON 对象');
  if (bank.schema !== 'robust-number-fingerprint-bank') fail(`schema=${bank.schema}`);
  const models = bank.models;
  if (!Array.isArray(models) || models.length < 2 || models.length > 500) fail('models');
  const ids = new Set();
  for (const m of models) {
    if (typeof m?.id !== 'string' || !m.id || m.id.length > 200 || ids.has(m.id)) fail('model id');
    ids.add(m.id);
    if (typeof m.display_name !== 'string') fail(`display_name of ${m.id}`);
    if (!vec(m.counts, DIMENSION)) fail(`counts of ${m.id}`);
  }
  const h = bank.robust?.hellinger;
  if (!h || !vec(h.feature_mean, DIMENSION) || !vec(h.feature_scale, DIMENSION)) fail('hellinger');
  if (!matrix(h.nuisance_basis, undefined, DIMENSION) || !matrix(h.centroids, models.length, DIMENSION)) fail('hellinger centroids');
  const o = bank.robust?.ordered_blocks;
  if (o) {
    const n = o.feature_mean?.length;
    if (n !== 74 || !vec(o.feature_mean, n) || !vec(o.feature_scale, n) || !isNum(o.weight)) fail('ordered_blocks');
    if (!matrix(o.nuisance_basis, undefined, n) || !matrix(o.centroids, models.length, n)) fail('ordered_blocks centroids');
    if (!Array.isArray(o.environment_centroids) || !o.environment_centroids.length ||
      !o.environment_centroids.every((e) => matrix(e, models.length, n))) fail('environment_centroids');
  }
  for (const k of ['1', '2', '3']) if (!isNum(bank.calibration?.[k]?.beta)) fail(`calibration ${k}`);
  return bank;
}

/** Real outputs of known models must still be attributed correctly by the new bank. */
export function selfTest(bank, fixtures) {
  const ids = new Set(bank.models.map((m) => m.id));
  let checked = 0;
  for (const [model, outputs] of Object.entries(fixtures || {})) {
    const result = analyzeGlobalOutputs(outputs.map((o) => ({ text: o.text, expected_count: o.expected })), bank);
    if (!result.results.every((r) => isNum(r.probability))) throw new Error('自检失败：概率不是有限数');
    if (!ids.has(model)) continue;
    checked++;
    if (result.prediction !== model) throw new Error(`自检失败：${model} 的参考回答被判为 ${result.prediction}`);
  }
  return checked;
}

export function summarize(bank, source) {
  const families = [];
  for (const m of bank.models) {
    const id = m.family || 'models';
    let f = families.find((x) => x.id === id);
    if (!f) families.push(f = { id, name: m.family_name || id, models: [] });
    f.models.push({ id: m.id, name: m.display_name, responses: m.response_count ?? null });
  }
  return {
    modelCount: bank.models.length,
    families,
    builtAt: bank.built_at || source?.builtAt || null,
    cvAccuracy: bank.calibration?.['3']?.cv_accuracy ?? null,
    source: source ? { repo: source.repo, sha: source.sha, committedAt: source.committedAt } : null,
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function defaultFetch(url, { accept } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'PrismTrace/1.0 (+https://qiuzhang.xyz)', ...(accept ? { accept } : {}) },
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BANK_BYTES) throw new Error('下载内容过大');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BANK_BYTES) throw new Error('下载内容过大');
  return buffer;
}

/**
 * dir: writable state directory (downloaded bank + status).
 * fetchBuffer(url, {accept}) -> Buffer; injectable for tests.
 */
export function createTraceBank({
  dir,
  bundledDir = BUNDLED_DIR,
  fetchBuffer = defaultFetch,
  intervalMs = 6 * 3600 * 1000,
  firstCheckMs = 90 * 1000,
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bundledSource = readJson(path.join(bundledDir, 'source.json'));
  const fixtures = readJson(path.join(bundledDir, 'selftest.json')) || {};
  const statusFile = dir && path.join(dir, 'status.json');
  let status = (statusFile && readJson(statusFile)) || {};
  status = { lastCheckAt: null, lastResult: null, lastError: null, lastUpdateAt: null, upstreamSha: null, algorithmChanged: [], ...status, checking: false };
  let active;

  function load(bankFile, source, origin) {
    const bank = validateBank(JSON.parse(fs.readFileSync(bankFile, 'utf8')));
    return { bank, source, origin, summary: summarize(bank, source) };
  }

  // Prefer the downloaded bank unless the bundled one (from a newer deploy) is newer.
  const bundled = load(path.join(bundledDir, 'unified_bank.json'), bundledSource, 'bundled');
  active = bundled;
  if (dir && fs.existsSync(path.join(dir, 'unified_bank.json'))) {
    try {
      const saved = load(path.join(dir, 'unified_bank.json'), readJson(path.join(dir, 'source.json')), 'github');
      const time = (s) => Date.parse(s?.committedAt || '') || 0;
      const newer = time(saved.source) > time(bundledSource);
      if (newer || saved.source?.sha === bundledSource?.sha) active = saved;
    } catch (error) {
      log({ event: 'trace_bank_saved_invalid', message: error.message });
    }
  }

  function saveStatus() {
    if (!statusFile) return;
    const { checking, ...rest } = status;
    try { writeAtomic(statusFile, JSON.stringify(rest)); } catch { /* status is best effort */ }
  }

  async function algorithmDrift(sha) {
    const changed = [];
    for (const file of ALGORITHM_FILES) {
      const known = bundledSource?.algorithm?.[file];
      if (!known) continue;
      try {
        const body = await fetchBuffer(`https://raw.githubusercontent.com/${REPO}/${sha}/${file}`);
        if (sha256(body) !== known) changed.push(file);
      } catch { /* a missing/renamed file is also a change */ changed.push(file); }
    }
    return changed;
  }

  let running = null;
  async function runCheck() {
    status.checking = true;
    status.lastCheckAt = Date.now();
    try {
      const sha = (await fetchBuffer(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { accept: 'application/vnd.github.sha' }))
        .toString('utf8').trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('无法读取 GitHub 最新提交');
      status.upstreamSha = sha;
      if (sha === active.source?.sha) {
        status.lastResult = 'current';
        status.lastError = null;
        return status;
      }
      const raw = await fetchBuffer(`https://raw.githubusercontent.com/${REPO}/${sha}/${BANK_PATH}`);
      status.algorithmChanged = await algorithmDrift(sha);
      const digest = sha256(raw);
      let commit = {};
      try {
        commit = JSON.parse((await fetchBuffer(`https://api.github.com/repos/${REPO}/commits/${sha}`, { accept: 'application/vnd.github+json' })).toString('utf8'));
      } catch { /* date is cosmetic */ }
      const source = {
        repo: REPO, branch: BRANCH, sha,
        committedAt: commit?.commit?.committer?.date || new Date().toISOString(),
        message: String(commit?.commit?.message || '').split('\n')[0].slice(0, 200),
        bankSha256: digest,
        algorithm: bundledSource?.algorithm,
      };
      if (digest === active.source?.bankSha256) {
        // Same fingerprints, newer commit (README / plugin changes): just remember the commit.
        active = { ...active, source: { ...active.source, sha, committedAt: source.committedAt } };
        active.summary = summarize(active.bank, active.source);
        if (dir && active.origin === 'github') writeAtomic(path.join(dir, 'source.json'), JSON.stringify(active.source));
        status.lastResult = 'current';
        status.lastError = null;
        return status;
      }
      const bank = validateBank(JSON.parse(raw.toString('utf8')));
      const checked = selfTest(bank, fixtures);
      const before = new Set(active.bank.models.map((m) => m.id));
      const added = bank.models.map((m) => m.id).filter((id) => !before.has(id));
      if (dir) {
        writeAtomic(path.join(dir, 'unified_bank.json'), raw);
        writeAtomic(path.join(dir, 'source.json'), JSON.stringify(source));
      }
      active = { bank, source, origin: 'github', summary: summarize(bank, source) };
      status.lastResult = 'updated';
      status.lastUpdateAt = Date.now();
      status.lastAdded = added;
      status.lastError = null;
      log({ event: 'trace_bank_updated', sha, models: bank.models.length, added, selfTest: checked, algorithmChanged: status.algorithmChanged });
      return status;
    } catch (error) {
      status.lastResult = 'error';
      status.lastError = String(error?.message || error).slice(0, 300);
      log({ event: 'trace_bank_check_failed', message: status.lastError });
      return status;
    } finally {
      status.checking = false;
      saveStatus();
    }
  }

  function check() {
    running ??= runCheck().finally(() => { running = null; });
    return running;
  }

  let timers = [];
  return {
    current: () => active,
    status: () => ({ ...status, intervalHours: intervalMs / 3600000, activeOrigin: active.origin }),
    check,
    start() {
      const first = setTimeout(check, firstCheckMs);
      const every = setInterval(check, intervalMs);
      first.unref(); every.unref();
      timers = [first, every];
    },
    stop() { for (const t of timers) clearTimeout(t); timers = []; },
  };
}
