const test = require('node:test');
const assert = require('node:assert');
const { parseMarkdown, parseInline } = require('../src/renderer/markdown');
const { toolStep } = require('../src/tool-steps');

test('Markdown: Überschriften, Absätze, Trennlinie und Code-Block', () => {
  const b = parseMarkdown('# Titel\n\nErste Zeile\nzweite Zeile\n\n---\n\n```js\nconst a = 1;\n\nlet b;\n```\nDanach');
  assert.deepStrictEqual(b.map((x) => x.type), ['heading', 'p', 'hr', 'code', 'p']);
  assert.strictEqual(b[0].level, 1);
  assert.strictEqual(b[1].text, 'Erste Zeile\nzweite Zeile');
  assert.deepStrictEqual(b[3], { type: 'code', lang: 'js', text: 'const a = 1;\n\nlet b;' });
});

test('Markdown: Code ohne schließenden Zaun endet am Textende (laufende Antwort)', () => {
  const b = parseMarkdown('```\nnoch offen');
  assert.deepStrictEqual(b, [{ type: 'code', lang: '', text: 'noch offen' }]);
});

test('Markdown: Listen mit Verschachtelung, Nummern und Leerzeilen', () => {
  const b = parseMarkdown('1. Eins\n2. Zwei\n   - a\n   - b\n\n3. Drei\n\n- x\n- y');
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].ordered, true);
  assert.strictEqual(b[0].items.length, 3);
  assert.deepStrictEqual(b[0].items[1].map((x) => x.type), ['p', 'list']);
  assert.strictEqual(b[0].items[1][1].items.length, 2);
  assert.strictEqual(b[1].ordered, false);
  assert.strictEqual(b[1].items.length, 2);
});

test('Markdown: Tabelle mit Ausrichtung und Zitat', () => {
  const b = parseMarkdown('| Name | Wert |\n|:-----|-----:|\n| a | 1 |\n| b \\| c | 2 |\n\n> Hinweis\n> **wichtig**');
  assert.strictEqual(b[0].type, 'table');
  assert.deepStrictEqual(b[0].head, ['Name', 'Wert']);
  assert.deepStrictEqual(b[0].align, [null, 'right']);
  assert.deepStrictEqual(b[0].rows, [['a', '1'], ['b | c', '2']]);
  assert.strictEqual(b[1].type, 'quote');
  assert.strictEqual(b[1].children[0].text, 'Hinweis\n**wichtig**');
});

test('Inline: fett, kursiv, Code, Links, Zeilenumbruch', () => {
  const p = parseInline('Das ist **fett** und *kursiv*, `code *nicht kursiv*`, [Seite](https://a.de) und https://b.de/x.\nNeu');
  assert.deepStrictEqual(p.map((x) => x.t), ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'link', 'text', 'link', 'text', 'br', 'text']);
  assert.strictEqual(p[5].v, 'code *nicht kursiv*');
  assert.strictEqual(p[7].href, 'https://a.de');
  assert.strictEqual(p[9].href, 'https://b.de/x'); // Punkt am Satzende gehört nicht zur Adresse
});

test('Inline: Unterstriche in Wörtern und einzelne Sternchen bleiben Text', () => {
  assert.deepStrictEqual(parseInline('datei_name_neu.js'), [{ t: 'text', v: 'datei_name_neu.js' }]);
  assert.deepStrictEqual(parseInline('2 * 3 = 6'), [{ t: 'text', v: '2 * 3 = 6' }]);
  assert.deepStrictEqual(parseInline('\\*kein\\*'), [{ t: 'text', v: '*kein*' }]);
});

test('Inline: HTML aus einer Antwort bleibt reiner Text', () => {
  assert.deepStrictEqual(parseInline('<img src=x onerror=alert(1)>'), [{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
});

test('Arbeitsschritte: kurze Angaben pro Werkzeug', () => {
  assert.deepStrictEqual(toolStep('Bash', { command: 'npm test\nmehr', description: 'Tests laufen lassen' }), { tool: 'Bash', detail: 'Tests laufen lassen' });
  assert.deepStrictEqual(toolStep('Edit', { file_path: '/Users/x/projekt/src/app.js' }), { tool: 'Edit', detail: 'app.js' });
  assert.deepStrictEqual(toolStep('WebFetch', { url: 'https://docs.example.com/a?b' }), { tool: 'WebFetch', detail: 'docs.example.com' });
  assert.deepStrictEqual(toolStep('Grep', { pattern: 'TODO' }), { tool: 'Grep', detail: 'TODO' });
  assert.strictEqual(toolStep(null, null).tool, 'Werkzeug');
});

test('Markdown: Tabelle mit kurzer Trennzeile (|:-:|) und Überschrift „C#“', () => {
  const b = parseMarkdown('| a | b | c |\n|:-|-:|:-:|\n| 1 | 2 | 3 |\n\n# C#\n\n## Titel ##');
  assert.strictEqual(b[0].type, 'table');
  assert.deepStrictEqual(b[0].align, [null, 'right', 'center']);
  assert.deepStrictEqual(b[1], { type: 'heading', level: 1, text: 'C#' });
  assert.deepStrictEqual(b[2], { type: 'heading', level: 2, text: 'Titel' });
});

test('Inline: Adressen mit Klammern, <Adresse> und Bild-Link', () => {
  const p = parseInline('[Wiki](https://de.wikipedia.org/wiki/Ulm_(Stadt)) und https://de.wikipedia.org/wiki/Ulm_(Stadt).');
  assert.deepStrictEqual(p.map((x) => x.t), ['link', 'text', 'link', 'text']);
  assert.strictEqual(p[0].href, 'https://de.wikipedia.org/wiki/Ulm_(Stadt)');
  assert.strictEqual(p[2].href, 'https://de.wikipedia.org/wiki/Ulm_(Stadt)');
  assert.strictEqual(p[3].v, '.');
  const q = parseInline('(siehe https://a.de/x) und <https://b.de> ![Bild](https://c.de/a.png)');
  assert.deepStrictEqual(q.map((x) => x.href || x.v), ['(siehe ', 'https://a.de/x', ') und ', 'https://b.de', ' ', 'https://c.de/a.png']);
  assert.deepStrictEqual(parseInline('Maß_a_b'), [{ t: 'text', v: 'Maß_a_b' }]);
});
