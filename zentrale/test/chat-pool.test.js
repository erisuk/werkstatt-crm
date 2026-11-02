const test = require('node:test');
const assert = require('node:assert');
const { ChatPool } = require('../src/chat-pool');

// Ein Chat-Ersatz mit genau dem, was der Pool braucht.
function fakeChat(id, { status = 'ready', saved = true, approvals = 0, lastActive = 0, title = null } = {}) {
  return {
    sessionId: id, cwd: `/Users/x/${id}`, title, status, lastActive, disposed: false,
    pendingApprovals: () => Array.from({ length: approvals }),
    sessionSaved: () => saved,
    dispose() { this.disposed = true; return Promise.resolve(); },
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
});

test('ChatPool: untätige Hintergrund-Chats schließen sich nach der Wartezeit', () => {
  const pool = new ChatPool({ idleMs: 1000 });
  const idle = fakeChat('idle', { lastActive: 0 });
  const busy = fakeChat('busy', { status: 'busy', lastActive: 0 });
  const fresh = fakeChat('fresh', { lastActive: 4500 });
  for (const c of [idle, busy, fresh]) pool.park(c);
  assert.strictEqual(pool.sweep(5000), 1);
  assert.ok(idle.disposed && !busy.disposed && !fresh.disposed);
});

test('ChatPool: Liste für die Agenten-Leiste – sichtbarer zuerst, mit Status und Freigaben', () => {
  const pool = new ChatPool();
  const active = fakeChat('a', { title: 'Logo' });
  pool.park(fakeChat('b', { status: 'busy', approvals: 2 }));
  assert.deepStrictEqual(pool.list(active), [
    { sessionId: 'a', title: 'Logo', name: 'a', status: 'ready', active: true, waiting: 0 },
    { sessionId: 'b', title: 'Neues Gespräch', name: 'b', status: 'busy', active: false, waiting: 2 },
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
