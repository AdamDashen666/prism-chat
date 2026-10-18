// Minimal Markdown renderer that builds DOM nodes directly.
// Model output is never assigned to innerHTML, so it cannot inject markup.
import { highlight } from './highlight.js';

const SAFE_LINK = /^(https?:|mailto:)/i;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs.
export function inline(text, parent) {
  const pattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?!\w)|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"，。；：！？])/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    if (match[2] !== undefined) parent.append(el('code', null, match[2].replace(/^ (.*) $/, '$1')));
    else if (match[3] !== undefined || match[4] !== undefined) inline(match[3] ?? match[4], parent.appendChild(el('strong')));
    else if (match[5] !== undefined) inline(match[5], parent.appendChild(el('em')));
    else if (match[6] !== undefined) inline(match[6], parent.appendChild(el('del')));
    else {
      const href = match[8] ?? match[9];
      const label = match[7] ?? match[9];
      if (SAFE_LINK.test(href)) {
        const a = el('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        inline(label, a);
        parent.append(a);
      } else parent.append(match[0]);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function tableCells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

// Code blocks longer than this are folded to a preview with an expand toggle.
export const FOLD_LINES = 20;

function codeBlock(lang, content, closed, { onCopy, folds, ctx }) {
  const index = ctx.code++;
  const block = el('div', 'code-block');
  const head = el('div', 'code-head');
  head.append(el('span', null, lang || 'text'));
  const copy = el('button', 'code-copy', '复制');
  copy.type = 'button';
  copy.addEventListener('click', () => onCopy?.(content, copy));
  head.append(copy);
  const pre = el('pre');
  pre.append(highlight(content, lang));
  block.append(head, pre);
  const lines = content.split('\n').length;
  if (lines <= FOLD_LINES) return block;
  // Fold state lives outside the DOM (folds) because streaming replies are re-rendered on every token.
  const open = Boolean(folds?.isOpen(index));
  block.classList.add('foldable');
  block.classList.toggle('folded', !open);
  if (!closed) block.dataset.live = ''; // still streaming: the page keeps the newest lines in view
  pre.id = `code-${ctx.id}-${index}`;
  const bar = el('div', 'code-fold');
  const toggle = el('button', 'code-fold-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', pre.id);
  const label = (on) => {
    toggle.textContent = on ? '收起代码' : `展开全部 · 共 ${lines} 行`;
    toggle.setAttribute('aria-expanded', String(on));
  };
  label(open);
  toggle.addEventListener('click', () => {
    const next = block.classList.contains('folded');
    block.classList.toggle('folded', !next);
    label(next);
    folds?.toggle(index, next);
    if (!next) {
      pre.scrollTop = 0;
      const top = block.getBoundingClientRect().top;
      if (top < 0) block.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  });
  bar.append(toggle);
  block.append(bar);
  return block;
}

let renderId = 0;

/**
 * folds: optional { isOpen(i), toggle(i, open) } keeping per-block expand state
 * across re-renders (i = code block order within this source).
 */
export function render(source, { onCopy, folds, ctx = { code: 0, id: ++renderId } } = {}) {
  const opts = { onCopy, folds, ctx };
  const root = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let paragraph = [];

  const flush = () => {
    if (!paragraph.length) return;
    const p = el('p');
    paragraph.forEach((line, index) => {
      if (index) p.append(el('br'));
      inline(line, p);
    });
    root.append(p);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const closer = fence[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(closer)) code.push(lines[i++]);
      const closed = i < lines.length;
      i++;
      root.append(codeBlock(fence[2], code.join('\n'), closed, opts));
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const h = el('h' + Math.min(6, heading[1].length + 2));
      inline(heading[2].replace(/\s+#+\s*$/, ''), h);
      root.append(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); root.append(el('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = el('blockquote');
      bq.append(render(quote.join('\n'), opts));
      root.append(bq);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const header = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const wrap = el('div', 'table-wrap');
      const table = el('table');
      const thead = el('thead');
      const tr = el('tr');
      header.forEach((c, k) => { const th = el('th'); if (aligns[k]) th.style.textAlign = aligns[k]; inline(c, th); tr.append(th); });
      thead.append(tr);
      const tbody = el('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = el('tr');
        tableCells(lines[i]).forEach((c, k) => { const td = el('td'); if (aligns[k]) td.style.textAlign = aligns[k]; inline(c, td); row.append(td); });
        tbody.append(row);
        i++;
      }
      table.append(thead, tbody);
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const list = el(ordered ? 'ol' : 'ul');
      if (ordered && parseInt(item[2], 10) !== 1) list.start = parseInt(item[2], 10);
      const baseIndent = item[1].length;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || m[1].length < baseIndent || /\d/.test(m[2]) !== ordered) break;
        if (m[1].length > baseIndent + 1) break;
        const li = el('li');
        const body = [m[3]];
        i++;
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) body.push(lines[i++].trim());
        const nested = [];
        while (i < lines.length && /^\s+([-*+]|\d+[.)])\s+/.test(lines[i]) && lines[i].match(/^(\s*)/)[1].length > baseIndent + 1) nested.push(lines[i++]);
        const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const box = el('input');
          box.type = 'checkbox';
          box.disabled = true;
          box.checked = task[1] !== ' ';
          li.append(box, ' ');
          body[0] = task[2];
        }
        inline(body.join(' '), li);
        if (nested.length) {
          const indent = Math.min(...nested.map((l) => l.match(/^(\s*)/)[1].length));
          li.append(render(nested.map((l) => l.slice(indent)).join('\n'), opts));
        }
        list.append(li);
        while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i + 1])) i++;
      }
      root.append(list);
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return root;
}
