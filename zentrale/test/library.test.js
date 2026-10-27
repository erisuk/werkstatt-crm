// Tests für Themen, Bibliothek (Skills, Agenten, Plugins), Ordneransicht und Claude-App-Daten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { categorize, emojiCategory, groupByTopic, TopicStore } = require('../src/categories');
const { listSkills, listCommands, listPlugins, listAgents, setAgentActive, runningWork, frontmatter } = require('../src/library');
const { listDir, isProtected, listApps } = require('../src/files');
const { desktopMeta } = require('../src/desktop-meta');
const { continuationTitle } = require('../src/sessions');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `zentrale-${p}`));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// ---------- Themen ----------

test('Themen: Emoji-Schema aus der Claude-App gewinnt', () => {
  assert.strictEqual(emojiCategory('📈 Trading – Bot — Teil 3 (04.09.)'), 'trading');
  assert.strictEqual(emojiCategory('⚙️ Agenten – agenticOS'), 'agenten');
  assert.strictEqual(emojiCategory('⚙ Agenten ohne Variantenzeichen'), 'agenten');
  assert.strictEqual(categorize({ title: '🛒 Shop – Video-Werbung für TikTok' }), 'shop');
});

test('Themen: Stichwörter in Titel und erster Nachricht', () => {
  assert.strictEqual(categorize({ title: 'Bester Daytrading Bot' }), 'trading');
  assert.strictEqual(categorize({ title: 'TikTok Shop-Builder Account Analysis' }), 'shop');
  assert.strictEqual(categorize({ title: 'Kurzfilme über andere Firmen' }), 'media');
  assert.strictEqual(categorize({ title: 'ESA-Dienstleistung Rechnung 85 Stunden' }), 'garten');
  assert.strictEqual(categorize({ title: 'Neues Projekt', snippet: 'Bau mir eine Roblox-Map' }), 'game');
  assert.strictEqual(categorize({ title: 'Flüge nach Ohrid' }), 'div');
});

test('Themen: geplante Läufe und Testaufträge landen in der Automatik, Fortsetzungen nicht', () => {
  assert.strictEqual(categorize({ title: 'Venture dispatcher' }, 117), 'auto');
  assert.strictEqual(categorize({ title: 'Morgen briefing', scheduled: true }), 'auto');
  assert.strictEqual(categorize({ title: 'Antworte nur mit OK' }), 'auto');
  assert.strictEqual(categorize({ title: 'Run exactly this bash command once' }), 'auto');
  assert.strictEqual(categorize({ title: '↪ Trading-Bot ~/trading-agent/mt5-bridge' }, 20), 'trading');
});

test('Themen: selbst gewählte Themen werden gespeichert und gewinnen', () => {
  const file = path.join(tmp('topics-'), 'topics.json');
  const store = new TopicStore(file);
  store.set(['a'], 'game');
  store.set(['b'], 'gibt-es-nicht');
  const again = new TopicStore(file);
  assert.strictEqual(again.get('a'), 'game');
  assert.strictEqual(again.get('b'), null);
  const groups = groupByTopic([{ sessions: [{ id: 'a', title: 'Bester Daytrading Bot', updatedAt: 1 }] }], again);
  const game = groups.find((g) => g.id === 'game');
  assert.strictEqual(game.sessions[0].topicManual, true);
  again.forget(['a']);
  assert.strictEqual(new TopicStore(file).get('a'), null);
});

test('Fortsetzungs-Chats bekommen den Namen aus der Übergabe', () => {
  assert.strictEqual(continuationTitle('Wir setzen eine Arbeit fort. Hier die Übergabe:\n\n---\n\n## Übergabe: Trading-Bot `~/trading-agent`\n\nText'),
    '↪ Trading-Bot ~/trading-agent');
  assert.strictEqual(continuationTitle('Ganz normale Frage'), null);
});

// ---------- Bibliothek ----------

function fakeClaudeDir() {
  const root = tmp('claude-');
  write(path.join(root, 'skills', 'watch', 'SKILL.md'), '---\nname: watch\ndescription: Video anschauen\n---\nText');
  write(path.join(root, 'skills', 'ecc', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: "Tests zuerst"\n---\n');
  write(path.join(root, 'commands', 'commit.md'), '---\ndescription: Commit schreiben\n---\n');
  write(path.join(root, 'commands', 'git', 'pr.md'), 'ohne Kopf');
  write(path.join(root, 'agents', 'planner.md'), '---\nname: planner\ndescription: Plant\nmodel: opus\n---\n');
  write(path.join(root, 'agents-archiv', 'old.md'), '---\nname: old\ndescription: Alt\n---\n');
  const plugin = path.join(root, 'plugins', 'synced', 'konto', 'marketing~g2');
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'marketing', version: '1.2.0', description: 'Kampagnen' }));
  write(path.join(plugin, 'skills', 'seo', 'SKILL.md'), '---\nname: seo\ndescription: SEO\n---\n');
  write(path.join(plugin, 'agents', 'writer.md'), '---\nname: writer\n---\n');
  return root;
}

test('frontmatter liest einfache Kopfzeilen', () => {
  assert.deepStrictEqual(frontmatter('---\nname: x\ndescription: "a: b"\n---\nrest'), { name: 'x', description: 'a: b' });
  assert.deepStrictEqual(frontmatter('kein Kopf'), {});
});

test('Bibliothek: Skills, Befehle, Plugins und Agenten', () => {
  const root = fakeClaudeDir();
  const skills = listSkills(root);
  assert.deepStrictEqual(skills.map((s) => `${s.name}:${s.source}`), ['seo:Plugin marketing', 'tdd:ECC', 'watch:Eigene']);
  assert.deepStrictEqual(listCommands(root).map((c) => c.name), ['/commit', '/git:pr']);
  const [plugin] = listPlugins(root);
  assert.strictEqual(plugin.name, 'marketing');
  assert.strictEqual(plugin.skills, 1);
  assert.strictEqual(plugin.agents, 1);
  const agents = listAgents(root);
  assert.deepStrictEqual(agents.map((a) => `${a.name}:${a.active}`), ['planner:true', 'writer:true', 'old:false']);
  assert.strictEqual(agents[0].model, 'opus');
});

test('Agenten an- und ausschalten verschiebt nur die eigene Datei', () => {
  const root = fakeClaudeDir();
  assert.deepStrictEqual(setAgentActive('planner.md', false, root), { ok: true });
  assert.ok(fs.existsSync(path.join(root, 'agents-archiv', 'planner.md')));
  assert.deepStrictEqual(setAgentActive('old.md', true, root), { ok: true });
  assert.ok(fs.existsSync(path.join(root, 'agents', 'old.md')));
  for (const bad of ['../settings.json', 'x/../../y.md', '.versteckt.md', 'kein-md', null]) {
    assert.strictEqual(setAgentActive(bad, true, root).ok, false, String(bad));
  }
  assert.strictEqual(setAgentActive('gibts-nicht.md', true, root).ok, false);
});

test('Läuft gerade: frische Gespräche und Unteragenten', () => {
  const root = tmp('claude-');
  const proj = path.join(root, 'projects', '-Users-x');
  write(path.join(proj, 'neu.jsonl'), '{}');
  write(path.join(proj, 'alt.jsonl'), '{}');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(path.join(proj, 'alt.jsonl'), old, old);
  write(path.join(proj, 'neu', 'subagents', 'agent-1.jsonl'), '{}');
  write(path.join(proj, 'neu', 'subagents', 'agent-1.meta.json'), JSON.stringify({ agentType: 'seo-agent', description: 'SEO prüfen' }));
  const r = runningWork((id) => `Titel ${id}`, root);
  assert.deepStrictEqual(r.sessions.map((s) => s.id), ['neu']);
  assert.strictEqual(r.agents[0].type, 'seo-agent');
  assert.strictEqual(r.agents[0].session, 'Titel neu');
});

// ---------- Ordner und Apps ----------

test('Ordner: Ordner zuerst, Versteckte nur auf Wunsch, Fehler verständlich', () => {
  const dir = tmp('dir-');
  write(path.join(dir, 'b.txt'), 'x');
  write(path.join(dir, '.geheim'), 'x');
  fs.mkdirSync(path.join(dir, 'a-ordner'));
  fs.mkdirSync(path.join(dir, 'Test.app'));
  const res = listDir(dir);
  assert.deepStrictEqual(res.items.map((i) => `${i.name}:${i.dir}`), ['a-ordner:true', 'b.txt:false', 'Test.app:false']);
  assert.strictEqual(res.items[2].app, true);
  assert.strictEqual(listDir(dir, { hidden: true }).items.length, 4);
  assert.strictEqual(listDir(path.join(dir, 'fehlt')).ok, false);
  assert.strictEqual(listDir('relativ').ok, false);
});

test('Geschützte Ordner können nicht in den Papierkorb', () => {
  const home = os.homedir();
  for (const p of ['/', '/Users', home, path.join(home, 'Desktop'), path.join(home, 'Library'), path.join(home, '.claude'), '/Applications']) {
    assert.strictEqual(isProtected(p), true, p);
  }
  assert.strictEqual(isProtected(path.join(home, 'Desktop', 'altes-projekt')), false);
});

test('Apps werden aus allen Programme-Ordnern gesammelt, doppelte nur einmal', () => {
  const a = tmp('apps-');
  const b = tmp('apps-');
  fs.mkdirSync(path.join(a, 'Safari.app'));
  fs.mkdirSync(path.join(b, 'Safari.app'));
  fs.mkdirSync(path.join(b, 'Notizen.app'));
  write(path.join(b, 'liesmich.txt'), 'x');
  assert.deepStrictEqual(listApps([a, b]).map((x) => x.name), ['Notizen', 'Safari']);
});

test('Claude-App-Daten: Titel, Archiv und geplante Läufe je Gespräch', () => {
  const root = tmp('desktop-');
  write(path.join(root, 'konto', 'x', 'local_1.json'), JSON.stringify({ cliSessionId: 's1', title: 'Shop-Projekt', isArchived: true }));
  write(path.join(root, 'konto', 'local_2.json'), JSON.stringify({ cliSessionId: 's2', title: 'Morgen', scheduledTaskId: 'morgen' }));
  write(path.join(root, 'konto', 'local_3.json'), 'kaputt');
  const m = desktopMeta(root);
  assert.deepStrictEqual(m.get('s1'), { id: 's1', title: 'Shop-Projekt', archived: true, scheduled: false });
  assert.strictEqual(m.get('s2').scheduled, true);
  assert.strictEqual(m.size, 2);
});
