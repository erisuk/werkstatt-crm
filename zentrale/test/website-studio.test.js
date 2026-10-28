// Tests für die Website-Werkstatt: abwechselnde Designrichtungen, Ordner anlegen, Briefing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-web-home-')));
process.env.HOME = home;
const { WebsiteStudio, DIRECTIONS, pickDirection, slugify } = require('../src/website-studio');

test('Namen werden zu Ordnernamen', () => {
  assert.strictEqual(slugify('ESA Gebäudereinigung & Söhne'), 'esa-gebaudereinigung-sohne');
  assert.strictEqual(slugify('Straße'), 'strasse');
  assert.strictEqual(slugify('../../etc'), 'etc');
  assert.strictEqual(slugify('!!!'), '');
});

test('Richtungen: erst alle unbenutzten, nie zweimal dieselbe hintereinander', () => {
  const used = DIRECTIONS.slice(0, DIRECTIONS.length - 1).map((d) => d.id);
  assert.strictEqual(pickDirection(used).id, DIRECTIONS[DIRECTIONS.length - 1].id);
  const all = DIRECTIONS.map((d) => d.id);
  for (let i = 0; i < 50; i += 1) assert.notStrictEqual(pickDirection(all, 'swiss').id, 'swiss');
  for (let i = 0; i < 50; i += 1) assert.notStrictEqual(pickDirection(all).id, all[all.length - 1]);
});

test('Neue Website: Ordner mit Briefing, Richtung gemerkt, gleicher Name geht nicht zweimal', () => {
  const file = path.join(home, 'daten', 'websites.json');
  const s = new WebsiteStudio(file);
  const r = s.create({ name: 'Bäckerei Uka', purpose: 'Brötchen vorbestellen', audience: 'Nachbarn', goal: 'anrufen', direction: 'organic' });
  assert.ok(r.ok);
  assert.strictEqual(r.dir, path.join(home, 'Websites', 'backerei-uka'));
  const brief = fs.readFileSync(path.join(r.dir, 'BRIEF.md'), 'utf8');
  assert.match(brief, /# Bäckerei Uka/);
  assert.match(brief, /Designrichtung: Organisch \/ Natur/);
  assert.match(r.prompt, /BRIEF\.md/);
  assert.ok(s.isSite(r.dir));
  assert.strictEqual(s.create({ name: 'Bäckerei Uka' }).ok, false);
  assert.strictEqual(s.create({ name: '' }).ok, false);
  const again = new WebsiteStudio(file);
  assert.deepStrictEqual(again.list().used, ['organic']);
  assert.strictEqual(again.list().sites[0].direction.id, 'organic');
  assert.notStrictEqual(again.suggest(null).id, 'organic');
  again.forget(again.list().sites[0].id);
  assert.strictEqual(new WebsiteStudio(file).list().sites.length, 0);
  assert.ok(fs.existsSync(r.dir), 'Ordner bleibt');
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
