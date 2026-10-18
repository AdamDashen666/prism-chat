// Copy to the clipboard from a click, shared by the pages with copy buttons (API 中转, Codex 转发).
// A page that uses it carries the #copy-dialog markup (a fallback that shows the value for copying by hand).
import { $ } from './common.js';

let timer;
function showCopyDialog(text, label) {
  $('copy-title').textContent = `手动复制${label}`;
  $('copy-value').value = text;
  $('copy-dialog').showModal();
  $('copy-value').focus();
  $('copy-value').select();
  clearTimeout(timer);
  timer = setTimeout(() => { $('copy-value').value = ''; $('copy-dialog').close(); }, 60000);
}

/** Wires the fallback dialog's buttons. Call once. */
export function bindCopyDialog() {
  $('copy-close').addEventListener('click', () => { $('copy-value').value = ''; $('copy-dialog').close(); });
  $('copy-select').addEventListener('click', () => { $('copy-value').focus(); $('copy-value').select(); });
}

/**
 * Must be called synchronously inside the click: the value may still be loading
 * (a key comes from the server), so it is handed over as a promised ClipboardItem,
 * which Safari accepts after an await; writeText after an await would lose the user
 * gesture there. If the browser refuses, the dialog shows the value instead.
 * `notice(message, tone)` reports the outcome.
 */
export function createClipboard(notice) {
  function copyValue(load, label) {
    let loadError = null;
    const value = Promise.resolve().then(load).catch((error) => { loadError = error; throw error; });
    const done = () => notice(`已复制${label}`, 'info');
    const fallback = async () => {
      try { showCopyDialog(await value, label); } catch (error) { notice(error.message || '读取失败'); }
    };
    let writing;
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const blob = value.then((text) => new Blob([text], { type: 'text/plain' }));
        blob.catch(() => {});
        writing = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      } else if (navigator.clipboard?.writeText) {
        writing = value.then((text) => navigator.clipboard.writeText(text));
      } else writing = Promise.reject(new Error('clipboard unavailable'));
    } catch (error) { writing = Promise.reject(error); }
    return writing.then(done, () => (loadError ? notice(loadError.message || '读取失败') : fallback()));
  }
  return { copyValue, copyText: (text, label) => copyValue(() => text, label) };
}
