const test = require('node:test');
const assert = require('node:assert');
const { ChatPool } = require('../src/chat-pool');

// Ein Chat-Ersatz mit genau dem, was der Pool braucht.
function fakeChat(id, { status = 'ready', saved = true, approvals = 0, lastActive = 0, title = null, alive = true } = {}) {
  return {
    sessionId: id, cwd: `/Users/x/${id}`, title, status, lastActive, disposed: false, alive,
    pendingApprovals: () => Array.from({ length: approvals }),
    sessionSaved: () => saved,
    stop() { this.alive = false; this.status = 'stopped'; return Promise.resolve(); },
    dispose() { this.disposed = true; this.alive = false; return Promise.resolve(); },
  };
}

test('ChatPool: ein Chat mit Nachrichten parkt im Hintergrund, ein leerer wird beendet', () => {
  const pool = new ChatPool();
  const used = fakeChat('a');
  const empty = fakeChat('b', { saved: false });
  pool.park(used);
  pool.park(empty);
  assert.strictEqual(pool.get('a'), used);
  assert.strictEqual(pool.get('b'), null);
  assert.ok(empty.disposed && !used.disposed);
});

test('ChatPool: ein arbeitender Chat parkt auch ohne gespeicherte Datei – seine Arbeit läuft weiter', () => {
  const pool = new ChatPool();
  const c = fakeChat('a', { saved: false, status: 'busy' });
  pool.park(c);
  assert.strictEqual(pool.get('a'), c);
  assert.ok(!c.disposed);
});

test('ChatPool: nach vorn holen nimmt den Chat aus dem Hintergrund, ohne ihn zu beenden', () => {
  const pool = new ChatPool();
  const c = fakeChat('a');
  pool.park(c);
  assert.strictEqual(pool.take('a'), c);
  assert.strictEqual(pool.get('a'), null);
  assert.ok(!c.disposed);
});

test('ChatPool: bei zu vielen schließt sich der am längsten untätige, arbeitende bleiben', () => {
  const pool = new ChatPool({ max: 3 });
  const old = fakeChat('alt', { lastActive: 1 });
  const busy = fakeChat('busy', { status: 'busy', lastActive: 0 });
  const newer = fakeChat('neu', { lastActive: 5 });
  for (const c of [old, busy, newer]) pool.park(c);
  Object.assign(old, { lastActive: 1 }); Object.assign(busy, { lastActive: 0 }); Object.assign(newer, { lastActive: 5 });
  pool.trim();
  assert.ok(old.disposed, 'ältester untätiger geschlossen');
  assert.ok(!busy.disposed && !newer.disposed);
  assert.strictEqual(pool.parked.size, 2);
});

test('ChatPool: Platz für einen neuen Chat nur, wenn einer weichen kann', () => {
  const pool = new ChatPool({ max: 3 });
  const active = fakeChat('aktiv', { status: 'busy' });
  assert.strictEqual(pool.hasRoom(active), true);
  pool.park(fakeChat('b', { status: 'busy' }));
  pool.park(fakeChat('c', { status: 'busy' }));
  assert.strictEqual(pool.hasRoom(active), false, 'drei arbeiten → kein Platz');
  pool.get('c').status = 'ready';
  assert.strictEqual(pool.hasRoom(active), true, 'einer ist fertig → er kann weichen');
  pool.get('c').pendingApprovals = () => [1];
  assert.strictEqual(pool.hasRoom(active), false, 'wartet auf Freigabe → bleibt');
  assert.strictEqual(pool.hasRoom(fakeChat('leer', { saved: false })), true, 'ein leerer sichtbarer Chat zählt nicht');
  assert.strictEqual(pool.hasRoom(fakeChat('erste', { saved: false, status: 'busy' })), false, 'arbeitet schon, Datei noch nicht da → zählt mit');
});

test('ChatPool: untätige Hintergrund-Chats schlafen nach der Wartezeit ein und bleiben in der Liste', () => {
  const pool = new ChatPool({ idleMs: 1000 });
  const idle = fakeChat('idle', { lastActive: 0 });
  const busy = fakeChat('busy', { status: 'busy', lastActive: 0 });
  const fresh = fakeChat('fresh', { lastActive: 4500 });
  for (const c of [idle, busy, fresh]) pool.park(c);
  Object.assign(idle, { lastActive: 0 }); Object.assign(busy, { lastActive: 0 }); Object.assign(fresh, { lastActive: 4500 });
  assert.strictEqual(pool.sweep(5000), 1);
  assert.ok(!idle.alive && busy.alive && fresh.alive);
  assert.ok(!idle.disposed, 'schläft nur – nicht geschlossen');
  assert.strictEqual(pool.get('idle'), idle);
  assert.strictEqual(pool.list(null).find((c) => c.sessionId === 'idle').asleep, true);
  assert.strictEqual(pool.sweep(5200), 0, 'schlafende nicht noch einmal');
});

test('ChatPool: höchstens 5 wach – zum Aufwecken schläft der am längsten untätige ein, der sichtbare zuletzt', () => {
  const pool = new ChatPool({ awakeMax: 3 });
  const active = fakeChat('aktiv', { lastActive: 0 });
  const a = fakeChat('a'); const b = fakeChat('b'); const sleepy = fakeChat('zzz', { alive: false });
  for (const c of [a, b, sleepy]) pool.park(c);
  Object.assign(a, { lastActive: 5 }); Object.assign(b, { lastActive: 9 });
  assert.strictEqual(pool.awakeCount(active), 3);
  assert.strictEqual(pool.wake(active, sleepy), true);
  assert.ok(!a.alive && b.alive && active.alive, 'ältester Hintergrund-Chat schläft, nicht der sichtbare');
  b.status = 'busy'; sleepy.alive = true; sleepy.status = 'busy'; a.alive = false;
  const neu = fakeChat('neu', { alive: false });
  assert.strictEqual(pool.wake(active, neu), true, 'dann eben der sichtbare, wenn er untätig ist');
  assert.ok(!active.alive);
  active.alive = true; active.status = 'busy';
  assert.strictEqual(pool.wake(active, neu), false, 'alle wachen arbeiten → kein Platz');
  assert.match(pool.fullMessage(), /3 Chats gleichzeitig/);
});

test('ChatPool: gemerkt für den Neustart werden nur Chats mit gespeichertem Gespräch', () => {
  const pool = new ChatPool();
  pool.park(fakeChat('a', { title: 'Logo' }));
  pool.park(fakeChat('b', { saved: false, status: 'busy' }));
  assert.deepStrictEqual(pool.saved(fakeChat('aktiv')), [
    { sessionId: 'aktiv', cwd: '/Users/x/aktiv', title: null }, { sessionId: 'a', cwd: '/Users/x/a', title: 'Logo' }]);
});

test('ChatPool: Liste für die Agenten-Leiste – sichtbarer zuerst, mit Status und Freigaben', () => {
  const pool = new ChatPool();
  const active = fakeChat('a', { title: 'Logo' });
  pool.park(fakeChat('b', { status: 'busy', approvals: 2 }));
  assert.deepStrictEqual(pool.list(active), [
    { sessionId: 'a', title: 'Logo', name: 'a', status: 'ready', active: true, waiting: 0, asleep: false },
    { sessionId: 'b', title: 'Neues Gespräch', name: 'b', status: 'busy', active: false, waiting: 2, asleep: false },
  ]);
});

test('Umbenennen: schreibt den Namen im Claude-Code-Format, leere oder zu lange Namen nicht', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { renameSession, parseSession } = require('../src/sessions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbenennen-'));
  const file = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: dir, message: { role: 'user', content: 'Mach mir ein Logo für den Imbiss' } })}\n`);
  assert.strictEqual(parseSession(file).renamed, false);
  assert.strictEqual(renameSession(file, 'abc', '  Imbiss   Logo  '), 'Imbiss Logo');
  const s = parseSession(file);
  assert.strictEqual(s.title, 'Imbiss Logo');
  assert.strictEqual(s.renamed, true);
  assert.strictEqual(renameSession(file, 'abc', '   '), null);
  assert.strictEqual(renameSession(file, 'abc', 'x'.repeat(121)), null);
  assert.strictEqual(parseSession(file).title, 'Imbiss Logo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ChatPool: Parken zählt als gerade benutzt, Schließen liefert das Beenden zum Abwarten', async () => {
  const pool = new ChatPool({ idleMs: 1000 });
  const c = fakeChat('a', { lastActive: 0 });
  pool.park(c);
  assert.ok(Date.now() - c.lastActive < 1000);
  assert.strictEqual(pool.sweep(), 0);
  await pool.close(c);
  assert.ok(c.disposed);
  assert.strictEqual(pool.get('a'), null);
});
