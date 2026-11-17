// Bilder im Chat: nur Bilddateien aus erlaubten Orten, Markdown-Bilder bekommen die richtige Adresse.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bildAus } = require('../src/bild-medien');
const { parseInline, mdImageSrc } = require('../src/renderer/markdown');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.zbild-test-')));
const draussen = fs.realpathSync(fs.mkdtempSync('/private/var/tmp/zbild-'));
const url = (p) => `zbild://datei?p=${encodeURIComponent(p)}`;

test('Bilder: nur Bilddateien im Benutzerordner oder /tmp, keine Verknüpfung nach draußen, nichts anderes', () => {
  const png = path.join(home, 'bild.png'); fs.writeFileSync(png, 'png');
  const txt = path.join(home, 'geheim.txt'); fs.writeFileSync(txt, 'x');
  const fremd = path.join(draussen, 'bild.png'); fs.writeFileSync(fremd, 'png');
  const tmp = path.join(fs.realpathSync('/tmp'), `zbild-${process.pid}.jpg`); fs.writeFileSync(tmp, 'jpg');
  assert.strictEqual(bildAus(url(png), home), png);
  assert.strictEqual(bildAus(url(tmp), home), tmp, 'Zwischenstände in /tmp');
  assert.strictEqual(bildAus(url(txt), home), null, 'keine Textdatei');
  assert.strictEqual(bildAus(url(fremd), home), null, 'nicht außerhalb');
  fs.symlinkSync(fremd, path.join(home, 'link.png'));
  assert.strictEqual(bildAus(url(path.join(home, 'link.png')), home), null, 'Verknüpfung nach draußen');
  fs.symlinkSync(txt, path.join(home, 'tarn.png'));
  assert.strictEqual(bildAus(url(path.join(home, 'tarn.png')), home), null, 'Verknüpfung auf Nicht-Bild');
  assert.strictEqual(bildAus(url(`${home}/../${path.basename(home)}/bild.png`), home), png, '.. wird aufgelöst');
  assert.strictEqual(bildAus('zbild://anders?p=x', home), null);
  assert.strictEqual(bildAus(url('relativ.png'), home), null);
  fs.rmSync(tmp, { force: true });
});

test('Markdown: ![…](…) wird ein Bild – https bleibt, lokale Pfade über zbild://, anderes nicht', () => {
  const p = parseInline('Hier: ![Logo](/Users/eris/logo.png) und ![x](https://a.de/b.png)');
  assert.deepStrictEqual(p.filter((x) => x.t === 'img').map((x) => x.src), ['/Users/eris/logo.png', 'https://a.de/b.png']);
  assert.strictEqual(mdImageSrc('https://a.de/b.png'), 'https://a.de/b.png');
  assert.strictEqual(mdImageSrc('/Users/eris/mein bild.png'), 'zbild://datei?p=%2FUsers%2Feris%2Fmein%20bild.png');
  assert.strictEqual(mdImageSrc('file:///Users/eris/a%20b.png'), 'zbild://datei?p=%2FUsers%2Feris%2Fa%20b.png');
  assert.strictEqual(mdImageSrc('~/Desktop/a.png'), 'zbild://datei?p=~%2FDesktop%2Fa.png');
  assert.strictEqual(mdImageSrc('http://unsicher.de/a.png'), null);
  assert.strictEqual(mdImageSrc('javascript:alert(1)'), null);
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(draussen, { recursive: true, force: true }); });
