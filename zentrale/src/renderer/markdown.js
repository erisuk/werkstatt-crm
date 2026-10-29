// Markdown für Claudes Antworten – wie in der Claude-App: Überschriften, Listen, Code mit Kopieren-Knopf,
// Tabellen, Zitate, Links. Baut nur DOM-Knoten (nie innerHTML), so kann kein HTML aus einer Antwort ausgeführt werden.
// parseMarkdown/parseInline sind reine Funktionen (in Node testbar), mdRender baut daraus die Knoten.

const MD_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const MD_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const MD_QUOTE = /^ {0,3}>\s?/;
const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const mdIndent = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const mdBlank = (l) => !l || !l.trim();

function mdCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { out.push(cur.trim()); cur = ''; } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function mdIsTable(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function mdStartsBlock(lines, i) {
  const l = lines[i];
  return MD_FENCE.test(l) || MD_HEADING.test(l) || MD_HR.test(l) || MD_QUOTE.test(l) || MD_LIST.test(l) || mdIsTable(lines, i);
}

function mdParseList(lines, start) {
  const first = MD_LIST.exec(lines[start]);
  const base = mdIndent(first[1]);
  const ordered = /\d/.test(first[2]);
  const block = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = MD_LIST.exec(lines[i]);
    if (!m || mdIndent(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = base + m[2].length + 1;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (mdBlank(l)) {
        let j = i + 1;
        while (j < lines.length && mdBlank(lines[j])) j++;
        if (j < lines.length && mdIndent(lines[j]) >= contentIndent) { body.push(''); i++; continue; }
        break;
      }
      const ind = mdIndent(l);
      if (ind >= contentIndent || (ind > base && MD_LIST.test(l))) { body.push(l.replace(/\t/g, '    ').slice(Math.min(ind, contentIndent))); i++; continue; }
      if (ind <= base && MD_LIST.test(l)) break;
      if (!mdStartsBlock(lines, i)) { body.push(l.trim()); i++; continue; } // Fortsetzung ohne Einrückung
      break;
    }
    block.items.push(parseMarkdown(body.join('\n')));
    // Leerzeilen zwischen zwei Punkten derselben Liste überspringen.
    let j = i;
    while (j < lines.length && mdBlank(lines[j])) j++;
    const next = j < lines.length && MD_LIST.exec(lines[j]);
    if (j > i && next && mdIndent(next[1]) === base && /\d/.test(next[2]) === ordered) i = j;
  }
  return { block, next: i };
}

// Text → Liste von Blöcken: p, heading, code, list, quote, table, hr.
function parseMarkdown(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (mdBlank(l)) { i++; continue; }
    const fence = MD_FENCE.exec(l);
    if (fence) {
      const mark = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && lines[i].trim().replace(new RegExp(`^\\${mark[0]}+`), '').trim() === '')) { body.push(lines[i]); i++; }
      i++; // schließende Zäune (fehlt sie, endet der Block am Textende)
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }
    const heading = MD_HEADING.exec(l);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (MD_HR.test(l)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (mdIsTable(lines, i)) {
      const head = mdCells(l);
      const align = mdCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && !mdBlank(lines[i]) && lines[i].includes('|')) { rows.push(mdCells(lines[i])); i++; }
      blocks.push({ type: 'table', head, align, rows });
      continue;
    }
    if (MD_QUOTE.test(l)) {
      const body = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) { body.push(lines[i].replace(MD_QUOTE, '')); i++; }
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (MD_LIST.test(l)) {
      const { block, next } = mdParseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    const body = [l.trim()];
    i++;
    while (i < lines.length && !mdBlank(lines[i]) && !mdStartsBlock(lines, i)) { body.push(lines[i].trim()); i++; }
    blocks.push({ type: 'p', text: body.join('\n') });
  }
  return blocks;
}

const MD_INLINE = [
  ['escape', /^\\([!-/:-@[-`{-~])/],
  ['code', /^(`+)([\s\S]*?[^`])\1(?!`)/],
  ['link', /^\[((?:[^\]\\]|\\.)+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/],
  ['url', /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/],
  ['strong', /^\*\*(?!\s)([\s\S]+?)\*\*(?!\*)/],
  ['strong', /^__(?!\s)([\s\S]+?)__(?![A-Za-z0-9])/],
  ['del', /^~~(?!\s)([\s\S]+?)~~/],
  ['em', /^\*(?![\s*])([\s\S]*?[^\s*])\*(?!\*)/],
  ['em', /^_(?![\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9])/],
];

// Text einer Zeile → Liste von Stücken: text, code, strong, em, del, link, br.
function parseInline(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest[0] === '\n') { flush(); out.push({ t: 'br' }); i++; continue; }
    // Unterstrich mitten im Wort (datei_name_neu) ist kein Kursiv.
    const midWord = rest[0] === '_' && /[A-Za-z0-9]/.test(s[i - 1] || '');
    let hit = null;
    if (!midWord && /[\\`[h*_~]/.test(rest[0])) {
      for (const [kind, re] of MD_INLINE) {
        const m = re.exec(rest);
        if (m) { hit = { kind, m }; break; }
      }
    }
    if (!hit) { buf += rest[0]; i++; continue; }
    const { kind, m } = hit;
    if (kind === 'escape') { buf += m[1]; i += m[0].length; continue; }
    flush();
    if (kind === 'code') out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') });
    else if (kind === 'link') out.push({ t: 'link', href: m[2], c: parseInline(m[1]) });
    else if (kind === 'url') out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
    else out.push({ t: kind, c: parseInline(m[1]) });
    i += m[0].length;
  }
  flush();
  return out;
}

const mdSafeHref = (href) => /^(https?:|mailto:)/i.test(href);

function mdInlineNodes(text) {
  const build = (parts) => parts.map((p) => {
    if (p.t === 'text') return document.createTextNode(p.v);
    if (p.t === 'br') return document.createElement('br');
    if (p.t === 'code') return h('code', { text: p.v });
    if (p.t === 'link') {
      // Links öffnen im normalen Browser (die Zentrale leitet neue Fenster nach draußen).
      return mdSafeHref(p.href) ? h('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer', title: p.href }, ...build(p.c))
        : h('span', { class: 'md-ref', title: p.href }, ...build(p.c));
    }
    return h(p.t, {}, ...build(p.c));
  });
  return build(parseInline(text));
}

function mdCodeBlock(b) {
  const copy = h('button', { type: 'button', class: 'md-copy', onClick: async () => {
    try { await navigator.clipboard.writeText(b.text); copy.textContent = 'Kopiert'; } catch { copy.textContent = 'Ging nicht'; }
    setTimeout(() => { copy.textContent = 'Kopieren'; }, 1500);
  } }, 'Kopieren');
  return h('div', { class: 'md-code' },
    h('div', { class: 'md-code-head' }, h('span', { text: b.lang || 'Code' }), copy),
    h('pre', {}, h('code', { text: b.text })));
}

function mdBlockNodes(blocks, tight = false) {
  return blocks.map((b) => {
    if (b.type === 'p') return tight ? h('span', { class: 'md-tight' }, ...mdInlineNodes(b.text)) : h('p', {}, ...mdInlineNodes(b.text));
    if (b.type === 'heading') return h(`h${Math.min(6, b.level + 1)}`, { class: `md-h${b.level}` }, ...mdInlineNodes(b.text));
    if (b.type === 'hr') return h('hr');
    if (b.type === 'code') return mdCodeBlock(b);
    if (b.type === 'quote') return h('blockquote', {}, ...mdBlockNodes(b.children));
    if (b.type === 'list') {
      const props = b.ordered && b.start !== 1 ? { start: String(b.start) } : {};
      return h(b.ordered ? 'ol' : 'ul', props, b.items.map((item) => h('li', {}, ...mdBlockNodes(item, item.length === 1 && item[0].type === 'p'))));
    }
    if (b.type === 'table') {
      const cell = (tag, text, i) => h(tag, b.align[i] ? { style: { textAlign: b.align[i] } } : {}, ...mdInlineNodes(text));
      return h('div', { class: 'md-table' }, h('table', {},
        h('thead', {}, h('tr', {}, b.head.map((c, i) => cell('th', c, i)))),
        h('tbody', {}, b.rows.map((r) => h('tr', {}, b.head.map((_, i) => cell('td', r[i] || '', i)))))));
    }
    return null;
  });
}

function mdRender(text) {
  return h('div', { class: 'md' }, ...mdBlockNodes(parseMarkdown(text)));
}

if (typeof module !== 'undefined') module.exports = { parseMarkdown, parseInline };
