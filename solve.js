// A fast drop-in for makefun-site 1.0.0: build(input) returns exactly the output
// tree makefun-site returns for the same input, byte for byte, but faster.
// Written from scratch from the reference's README/spec and its observable
// behaviour. No dependency, standard library only.
//
// Speed ideas, in brief:
//  - Markdown is rendered in one fused pass over the body's lines (no token
//    objects), and inline markup is scanned once with HTML escaping fused
//    into that scan, so a plain run is pushed raw instead of re-scanned by
//    a replace call; each page's blocks render into one shared array.
//  - slugify takes a native-regex fast path for ASCII text (the common case)
//    and only normalises when non-ASCII is present; tag slugs are computed
//    once per tag instead of three times.
//  - Front matter finds its closing line with indexOf instead of splitting
//    the whole source into lines, and the body is sliced, not re-joined.
//  - Templates render into one shared output array (no per-node or
//    per-include string concatenation), and loop scopes/loop records are
//    reused across iterations instead of reallocated per element.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------ text ---- */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. Most strings hold no escapable
 * character, so one cheap test skips the replace machinery for them. */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const NON_SLUG_RUN = /[^a-z0-9]+/g;
const LEAD_DASH = /^-+/;
const TRAIL_DASH = /-+$/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 * ASCII text (the overwhelmingly common case) never needs normalisation:
 * NFKD is the identity on it and it holds no combining marks, so the whole
 * transform is two native regex passes.
 */
function slugify(text) {
  let s;
  if (NON_ASCII.test(text)) {
    s = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(NON_SLUG_RUN, '-');
  } else {
    s = text.toLowerCase().replace(NON_SLUG_RUN, '-');
  }
  if (s.charCodeAt(0) === 45) s = s.replace(LEAD_DASH, '');
  if (s.charCodeAt(s.length - 1) === 45) s = s.replace(TRAIL_DASH, '');
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX);
    if (s.charCodeAt(s.length - 1) === 45) s = s.replace(TRAIL_DASH, '');
  }
  return s === '' ? 'untitled' : s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) out = slug + '-' + ++n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const day = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  const month = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  return day + ' ' + MONTHS[month - 1] + ' ' + date.slice(0, 4);
}

/* ----------------------------------------------------- front matter ---- */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !FM_TAG.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The closing line
 * is found with indexOf (the front matter is short, the body is not), and
 * the body is sliced out rather than split and re-joined.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  let closeIdx = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeIdx !== -1) bodyStart = closeIdx + 5;
  else if (text.endsWith('\n---')) {
    closeIdx = text.length - 4;
    bodyStart = text.length;
  } else return { error: 'the front matter is not closed' };
  const data = {};
  const fmText = text.slice(4, closeIdx);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: 'line ' + (j + 2) + ' is not "key: value"' };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(FM_TRAIL, '');
    if (FM_KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

/* --------------------------------------------------------- markdown ---- */

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_WS_IN_LINK = /\s/;

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** An ordered-list line's number and rest, or null: `^\d{1,9}\. (.*)$` by hand. */
function orderedOf(line) {
  let j = 0;
  while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), rest: line.slice(j + 2) };
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line === '') return true;
  const ch = line.charCodeAt(0);
  if (ch === 32 || ch === 9) return MD_BLANK.test(line);
  if (ch === 96) return line.startsWith('```') && MD_FENCE_OPEN.test(line);
  if (ch === 35) return headingOf(line) !== null;
  if (ch === 45 || ch === 42) return MD_HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash
 * escape and before `hi`, or -1. Found with indexOf; a candidate is escaped exactly when an
 * odd run of backslashes stands right before it (the reference skips a
 * backslash together with the escapable character after it, so pairs cancel).
 */
function findUnescaped(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j < hi) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 1) j = s.indexOf(what, j + 1);
    else return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **) before `hi`, outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 1) j = s.indexOf('*', j + 1);
    else if (s.charCodeAt(j + 1) === 42) j = s.indexOf('*', j + 2);
    else return j;
  }
  return -1;
}

/** The next index from `from` and before `hi` holding one of \ ` * [ or an escapable
 * character (& < > " '), or -1. One native regex scan; the plain run
 * between two such characters needs no per-character walk, and an
 * escapable character is emitted as its entity right here, so inline()
 * never calls escapeHtml on a plain run. The shared regex is safe across
 * inline()'s recursion because every search sets lastIndex first.
 */
const SPECIAL_RE = /[\\`*[&<>"']/g;
function nextSpecial(s, from, hi) {
  SPECIAL_RE.lastIndex = from;
  const m = SPECIAL_RE.exec(s);
  return m === null || m.index >= hi ? -1 : m.index;
}

const ESC_RE2 = /[&<>"']/g;
/** `s[a..b)` escaped, fragments pushed to `out` (no intermediate
 * string). Used only for code-span content, which the fused scan does
 * not cover. */
function escapeRange(s, a, b, out) {
  ESC_RE2.lastIndex = a;
  let last = a;
  let m;
  while ((m = ESC_RE2.exec(s)) !== null) {
    if (m.index >= b) break;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ESCAPES[m[0]]);
    last = m.index + 1;
  }
  ESC_RE2.lastIndex = 0;
  if (b > last) out.push(s.slice(last, b));
}

/**
 * `s[lo..hi)` rendered inline, fragments pushed to `out`. The scan jumps
 * from one markup character to the next; the plain text between them is
 * pushed raw, because the scan also stops at every escapable character
 * and emits its entity inline. A construct that fails to close stays in
 * the plain run (the run's start only moves past a construct that
 * succeeds). Nested constructs recurse on bounds, not on slices.
 * `env.link(target)` resolves a link's href.
 */
function inline(s, env, out, lo, hi) {
  let i = lo;
  let plain = lo;
  while (i < hi) {
    const j = nextSpecial(s, i, hi);
    if (j === -1) break;
    const c = s[j];
    if (c === '\\') {
      // An escapable character after the backslash is emitted literally
      // (or as its entity); any other character leaves the backslash in
      // the plain run, and the link scan below must not run for it: the
      // reference keeps `\x](url)` literal, it is not a link.
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push(ESCAPES[s[j + 1]] || s[j + 1]);
        i = j + 2;
        plain = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > plain) out.push(s.slice(plain, j));
      out.push(ESCAPES[c]);
      i = j + 1;
      plain = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>');
        escapeRange(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>');
          inline(s, env, out, j + 2, k);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>');
        inline(s, env, out, j + 1, k);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, hi);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 || m >= hi ? '' : s.slice(k + 2, m);
    if (target !== '' && !MD_WS_IN_LINK.test(target)) {
      if (j > plain) out.push(s.slice(plain, j));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inline(s, env, out, j + 1, k);
      out.push('</a>');
      i = m + 1;
      plain = i;
    } else i = j + 1;
  }
  if (hi > plain) out.push(s.slice(plain, hi));
}

/**
 * `src` rendered in one fused pass over its lines (no token objects): its
 * HTML, its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Every block's fragments go
 * straight into one shared array, with one '\n' between blocks and one
 * trailing — exactly blocks.join('\n') + '\n'. A heading's toc HTML and
 * the excerpt are the joins of the fragment ranges inline() wrote for
 * them, so no per-block array or join is ever built.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let blocks = 0;
  const sep = () => {
    if (blocks > 0) out.push('\n');
    blocks++;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const ch = line.charCodeAt(0);
    if (ch === 32 || ch === 9) {
      if (MD_BLANK.test(line)) {
        i++;
        continue;
      }
      // A non-blank indented line is paragraph text; fall through below.
    } else if (ch === 96 && line.startsWith('```')) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < n && !(lines[i].startsWith('```') && MD_FENCE_CLOSE.test(lines[i]))) body.push(lines[i++]);
        i++;
        sep();
        out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>');
        for (let k = 0; k < body.length; k++) {
          if (k > 0) out.push('\n');
          out.push(escapeHtml(body[k]));
        }
        if (body.length > 0) out.push('\n');
        out.push('</code></pre>');
        continue;
      }
    } else if (ch === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        sep();
        out.push('<h' + h.depth + ' id="' + id + '">');
        const hs = out.length;
        inline(h.text, env, out, 0, h.text.length);
        const he = out.length;
        out.push('</h' + h.depth + '>');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: out.slice(hs, he).join('') });
        i++;
        continue;
      }
    } else if (ch === 45 || ch === 42) {
      if (MD_HR.test(line)) {
        sep();
        out.push('<hr>');
        i++;
        continue;
      }
    } else if (ch === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') inner.push(t);
      }
      sep();
      if (inner.length === 0) out.push('<blockquote>\n</blockquote>');
      else {
        out.push('<blockquote>\n<p>');
        const _ib = inner.join('\n');
        inline(_ib, env, out, 0, _ib.length);
        out.push('</p>\n</blockquote>');
      }
      continue;
    }
    // List, or a paragraph.
    let bullet = null;
    let ordered = null;
    if ((ch === 45 || ch === 42) && line.charCodeAt(1) === 32) bullet = line.slice(2);
    if (bullet === null && ch >= 48 && ch <= 57) ordered = orderedOf(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (isOrdered) m = orderedOf(l);
        else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) m = l.slice(2);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.rest : m)]);
          i++;
        } else if (lines[i].charCodeAt(0) === 32 && lines[i].charCodeAt(1) === 32 && MD_CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered.num) : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      sep();
      out.push(open + '\n');
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        const _it = items[k].join('\n');
        inline(_it, env, out, 0, _it.length);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    sep();
    out.push('<p>');
    const es = out.length;
    const _pb = body.join('\n');
    inline(_pb, env, out, 0, _pb.length);
    const ee = out.length;
    out.push('</p>');
    if (excerpt === null) excerpt = out.slice(es, ee).join('');
  }
  if (blocks > 0) out.push('\n');
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

/* -------------------------------------------------------- templates ---- */

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const TPL_BLANK = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line is taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = TPL_BLANK.test(src.slice(lineStart, open)) && TPL_BLANK.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  // Scope vars objects have a null prototype, so a direct read is exactly
  // an own-property test (no inherited names can leak in); a key holding
  // undefined reads exactly like an absent key, which lookup already
  // treats as undefined (topVars clears page/posts/pager/tag to undefined,
  // and a loop var is always bound before its body renders).
  let s = scope;
  const first = path[0];
  let v = s.vars[first];
  while (v === undefined && s.parent !== null) {
    s = s.parent;
    v = s.vars[first];
  }
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** A value as escaped text: textOf, escaped; numbers and booleans have no escapable characters, so they skip the escape pass. */
function escText(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), fragments pushed to
 * `out`. `ctx.templates` holds the parsed templates. A for loop reuses one
 * scope object and one loop record across its elements (rendering is
 * synchronous, so nothing can observe a stale value).
 */
function renderNodes(nodes, scope, ctx, depth, out, shadowed = false) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escText(lookup(scope, n.path)));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out, shadowed);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // The element is bound first and `loop` second, so a loop variable
        // actually named "loop" still reads as the loop record, as in the
        // reference's { [name]: x, loop: {...} } literal.
        const loop = { index: 1, first: true, last: len === 1, length: len };
        const vars = Object.create(null);
        vars[n.name] = undefined;
        vars.loop = loop;
        const child = { vars, parent: scope };
        const bindsLoop = n.name === 'loop';
        for (let k = 0; k < len; k++) {
          if (!bindsLoop) vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(n.body, child, ctx, depth, out, shadowed || n.name === 'site' || n.name === 'tags' || n.name === 'recent');
        }
        break;
      }
      case 'include': {
        const sd = ctx.staticInfo.get(n.name);
        if (sd !== undefined && !shadowed && depth + 1 + sd < INCLUDE_DEPTH) {
          const cached = ctx.staticCache.get(n.name);
          if (cached !== undefined) {
            out.push(cached);
            break;
          }
        }
        const mi = ctx.memoInfo.get(n.name);
        if (mi !== undefined && !shadowed && depth + 1 + mi.depth < INCLUDE_DEPTH) {
          const key = lookup(scope, mi.path);
          let per = ctx.memoCache.get(n.name);
          if (per === undefined) {
            per = new Map();
            ctx.memoCache.set(n.name, per);
          }
          const hit = per.get(key);
          if (hit !== undefined) {
            out.push(hit);
            break;
          }
          const t = ctx.templates.get(n.name);
          if (t !== undefined && depth < INCLUDE_DEPTH) {
            const sub = [];
            renderNodes(t, scope, ctx, depth + 1, sub, shadowed);
            const s = sub.join('');
            per.set(key, s);
            out.push(s);
          }
          break;
        }
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out, shadowed);
        break;
      }
    }
  }
}


/* ---------------------------------------------------------- pipeline ---- */

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CR_RE = /\r\n?/g;

const WS_RE = /\s/;
/** The words of a body: its runs of characters other than whitespace. A
 * manual scan: the reference's match(/\S+/g) allocates one array entry
 * per word. ASCII whitespace is 9-13 and 32; anything else is checked
 * against \s only when a non-ASCII character actually appears. */
function wordsOf(text) {
  if (text.length === 0) return 0;
  const m = text.match(/\s+/g);
  if (m === null) return 1;
  return m.length + 1 - (WS_RE.test(text[0]) ? 1 : 0) - (WS_RE.test(text[text.length - 1]) ? 1 : 0);
}

/** `rel` (a link's path, "/"-separated) from the directory parts of a source, or null when it climbs out of the root. */
function resolveParts(dirParts, rel) {
  const parts = [...dirParts];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};

  // 1. Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CR_RE, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; refused sources and drafts are
  // reported and dropped, the first failing check the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug, unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (target.indexOf(':') !== -1 && SCHEME_RE.test(target)) return target;
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveParts(dirParts, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add('broken-link ' + srcPath + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by slug, each named as first met in the posts' order,
  // ordered by count then slug. A page's tags link to the posts' tag of the
  // same slug, or to "" where no post has it.
  const bySlug = new Map();
  // slugify is pure and tag names repeat across a case's pages: cache
  // them per case (never across cases; run() is called once per case).
  const tagSlugCache = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags !== undefined ? s.data.tags : [];
    for (const name of tags) {
      let slug = tagSlugCache.get(name);
      if (slug === undefined) {
        slug = slugify(name);
        tagSlugCache.set(name, slug);
      }
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => {
      const t = bySlug.get(slug);
      return t !== undefined ? t : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, staticInfo: new Map(), staticCache: new Map(), memoInfo: new Map(), memoCache: new Map() };
  // Static templates: output depends only on the case-level scope
  // (site, tags, recent), so one render per case is reused everywhere.
  // Analysis walks parsed nodes with a bound-var env: a first segment is
  // static when it is a case-level name or a loop var bound over a static
  // collection. A for over a dynamic collection is dynamic even if its
  // body never names the loop var (the repetition count itself depends
  // on it), as is an if on a dynamic condition. Cycles are dynamic.
  // staticInfo maps a static template to its longest include chain below
  // it; the cache is only used where that whole chain still fits under
  // the include-depth limit, and never where an enclosing for-loop var
  // shadows site/tags/recent (tracked as `shadowed` in renderNodes).
  {
    const CASE_LEVEL = new Set(['site', 'tags', 'recent']);
    const memo = new Map();
    const visiting = new Set();
    const firstStatic = (path, bound) => {
      const f = path[0];
      return bound.has(f) ? bound.get(f) : CASE_LEVEL.has(f);
    };
    const analyze = (name, bound) => {
      const key = name + '|' + [...bound.entries()].sort().map(([k, v]) => k + ':' + (v ? 1 : 0)).join(',');
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      if (visiting.has(key)) return { ok: false, depth: Infinity };
      const nodes = templates.get(name);
      if (nodes === undefined) return { ok: true, depth: 0 };
      visiting.add(key);
      let ok = true;
      let depth = 0;
      const walk = (ns, b) => {
        for (const n of ns) {
          if (!ok) return;
          if (n.kind === 'var' || n.kind === 'raw') {
            if (!firstStatic(n.path, b)) ok = false;
          } else if (n.kind === 'if') {
            if (!firstStatic(n.path, b)) ok = false;
            else {
              walk(n.then, b);
              if (n.else !== null) walk(n.else, b);
            }
          } else if (n.kind === 'for') {
            if (!firstStatic(n.path, b)) ok = false;
            else {
              const b2 = new Map(b);
              b2.set(n.name, true);
              walk(n.body, b2);
            }
          } else if (n.kind === 'include') {
            const sub = analyze(n.name, b);
            if (!sub.ok) ok = false;
            else if (sub.depth + 1 > depth) depth = sub.depth + 1;
          }
        }
      };
      walk(nodes, bound);
      visiting.delete(key);
      const res = { ok, depth: ok ? depth : Infinity };
      memo.set(key, res);
      return res;
    };
    for (const name of templates.keys()) {
      const r = analyze(name, new Map());
      if (r.ok) ctx.staticInfo.set(name, r.depth);
    }
  }
  // Memoizable templates: output is a pure function of one external value
  // (plus the fixed case-level scope). A template qualifies when every
  // free first-segment is case-level, bound inside the template itself,
  // or one single external name; 'loop' never qualifies (it is the
  // iteration record, not a function of one value). Cycles are not
  // memoizable. The render is then cached per (template, value): a post's
  // card, rendered once per index page and once per tag page, is built
  // once and reused ~3x. memoInfo maps name -> { var, path, depth }.
  {
    const CASE_LEVEL = new Set(['site', 'tags', 'recent']);
    const memo = new Map();
    const visiting = new Set();
    const analyzeMemo = (name) => {
      const hit = memo.get(name);
      if (hit !== undefined) return hit;
      if (visiting.has(name)) return { ok: false, ext: null, depth: Infinity };
      const nodes = templates.get(name);
      if (nodes === undefined) return { ok: true, ext: new Set(), depth: 0 };
      visiting.add(name);
      let ok = true;
      const ext = new Set();
      let depth = 0;
      const check = (path, bound) => {
        const f = path[0];
        if (f === 'loop') { ok = false; return; }
        if (bound.has(f)) return;
        if (CASE_LEVEL.has(f)) return;
        ext.add(f);
      };
      const walk = (ns, bound) => {
        for (const n of ns) {
          if (!ok) return;
          if (n.kind === 'var' || n.kind === 'raw') check(n.path, bound);
          else if (n.kind === 'if') {
            check(n.path, bound);
            if (ok) {
              walk(n.then, bound);
              if (n.else !== null) walk(n.else, bound);
            }
          } else if (n.kind === 'for') {
            check(n.path, bound);
            if (!ok) return;
            const b2 = new Set(bound);
            b2.add(n.name);
            walk(n.body, b2);
          } else if (n.kind === 'include') {
            const sub = analyzeMemo(n.name);
            if (!sub.ok) { ok = false; return; }
            for (const v of sub.ext) if (!bound.has(v)) ext.add(v);
            if (sub.depth + 1 > depth) depth = sub.depth + 1;
          }
        }
      };
      walk(nodes, new Set());
      visiting.delete(name);
      const res = { ok, ext, depth: ok ? depth : Infinity };
      memo.set(name, res);
      return res;
    };
    for (const name of templates.keys()) {
      const r = analyzeMemo(name);
      if (r.ok && r.ext.size === 1) {
        const v = [...r.ext][0];
        ctx.memoInfo.set(name, { var: v, path: [v], depth: r.depth });
      }
    }
  }
  // One top scope per case: its render-specific keys (page, posts, pager,
  // tag) are overwritten per render and cleared to undefined after, which
  // reads exactly like an absent key, so no fresh object per render.
  const topVars = Object.create(null);
  topVars.site = site;
  topVars.tags = allTags;
  topVars.recent = recent;
  const topScope = { vars: topVars, parent: null };
  const renderOut = [];
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    topVars.page = vars.page !== undefined ? vars.page : undefined;
    topVars.posts = vars.posts !== undefined ? vars.posts : undefined;
    topVars.pager = vars.pager !== undefined ? vars.pager : undefined;
    topVars.tag = vars.tag !== undefined ? vars.tag : undefined;
    renderOut.length = 0;
    renderNodes(nodes, topScope, ctx, 0, renderOut);
    return renderOut.join('');
  };
  for (const name of ctx.staticInfo.keys()) {
    const html = render(name, {});
    if (html !== null) ctx.staticCache.set(name, html);
  }
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}
