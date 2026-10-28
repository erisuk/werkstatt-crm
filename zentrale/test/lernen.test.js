// Tests für Lernloop (Protokoll, Nachprüfung, Hinweis) und Training (Ideen finden, isolierte Kopie, übernehmen, verwerfen).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// Eigener Test-Benutzerordner: Trainings-Kopien und Lektionen landen nie im echten ~/Zentrale-Training.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-lern-home-')));
process.env.HOME = home;
const learning = require('../src/learning');
const training = require('../src/training');

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-lern-')));

test('Protokoll wird nach den festen Überschriften gelesen, Nachprüfungen erkannt', () => {
  const p = learning.parseProtocol(['# X', '## Was verbessert wurde', 'Ich schaue Videos jetzt an.', '## Was ich noch nicht verstehe', 'Timing', '## Nachprüfung 2026-10-29 – bestanden', 'gut', '## Nachprüfung 2026-11-01 – nicht bestanden'].join('\n'));
  assert.strictEqual(p.improved, 'Ich schaue Videos jetzt an.');
  assert.strictEqual(p.unclear, 'Timing');
  assert.deepStrictEqual(p.reviews, [{ day: '2026-10-29', passed: true }, { day: '2026-11-01', passed: false }]);
});

test('Lernthema: anlegen, heute aktiv, Protokoll → gelernt, Nachprüfung nach 1/3/7 Tagen, dann „sitzt“', () => {
  const dir = tmpDir();
  const st = new learning.LearningStore(path.join(dir, 'l.json'), path.join(dir, 'Lernen'));
  assert.strictEqual(st.add({ topic: '  ' }).ok, false);
  const { lesson } = st.add({ topic: 'Videos erst anschauen', problem: 'Hab aus dem Code geraten' });
  assert.strictEqual(st.activeLesson().id, lesson.id);
  assert.match(learning.systemHint(st.activeLesson()), /Heutiges Lernthema: "Videos erst anschauen"/);
  const prompt = learning.learnPrompt(lesson, st.protocolPath(lesson));
  assert.match(prompt, /## Was ich noch nicht verstehe/);
  assert.match(prompt, /LEKTIONEN\.md/);
  const t0 = Date.UTC(2026, 9, 28);
  fs.mkdirSync(st.protocolDir, { recursive: true });
  fs.writeFileSync(st.protocolPath(lesson), '## Was verbessert wurde\nja\n');
  st.refresh(t0);
  assert.strictEqual(st.lessons[0].status, 'gelernt');
  assert.strictEqual(st.dueReviews(t0 + 0.5 * 86400000).length, 0);
  assert.strictEqual(st.dueReviews(t0 + 1.1 * 86400000).length, 1);
  fs.appendFileSync(st.protocolPath(lesson), '\n## Nachprüfung 2026-10-29 – bestanden\n');
  st.refresh(t0 + 1.1 * 86400000);
  assert.strictEqual(st.nextReview(st.lessons[0]), t0 + 3 * 86400000);
  fs.appendFileSync(st.protocolPath(lesson), '\n## Nachprüfung 2026-10-31 – bestanden\n## Nachprüfung 2026-11-04 – bestanden\n');
  st.refresh(t0 + 8 * 86400000);
  assert.strictEqual(st.lessons[0].status, 'geprüft');
  assert.match(learning.reviewPrompt(lesson, 'x.md'), /Nachprüfung \d{4}-\d{2}-\d{2} – bestanden/);
});

function repo() {
  const dir = tmpDir();
  const g = (...a) => execFileSync('/usr/bin/git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'app.js'), '// TODO: Fehlerbehandlung fehlt\nmodule.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'gross.js'), Array.from({ length: 900 }, (_, i) => `const v${i} = ${i}; // ${'x'.repeat(20)}`).join('\n'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  g('add', '-A'); g('commit', '-qm', 'start');
  return { dir, g };
}

test('Training: Ideen aus dem Projekt, höchstens 3 am Tag, Verworfenes kommt nicht wieder', async () => {
  const { dir } = repo();
  const ideas = await training.scanProject(dir);
  const kinds = ideas.map((i) => i.kind).sort();
  assert.deepStrictEqual(kinds, ['gross', 'readme', 'tests', 'todo']);
  const st = new training.TrainingStore(path.join(tmpDir(), 't.json'));
  assert.strictEqual(st.addIdeas(ideas), 3);
  assert.strictEqual(st.addIdeas(ideas), 1);
  st.drop(st.tasks[0].id);
  assert.strictEqual(st.addIdeas(ideas), 0, 'verworfene Idee kommt nicht wieder');
  assert.strictEqual(st.isDue(new Date()), false, 'heute schon gesucht');
  assert.strictEqual(await training.scanProject(tmpDir()).then((x) => x.length), 0, 'kein Git → keine Aufgaben');
});

test('Training: isolierte Kopie, echtes Projekt unberührt bis „Übernehmen“, „Verwerfen“ räumt auf', async () => {
  const { dir, g } = repo();
  const task = { id: 'abc123', project: 'demo', dir, title: 'README schreiben' };
  const w = await training.createWorktree(task);
  assert.ok(w.ok, w.error);
  Object.assign(task, w);
  fs.writeFileSync(path.join(task.worktree, 'README.md'), '# Demo\n');
  assert.ok(!fs.existsSync(path.join(dir, 'README.md')), 'echtes Projekt unberührt');
  const c = await training.changes(task);
  assert.strictEqual(c.dirty, 1);
  assert.ok((await training.adopt(task)).ok);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'nach Übernehmen im Projekt');
  assert.ok(!fs.existsSync(task.worktree), 'Kopie weg');
  // Verwerfen
  const t2 = { id: 'def456', project: 'demo', dir, title: 'x' };
  Object.assign(t2, await training.createWorktree(t2));
  fs.writeFileSync(path.join(t2.worktree, 'neu.txt'), 'x');
  await training.discard(t2);
  assert.ok(!fs.existsSync(t2.worktree));
  assert.ok(!String(g('branch', '--list')).includes('zentrale-training/def456'));
  assert.ok(!fs.existsSync(path.join(dir, 'neu.txt')));
  assert.match(training.trainPrompt(task), /isolierte Kopie/);
  assert.ok(training.ROOT().startsWith(home));
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
