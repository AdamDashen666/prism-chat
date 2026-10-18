// 模型检测 page: pick a saved API (or enter one), start a run, follow the three
// independent agents and show the attribution result.
import {
  $, CUSTOM, api, busy, createNotice, createSidebar, fetchModels, fillAccounts, fillModels, loadSession, modelsOf, onShown, reducedMotion, showUser,
} from './common.js';

const ui = {
  shell: $('shell'), sidebar: $('sidebar'), backdrop: $('backdrop'), openSidebar: $('open-sidebar'), closeSidebar: $('close-sidebar'),
  notice: $('notice'),
  tabs: [...document.querySelectorAll('[data-source]')], panelSaved: $('panel-saved'), panelManual: $('panel-manual'),
  form: $('trace-form'), account: $('account'), model: $('model'), modelCustom: $('model-custom'), refreshModels: $('refresh-models'),
  baseUrl: $('base-url'), apiKey: $('api-key'), manualModel: $('manual-model'), manualSelect: $('manual-model-select'), manualFetch: $('manual-fetch'),
  pelicanStart: $('pelican-start'), pelicanStatus: $('pelican-status'),
  apiFormat: $('api-format'), temperature: $('temperature'), start: $('start'), stop: $('stop'),
  bankBody: $('bank-body'), bankCheck: $('bank-check'),
  progress: $('progress'), progressStatus: $('progress-status'), agents: $('agents'), result: $('result'),
};
const state = { accounts: [], source: 'saved', runId: null, cursor: 0, agents: [], liveModels: new Map(), autoFetched: new Set() };
const RUN_KEY = 'prism-trace-run';

const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');

const { show: notice } = createNotice(ui.notice);

// ---------- source tabs ----------
function setSource(source) {
  state.source = source;
  for (const tab of ui.tabs) {
    const on = tab.dataset.source === source;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  ui.panelSaved.hidden = source !== 'saved';
  ui.panelManual.hidden = source !== 'manual';
}

// ---------- saved accounts ----------
const account = () => state.accounts.find((a) => a.id === ui.account.value);
const selectedModel = () => (ui.model.value === CUSTOM ? ui.modelCustom.value.trim() : ui.model.value);

function renderAccounts() {
  fillAccounts(ui.account, state.accounts, { emptyLabel: '没有可用的 API，可切换到“临时输入 API”' });
  renderModels();
}

// APIs may have changed while the page was out of view; keep the selection when still usable.
async function reloadAccounts() {
  let list;
  try { list = (await api('/api/chat/accounts')).accounts || []; } catch { return; }
  const keepAccount = ui.account.value;
  const keepModel = selectedModel();
  state.accounts = list;
  renderAccounts();
  if (state.accounts.some((a) => a.id === keepAccount && a.usable)) {
    ui.account.value = keepAccount;
    renderModels(keepModel);
  }
}

function renderModels(preferred) {
  const a = account();
  fillModels(ui.model, modelsOf(a, state.liveModels), { custom: !a?.grant?.restricted, preferred, customInput: ui.modelCustom });
  ui.model.disabled = !a;
  ui.refreshModels.disabled = !a;
  // An API without a saved model list would only offer "type a model ID": fetch its list once.
  if (a && !modelsOf(a, state.liveModels).length && !state.autoFetched.has(a.id)) {
    state.autoFetched.add(a.id);
    refreshModels({ quiet: true });
  }
}

async function refreshModels({ quiet = false } = {}) {
  const a = account();
  if (!a) return;
  const keep = selectedModel();
  await busy(ui.refreshModels, async () => {
    try {
      const data = await fetchModels(a.id);
      state.liveModels.set(a.id, data.models || []);
      if (account()?.id !== a.id) return; // another API was picked meanwhile
      renderModels(keep);
      if (!quiet) notice(`已获取 ${data.models?.length || 0} 个模型`, 'success');
    } catch (error) {
      if (!quiet) notice(`获取模型列表失败：${error.message}`);
    }
  });
}

// A real <select> instead of <datalist>: a datalist filters by the input's current
// value, so once one model was filled in the others were no longer offered.
const manualModel = () => (ui.manualSelect.value === CUSTOM ? ui.manualModel.value.trim() : ui.manualSelect.value);

function syncManualModel() {
  ui.manualModel.hidden = ui.manualSelect.value !== CUSTOM;
}

function renderManualModels(list) {
  const models = [...new Set(list.filter((m) => typeof m === 'string' && m))].sort((x, y) => x.localeCompare(y));
  fillModels(ui.manualSelect, models, { preferred: manualModel(), customInput: ui.manualModel });
}

async function fetchManualModels() {
  await busy(ui.manualFetch, async () => {
    try {
      const data = await api('/api/chat/trace/models', { method: 'POST', body: { baseUrl: ui.baseUrl.value, apiKey: ui.apiKey.value } });
      renderManualModels(data.models || []);
      notice(`已获取 ${data.models?.length || 0} 个模型，可在下拉框中选择`, 'success');
    } catch (error) {
      notice(`获取模型列表失败：${error.message}`);
    }
  });
}

// ---------- fingerprint bank ----------
function renderBank(bank) {
  const u = bank.update || {};
  const added = new Set(u.lastAdded || []);
  const families = (bank.families || []).map((f) => `
    <div class="bank-family"><h3>${esc(f.name)} · ${f.models.length} 个</h3>
      <div class="chips">${f.models.map((m) => `<span class="chip${added.has(m.id) ? ' new' : ''}" title="${esc(m.id)}">${esc(m.name)}</span>`).join('')}</div>
    </div>`).join('');
  const result = { current: '已是最新', updated: '已自动更新', error: '上次检查失败' }[u.lastResult] || '尚未检查';
  const sha = bank.source?.sha ? `<code>${esc(bank.source.sha.slice(0, 7))}</code>` : '内置版本';
  ui.bankBody.innerHTML = `
    <div class="bank-stats">
      <div class="bank-stat"><span>候选模型</span><strong>${esc(bank.modelCount)}</strong></div>
      <div class="bank-stat"><span>交叉验证准确率</span><strong>${bank.cvAccuracy == null ? '—' : pct(bank.cvAccuracy)}</strong></div>
      <div class="bank-stat"><span>GitHub 版本</span><strong>${sha}</strong></div>
    </div>
    ${families}
    <p class="bank-update">每 ${esc(u.intervalHours ?? 6)} 小时自动检查 GitHub 上的新指纹。上次检查：${esc(when(u.lastCheckAt))}（${esc(result)}）${u.lastUpdateAt ? `；上次更新：${esc(when(u.lastUpdateAt))}` : ''}${added.size ? `；新增 ${added.size} 个模型（绿色标出）` : ''}。</p>
    ${u.lastError ? `<p class="bank-warn">检查失败：${esc(u.lastError)}</p>` : ''}
    ${u.algorithmChanged?.length ? `<p class="bank-warn">上游的检测算法文件有改动（${u.algorithmChanged.map(esc).join('、')}）。指纹库仍会自动更新，算法本身需要人工审阅后再同步。</p>` : ''}`;
  ui.bankCheck.hidden = !bank.canCheck;
  ui.bankCheck.disabled = Boolean(u.checking);
}

async function loadBank() {
  try { renderBank(await api('/api/chat/trace/bank')); }
  catch (error) { ui.bankBody.innerHTML = `<p class="bank-warn">${esc(error.message)}</p>`; }
}

async function checkBank() {
  await busy(ui.bankCheck, async () => {
    try {
      const bank = await api('/api/chat/trace/bank/check', { method: 'POST' });
      renderBank(bank);
      const r = bank.update?.lastResult;
      notice(r === 'updated' ? '指纹库已更新' : r === 'current' ? '指纹库已是最新' : `检查失败：${bank.update?.lastError || ''}`, r === 'error' ? 'error' : 'success');
    } catch (error) {
      notice(error.message);
    }
  });
}

// ---------- run ----------
const STATE_LABEL = { pending: '等待', working: '请求中', done: '有效', invalid: '数字不足', error: '请求失败', failed: '未获得', stopped: '已停止' };

function renderAgents() {
  ui.agents.innerHTML = state.agents.map((a, i) => `
    <article class="agent" data-state="${esc(a.state)}" aria-label="智能体 ${i + 1}">
      <div class="agent-head"><svg aria-hidden="true"><use href="#i-bot"/></svg>智能体 ${i + 1}<span class="agent-state">${esc(STATE_LABEL[a.state] || a.state)}</span></div>
      <p class="agent-detail">${esc(a.detail || '独立对话，单独一条提示词')}</p>
      <div class="agent-bar"><i></i></div>
      ${a.preview ? `<details><summary>查看模型回答</summary><pre>${esc(a.preview)}</pre></details>` : ''}
    </article>`).join('');
}

function agentDetail(e) {
  const tries = `第 ${e.attempt} 条提示词${e.calls > 1 ? ` · 第 ${e.calls} 次请求` : ''}`;
  if (e.state === 'working') return `${tries}：要求 ${e.expected} 个数字，等待完整输出…`;
  if (e.state === 'done') return `${tries}：解析到 ${e.parsed} 个数字（至少 ${e.minimum}），已计入${e.ms ? ` · ${(e.ms / 1000).toFixed(1)} 秒` : ''}`;
  if (e.state === 'invalid' || e.state === 'error') return `${tries}：${e.message || ''}`;
  if (e.state === 'failed') return '多次尝试后仍没有可用回答';
  if (e.state === 'stopped') return '已停止';
  return '';
}

function applyEvent(e) {
  if (e.type === 'start') {
    state.agents = Array.from({ length: e.agents }, () => ({ state: 'pending' }));
    ui.progressStatus.textContent = `正在检测 ${e.model}，对比 ${e.bank.models} 个候选模型`;
  } else if (e.type === 'agent') {
    const a = state.agents[e.index] || (state.agents[e.index] = {});
    const keep = a.state === 'done';
    if (!(keep && e.state !== 'done')) {
      a.state = e.state;
      a.detail = agentDetail(e) || a.detail;
      if (e.preview) a.preview = e.preview;
    }
  } else if (e.type === 'result') {
    renderResult(e.result, e.bank);
    ui.progressStatus.textContent = `检测完成：${e.result.usedOutputs}/3 份有效回答参与归因`;
  } else if (e.type === 'error') {
    ui.result.innerHTML = `<h2 id="result-title">检测结果</h2><p class="result-error">${esc(e.message)}</p>`;
    ui.result.hidden = false;
    ui.progressStatus.textContent = '检测未完成';
  }
  renderAgents();
}

function renderResult(r, bank) {
  const rows = r.results.map((m, i) => `
    <tr class="${i === 0 ? 'winner' : ''}"><td>${i + 1}</td><td title="${esc(m.id)}">${esc(m.name)}</td><td>${esc(m.family)}</td>
      <td><div class="prob"><span><i data-width="${Math.max(0, Math.min(100, m.probability * 100)).toFixed(2)}"></i></span><b>${pct(m.probability)}</b></div></td>
      <td>${pct(m.similarity)}</td></tr>`).join('');
  ui.result.innerHTML = `
    <h2 id="result-title">检测结果</h2>
    <div class="result-summary">
      <div><span>最可能是</span><strong>${esc(r.predictionName)}</strong></div>
      <div><span>归因概率</span><strong>${pct(r.probability)}</strong></div>
      <div><span>模型家族</span><strong>${esc(r.familyName)} · ${pct(r.familyProbability)}</strong></div>
      <div><span>有效回答</span><strong>${esc(r.usedOutputs)}/3</strong></div>
    </div>
    <div class="result-table-wrap"><table class="result-table">
      <caption class="visually-hidden">各候选模型的归因概率</caption>
      <thead><tr><th scope="col">排名</th><th scope="col">候选模型</th><th scope="col">家族</th><th scope="col">归因概率</th><th scope="col">分布相似度</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="result-notes" role="note">
      <p>只在指纹库内的 ${esc(bank?.models ?? r.results.length)} 个模型之间判断。被测模型不在库里时，也会被归到最相似的那个，结果仅供参考。</p>
      <p>带有长系统提示词的客户端（例如 Claude Code）会明显影响结果。</p>
    </div>`;
  // CSP forbids style attributes in markup; CSSOM writes are allowed.
  for (const bar of ui.result.querySelectorAll('[data-width]')) bar.style.width = `${bar.dataset.width}%`;
  ui.result.hidden = false;
  ui.result.focus({ preventScroll: true });
  ui.result.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function setRunning(on) {
  ui.start.disabled = on;
  ui.start.querySelector('span').textContent = on ? '检测中…' : '一键检测';
  ui.stop.hidden = !on;
}

async function follow(runId) {
  state.runId = runId;
  state.cursor = 0;
  state.agents = [];
  ui.progress.hidden = false;
  ui.result.hidden = true;
  ui.progressStatus.textContent = '正在启动三个独立智能体…';
  renderAgents();
  setRunning(true);
  sessionStorage.setItem(RUN_KEY, runId);
  let failures = 0;
  try {
    while (state.runId === runId) {
      let data;
      try {
        data = await api(`/api/chat/trace/runs/${runId}/events?after=${state.cursor}`);
        failures = 0;
      } catch (error) {
        if (/过期|不存在/.test(error.message) || ++failures > 5) throw error;
        await new Promise((r) => setTimeout(r, 1500 * failures));
        continue;
      }
      for (const e of data.events) applyEvent(e);
      state.cursor = data.next;
      if (data.status !== 'running' && data.events.some((e) => e.type === 'done')) break;
      if (data.status !== 'running' && !data.events.length) break;
    }
  } catch (error) {
    notice(error.message);
  } finally {
    if (state.runId === runId) { state.runId = null; setRunning(false); sessionStorage.removeItem(RUN_KEY); }
  }
}

// Request body for the selected API + options; null (after a notice) when incomplete.
function targetBody() {
  let body;
  if (state.source === 'saved') {
    const a = account();
    const model = selectedModel();
    if (!a) { notice('请选择一个 API'); return null; }
    if (!model) { notice('请选择或填写模型'); return null; }
    body = { source: 'saved', accountId: a.id, model };
  } else {
    const model = manualModel();
    if (!ui.baseUrl.value.trim()) { notice('请填写接口地址'); return null; }
    if (!ui.apiKey.value.trim()) { notice('请填写 API Key'); return null; }
    if (!model) { notice('请选择或填写模型'); return null; }
    body = { source: 'manual', baseUrl: ui.baseUrl.value.trim(), apiKey: ui.apiKey.value.trim(), model };
  }
  body.apiFormat = ui.apiFormat.value;
  if (ui.temperature.value !== '') body.temperature = ui.temperature.value;
  return body;
}

async function start(event) {
  event.preventDefault();
  const body = targetBody();
  if (!body) return;
  setRunning(true);
  try {
    const { runId } = await api('/api/chat/trace/runs', { method: 'POST', body });
    follow(runId);
  } catch (error) {
    setRunning(false);
    notice(error.message);
  }
}

async function stop() {
  if (!state.runId) return;
  ui.stop.disabled = true;
  try { await api(`/api/chat/trace/runs/${state.runId}/cancel`, { method: 'POST' }); }
  catch (error) { notice(error.message); }
  finally { ui.stop.disabled = false; }
}

// ---------- pelican test ----------
const PELICAN_KEY = 'prism-pelican-job';
const pelican = { id: null, job: null, tick: null };
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const secs = (ms) => `${Math.max(0, Math.round(ms / 1000))} 秒`;

function renderPelican() {
  const j = pelican.job;
  ui.pelicanStatus.hidden = !j;
  const running = j?.status === 'running';
  ui.pelicanStart.disabled = running;
  ui.pelicanStart.querySelector('span').textContent = running ? '生成中…' : j ? '重新测试' : '开始鹈鹕测试';
  if (!j) return;
  let html;
  if (running) {
    const got = j.chars ? `已收到 ${j.chars.toLocaleString('zh-CN')} 个字符` : '等待模型开始输出';
    const retry = j.attempt > 1 ? ` · 第 ${j.attempt} 次请求${j.lastError ? `（上次：${esc(j.lastError)}）` : ''}` : '';
    html = `<div class="pelican-line" data-state="running"><span class="pelican-spinner" aria-hidden="true"></span><div><strong>正在让 ${esc(j.model)} 画鹈鹕</strong><p>${got}${retry}，代码较长时可能需要几分钟。</p></div>
      <button id="pelican-stop" class="secondary-button small" type="button"><svg><use href="#i-stop"/></svg><span>停止</span></button></div>`;
  } else if (j.status === 'done') {
    const c = j.checks || {};
    const chip = (ok, yes, no) => `<span class="pelican-chip" data-ok="${ok}">${ok ? yes : no}</span>`;
    const chips = [
      chip(c.svg, '含 SVG', '没有 SVG'),
      chip(c.animation, '含动画', '未发现动画代码'),
      chip(c.complete && !c.truncated, '代码完整', c.truncated ? '输出被截断' : '结尾不完整'),
    ].join('');
    const meta = `${esc(j.model)} · ${kb(j.size)} · 用时 ${secs(j.durationMs)}${j.usage?.output ? ` · 输出 ${j.usage.output.toLocaleString('zh-CN')} tokens` : ''}`;
    let file;
    if (j.file === 'ready') {
      const left = j.expiresAt - (Date.now() - pelican.skew);
      file = `<a id="pelican-download" class="primary-button pelican-download" href="/api/chat/trace/pelican/${esc(j.id)}/download" download><svg><use href="#i-download"/></svg><span>下载 HTML</span></a>
        <span class="muted pelican-expire">${secs(left)}后自动删除，下载一次后立即删除</span>`;
    } else if (j.file === 'downloaded') file = '<span class="muted">文件已下载，服务器上的副本已删除。</span>';
    else file = '<span class="muted">文件已过期并被删除（生成后 5 分钟），请重新测试。</span>';
    html = `<div class="pelican-line" data-state="done"><div><strong>生成完成</strong><p>${meta}</p><div class="pelican-chips">${chips}</div></div></div>
      <div class="pelican-file">${file}</div>`;
  } else {
    html = `<div class="pelican-line" data-state="${esc(j.status)}"><div><strong>${j.status === 'stopped' ? '已停止' : '生成失败'}</strong><p>${esc(j.error || '')}</p></div></div>`;
  }
  ui.pelicanStatus.innerHTML = html;
  $('pelican-stop')?.addEventListener('click', stopPelican);
  $('pelican-download')?.addEventListener('click', () => {
    // The server deletes the file once it has been sent; reflect that without waiting for the poll.
    setTimeout(() => { if (pelican.job?.id === j.id && pelican.job.file === 'ready') { pelican.job.file = 'downloaded'; renderPelican(); } }, 1500);
  });
}

function pelicanTicker() {
  clearInterval(pelican.tick);
  pelican.tick = setInterval(() => {
    const j = pelican.job;
    if (!j || j.file !== 'ready') { clearInterval(pelican.tick); return; }
    if (j.expiresAt - (Date.now() - pelican.skew) <= 0) j.file = 'expired';
    const el = ui.pelicanStatus.querySelector('.pelican-expire');
    if (j.file !== 'ready') renderPelican();
    else if (el) el.textContent = `${secs(j.expiresAt - (Date.now() - pelican.skew))}后自动删除，下载一次后立即删除`;
  }, 1000);
}

function setPelican(job) {
  pelican.job = job;
  pelican.skew = job.now ? Date.now() - job.now : 0; // server clock offset for the countdown
  renderPelican();
  if (job.file === 'ready') pelicanTicker();
}

async function followPelican(id) {
  pelican.id = id;
  sessionStorage.setItem(PELICAN_KEY, id);
  let version = -1;
  let failures = 0;
  while (pelican.id === id) {
    let job;
    try {
      job = await api(`/api/chat/trace/pelican/${id}${version < 0 ? '' : `?version=${version}`}`);
      failures = 0;
    } catch (error) {
      if (/过期|不存在/.test(error.message)) { pelican.job = null; renderPelican(); break; }
      if (++failures > 5) { notice(error.message); break; }
      await new Promise((r) => setTimeout(r, 1500 * failures));
      continue;
    }
    if (pelican.id !== id) break;
    version = job.version;
    setPelican(job);
    // Keep listening while the file waits for download so "downloaded"/"expired" shows up.
    if (job.status !== 'running' && job.file !== 'ready') break;
  }
  if (pelican.id === id && pelican.job?.status !== 'running' && pelican.job?.file !== 'ready') sessionStorage.removeItem(PELICAN_KEY);
}

async function startPelican() {
  const body = targetBody();
  if (!body) return;
  ui.pelicanStart.disabled = true;
  try {
    const job = await api('/api/chat/trace/pelican', { method: 'POST', body });
    setPelican(job);
    followPelican(job.id);
  } catch (error) {
    notice(error.message);
    renderPelican();
  }
  if (!pelican.job) ui.pelicanStart.disabled = false;
}

async function stopPelican() {
  if (!pelican.job) return;
  try { setPelican(await api(`/api/chat/trace/pelican/${pelican.job.id}/cancel`, { method: 'POST' })); }
  catch (error) { notice(error.message); }
}

// ---------- init ----------
function bind() {
  createSidebar({ shell: ui.shell, openButton: ui.openSidebar, closeButton: ui.closeSidebar, backdrop: ui.backdrop });
  for (const tab of ui.tabs) {
    tab.addEventListener('click', () => setSource(tab.dataset.source));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = ui.tabs[(ui.tabs.indexOf(tab) + 1) % ui.tabs.length];
      setSource(next.dataset.source);
      next.focus();
    });
  }
  ui.account.addEventListener('change', () => renderModels());
  ui.model.addEventListener('change', () => { ui.modelCustom.hidden = ui.model.value !== CUSTOM; if (!ui.modelCustom.hidden) ui.modelCustom.focus(); });
  ui.refreshModels.addEventListener('click', () => refreshModels());
  ui.manualFetch.addEventListener('click', fetchManualModels);
  ui.manualSelect.addEventListener('change', () => { syncManualModel(); if (!ui.manualModel.hidden) ui.manualModel.focus(); });
  ui.pelicanStart.addEventListener('click', startPelican);
  ui.form.addEventListener('submit', start);
  ui.stop.addEventListener('click', stop);
  ui.bankCheck.addEventListener('click', checkBank);
}

async function init() {
  bind();
  ui.shell.classList.add('ready');
  loadBank();
  try {
    showUser(await loadSession());
    state.accounts = (await api('/api/chat/accounts')).accounts || [];
  } catch (error) {
    notice(error.message || '加载失败');
    ui.account.replaceChildren(new Option('加载失败', ''));
    return;
  }
  renderAccounts();
  if (!state.accounts.some((a) => a.usable)) setSource('manual');
  onShown(reloadAccounts);
  const resume = sessionStorage.getItem(RUN_KEY);
  if (resume) follow(resume);
  const pelicanJob = sessionStorage.getItem(PELICAN_KEY);
  if (pelicanJob) followPelican(pelicanJob);
}

init();
