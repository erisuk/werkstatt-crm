// Tests für die Browser-Steuerung: Werkzeuge, Freigabe-Texte, Warnungen und gesperrte Felder.
const test = require('node:test');
const assert = require('node:assert');
const { READ_ONLY_TOOLS } = require('../src/mcp/browser-server');
const { describeApproval } = require('../src/claude');
const { RISKY_LABEL, describeElement } = require('../src/browser-control');

test('Browser-Werkzeuge: Lesen, Ansehen, Scrollen ohne Rückfrage – alles andere mit Freigabe', () => {
  assert.deepStrictEqual([...READ_ONLY_TOOLS].sort(), ['zentrale_web_read', 'zentrale_web_screenshot', 'zentrale_web_scroll', 'zentrale_web_tabs']);
});

test('Browser-Freigaben: klarer Titel, Text sichtbar, nie „Immer erlauben“', () => {
  const t = describeApproval('mcp__web__zentrale_web_type', { ref: 4, text: 'Herbst-Kampagne', submit: true });
  assert.strictEqual(t.title, 'Im Web-Tab etwas eintippen');
  assert.match(t.detail, /Text: Herbst-Kampagne {2}\(danach Enter\)/);
  assert.strictEqual(t.canAlways, false);
  for (const name of ['zentrale_web_click', 'zentrale_web_open', 'zentrale_web_key']) {
    assert.strictEqual(describeApproval(`mcp__web__${name}`, { ref: 1, url: 'https://x.de', key: 'enter' }).canAlways, false, name);
  }
  assert.match(describeApproval('mcp__web__zentrale_web_open', { url: 'https://business.facebook.com/' }).detail, /Adresse: https:\/\/business\.facebook\.com\//);
});

test('Warnung bei Knöpfen, die Geld kosten, veröffentlichen, senden oder löschen', () => {
  for (const label of ['Kampagne veröffentlichen', 'Jetzt bezahlen', 'Bestellung abschließen', 'Publish', 'Budget festlegen', 'Senden', 'Anzeige löschen', 'Beitrag bewerben', 'Boost post']) {
    assert.ok(RISKY_LABEL.test(label), label);
  }
  for (const label of ['Weiter', 'Zurück', 'Zielgruppe bearbeiten', 'Vorschau']) assert.ok(!RISKY_LABEL.test(label), label);
  assert.strictEqual(describeElement({ label: 'Weiter', kind: 'button' }), '„Weiter“ [button]');
  assert.match(describeElement(null), /Seite neu lesen/);
});

test('Upload: nur Dateien aus dem Benutzerordner, keine versteckten Ordner, Freigabe zeigt jede Datei', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { checkUploadFiles } = require('../src/browser-control');
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.zentrale-upload-test-'));
  try {
    const visible = path.join(os.homedir(), `zentrale-upload-${process.pid}.mp4`);
    fs.writeFileSync(visible, 'video');
    try {
      assert.deepStrictEqual(checkUploadFiles([visible]).files, [fs.realpathSync(visible)]);
      assert.strictEqual(checkUploadFiles([`~/zentrale-upload-${process.pid}.mp4`]).ok, true);
    } finally { fs.unlinkSync(visible); }
    fs.writeFileSync(path.join(dir, 'x.mp4'), 'x');
    assert.match(checkUploadFiles([path.join(dir, 'x.mp4')]).error, /Aus diesem Ordner/);
    assert.match(checkUploadFiles(['/etc/hosts']).error, /Benutzerordner/);
    assert.match(checkUploadFiles(['~/gibt-es-nicht.mp4']).error, /nicht gefunden/);
    assert.strictEqual(checkUploadFiles([]).ok, false);
    assert.strictEqual(checkUploadFiles(Array(11).fill('/etc/hosts')).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const a = describeApproval('mcp__web__zentrale_web_upload', { ref: 7, files: ['/Users/x/Videos/bit-folge-12.mp4'] });
  assert.strictEqual(a.title, 'Dateien im Web-Tab hochladen');
  assert.match(a.detail, /• \/Users\/x\/Videos\/bit-folge-12\.mp4/);
  assert.strictEqual(a.canAlways, false);
});
