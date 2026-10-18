// Lightweight syntax highlighting for code blocks: one small tokenizer per
// language family. Tokens become <span class="tok-…"> nodes built with the DOM
// API, so code (usually model output) is never parsed as HTML.

const LIMIT = 200_000; // longer blocks stay plain text
const NUMBER = '\\b0[xX][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[a-zA-Z%]*';
const WORD = '[A-Za-z_$][\\w$]*';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s) => new Set(String(s || '').split(/\s+/).filter(Boolean));

function stringRe(q) {
  const e = escRe(q);
  if (q.length === 3) return `${e}[\\s\\S]*?(?:${e}|$)`;
  if (q === '`') return `${e}(?:\\\\[\\s\\S]|[^${e}\\\\])*(?:${e}|$)`;
  return `${e}(?:\\\\.|[^${e}\\\\\\n])*(?:${e}|$|(?=\\n))`;
}

const JS_KEYWORDS = 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield';
const JS_TYPES = 'Array Object String Number Boolean BigInt Symbol Promise Map Set WeakMap Date RegExp Error JSON Math Intl console window document globalThis process require module exports';
const JS = { line: ['//'], block: ['/*', '*/'], strings: ['`', '"', "'"], meta: '@[A-Za-z_$][\\w$.]*', keywords: JS_KEYWORDS, literals: 'true false null undefined NaN Infinity', types: JS_TYPES };

const SPECS = {
  js: JS,
  ts: {
    ...JS,
    keywords: `${JS_KEYWORDS} abstract as declare enum implements interface keyof namespace private protected public readonly satisfies type infer is`,
    types: `${JS_TYPES} string number boolean bigint symbol void never unknown any object Record Partial Readonly Pick Omit`,
  },
  python: {
    line: ['#'], strings: ['"""', "'''", '"', "'"], meta: '@[A-Za-z_][\\w.]*',
    keywords: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
    literals: 'True False None',
    types: 'int float str bool list dict set tuple bytes bytearray object type len range print open self cls super isinstance enumerate zip map filter sorted min max sum any all Exception ValueError TypeError KeyError',
  },
  go: {
    line: ['//'], block: ['/*', '*/'], strings: ['`', '"', "'"],
    keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    literals: 'true false nil iota',
    types: 'int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 byte rune string bool error any make new len cap append copy delete panic recover',
  },
  rust: {
    line: ['//'], block: ['/*', '*/'], strings: ['"'], meta: '#!?\\[[^\\]\\n]*\\]',
    keywords: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while macro_rules',
    literals: 'true false None Some Ok Err',
    types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet',
  },
  // C, C++, Java, C#, Kotlin, Swift, PHP, Dart, Scala: one shared C-like vocabulary.
  c: {
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"], flags: 'm',
    meta: '(?<=^[ \\t]*)#[ \\t]*[A-Za-z]+|@[A-Za-z_]\\w*', variable: '\\$[A-Za-z_]\\w*',
    keywords: 'abstract async await break case catch class const continue default delete do else enum explicit export extends extern final finally for friend fun func goto guard if implements import in inline instanceof interface internal is let namespace new object operator override package private protected public return sealed static struct super switch template this throw throws try typedef typename union using val var virtual void volatile when where while yield echo function foreach elseif endif match data companion protocol extension defer lateinit open suspend readonly record',
    literals: 'true false null nullptr NULL nil',
    types: 'int long short char float double bool boolean byte String string auto unsigned signed size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t object dynamic Integer Long List Map Set Array Any Unit Int Float Double Boolean std vector',
  },
  sql: {
    line: ['--', '#'], block: ['/*', '*/'], strings: ["'", '"', '`'], ci: true,
    keywords: 'select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer full cross on group by order having limit offset as distinct union all case when then else end exists in is like ilike between asc desc with returning default constraint unique if begin commit rollback transaction grant revoke truncate replace explain database schema trigger procedure function returns declare',
    literals: 'null true false',
    types: 'int integer bigint smallint tinyint varchar char text boolean bool date time timestamp timestamptz datetime numeric decimal float double real serial bigserial json jsonb uuid blob count sum avg min max coalesce now',
  },
  bash: {
    line: ['#'], strings: ['"', "'"], variable: '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_]\\w*|\\$[0-9@#?*$!-]',
    keywords: 'if then else elif fi for while until do done case esac in function return local export readonly declare unset set shift exit break continue source alias select time',
    types: 'echo printf cd ls cat grep sed awk curl wget chmod chown mkdir rm cp mv ln touch find xargs tar sudo systemctl journalctl apt apt-get npm npx node git docker python python3 pip ssh scp test read',
  },
  powershell: {
    line: ['#'], block: ['<#', '#>'], strings: ['"', "'"], ci: true, variable: '\\$[\\w:]+',
    extra: [['type', '\\b[A-Za-z]+-[A-Za-z]+\\b']],
    keywords: 'begin process end if else elseif switch foreach for while do until function filter param return try catch finally throw trap break continue exit in',
  },
  json: { line: ['//'], block: ['/*', '*/'], key: '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)', strings: ['"'], literals: 'true false null' },
  yaml: {
    line: ['#'], strings: ['"', "'"], flags: 'm', literals: 'true false null yes no on off',
    key: '(?<=^[ \\t]*(?:-[ \\t]+)?)[\\w./-]+(?=[ \\t]*:(?:[ \\t]|$))',
  },
  ini: {
    line: ['#', ';'], strings: ['"', "'"], flags: 'm', literals: 'true false',
    meta: '(?<=^[ \\t]*)\\[[^\\]\\n]*\\]', key: '(?<=^[ \\t]*)[\\w.-]+(?=[ \\t]*=)',
  },
  css: {
    block: ['/*', '*/'], strings: ['"', "'"], flags: 'm',
    key: '(?<=^[ \\t]*|[{;][ \\t]*)[\\w-]+(?=[ \\t]*:)',
    extra: [['keyword', '@[\\w-]+|!important'], ['number', '#[\\da-fA-F]{3,8}\\b']],
    literals: 'inherit initial unset none auto transparent currentColor',
  },
  diff: { flags: 'm', noWords: true, extra: [['inserted', '^\\+[^\\n]*'], ['deleted', '^-[^\\n]*'], ['meta', '^@@[^\\n]*']] },
};

const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', typescript: 'ts', tsx: 'ts',
  py: 'python', python3: 'python', golang: 'go', rs: 'rust',
  'c++': 'c', cpp: 'c', cc: 'c', h: 'c', hpp: 'c', java: 'c', cs: 'c', csharp: 'c', kotlin: 'c', kt: 'c', swift: 'c', php: 'c', dart: 'c', scala: 'c', objc: 'c',
  mysql: 'sql', postgresql: 'sql', postgres: 'sql', sqlite: 'sql', plsql: 'sql',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', shellscript: 'bash', dockerfile: 'bash', docker: 'bash', makefile: 'bash', make: 'bash',
  ps1: 'powershell', ps: 'powershell', pwsh: 'powershell',
  jsonc: 'json', json5: 'json', yml: 'yaml', toml: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  scss: 'css', less: 'css', patch: 'diff',
  html: 'markup', htm: 'markup', xhtml: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
};

export function languageKey(lang) {
  const k = String(lang || '').toLowerCase();
  if (SPECS[k] || k === 'markup') return k;
  return ALIASES[k] || '';
}

// Fence tag for an attached file, by its name ('' = plain text).
const EXTENSIONS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', php: 'php', dart: 'dart', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', conf: 'conf', cfg: 'ini', env: 'env', properties: 'properties', md: 'markdown',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', xml: 'xml', svg: 'svg', css: 'css', scss: 'scss', less: 'less',
  diff: 'diff', patch: 'diff', csv: 'csv',
};
export function languageForFile(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'dockerfile' || n === 'makefile') return n;
  const ext = n.includes('.') ? n.split('.').pop() : '';
  return EXTENSIONS[ext] || '';
}

const compiled = new Map();
function compile(key) {
  if (compiled.has(key)) return compiled.get(key);
  const s = SPECS[key];
  const rules = [];
  if (s.block) rules.push(['comment', `${escRe(s.block[0])}[\\s\\S]*?(?:${escRe(s.block[1])}|$)`]);
  if (s.line) rules.push(['comment', `(?:${s.line.map(escRe).join('|')})[^\\n]*`]);
  if (s.meta) rules.push(['meta', s.meta]);
  if (s.key) rules.push(['key', s.key]);
  for (const q of s.strings || []) rules.push(['string', stringRe(q)]);
  if (s.variable) rules.push(['variable', s.variable]);
  for (const rule of s.extra || []) rules.push(rule);
  if (!s.noWords) rules.push(['number', NUMBER], ['word', WORD]);
  const spec = {
    re: new RegExp(rules.map(([, src]) => `(${src})`).join('|'), `g${s.flags || ''}`),
    classes: rules.map(([cls]) => cls),
    ci: Boolean(s.ci),
    keywords: words(s.keywords), literals: words(s.literals), types: words(s.types),
  };
  compiled.set(key, spec);
  return spec;
}

function classify(word, text, end, spec) {
  const w = spec.ci ? word.toLowerCase() : word;
  if (spec.keywords.has(w)) return 'keyword';
  if (spec.literals.has(w)) return 'literal';
  if (spec.types.has(w)) return 'type';
  let j = end;
  while (text[j] === ' ' || text[j] === '\t') j++;
  return text[j] === '(' ? 'function' : null;
}

function tokenize(text, key, add) {
  if (key === 'markup') return markup(text, add);
  const spec = compile(key);
  const { re } = spec;
  re.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    let cls = spec.classes[m.findIndex((g, k) => k > 0 && g !== undefined) - 1];
    if (cls === 'word') cls = classify(m[0], text, re.lastIndex, spec);
    if (!cls) continue;
    if (m.index > last) add(text.slice(last, m.index));
    add(m[0], cls);
    last = re.lastIndex;
  }
  if (last < text.length) add(text.slice(last));
}

// HTML / XML / SVG. Attributes and quoted values count only inside a tag;
// <script> and <style> bodies are handed to the JS and CSS tokenizers.
const MARKUP = /(<!--[\s\S]*?(?:-->|$))|(<![A-Za-z][^>]*>?|<\?[\s\S]*?(?:\?>|$))|(<\/?[A-Za-z][\w:.-]*)|(\/?>)|([A-Za-z_:@][\w:.-]*)(?=\s*=)|("[^"]*"?|'[^']*'?)|(&#?\w+;)/g;
function markup(text, add) {
  let inTag = false;
  let tag = '';
  let last = 0;
  let m;
  const re = new RegExp(MARKUP.source, 'g'); // reentrant: script bodies recurse
  const emit = (start, token, cls) => {
    if (start > last) add(text.slice(last, start));
    add(token, cls);
    last = start + token.length;
  };
  while ((m = re.exec(text))) {
    if (m[1]) emit(m.index, m[0], 'comment');
    else if (m[2]) emit(m.index, m[0], 'meta');
    else if (m[3]) { inTag = true; tag = m[3][1] === '/' ? '' : m[3].slice(1).toLowerCase(); emit(m.index, m[0], 'tag'); }
    else if (m[4] && inTag) {
      inTag = false;
      emit(m.index, m[0], 'tag');
      if ((tag === 'script' || tag === 'style') && m[4] === '>') {
        const close = text.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        const end = close < 0 ? text.length : close;
        if (end > re.lastIndex) tokenize(text.slice(re.lastIndex, end), tag === 'script' ? 'js' : 'css', add);
        last = end;
        re.lastIndex = end;
      }
    } else if (m[5] && inTag) emit(m.index, m[0], 'attr');
    else if (m[6] && inTag) emit(m.index, m[0], 'string');
    else if (m[7]) emit(m.index, m[0], 'literal');
  }
  if (last < text.length) add(text.slice(last));
}

/** A <code> element with highlighted `code`; plain text for unknown or very long code. */
export function highlight(code, lang) {
  const out = document.createElement('code');
  const key = languageKey(lang);
  if (!key || code.length > LIMIT) { out.textContent = code; return out; }
  const frag = document.createDocumentFragment();
  let plain = '';
  tokenize(code, key, (text, cls) => {
    if (!cls) { plain += text; return; }
    if (plain) { frag.append(plain); plain = ''; }
    const span = document.createElement('span');
    span.className = `tok-${cls}`;
    span.textContent = text;
    frag.append(span);
  });
  if (plain) frag.append(plain);
  out.append(frag);
  return out;
}
