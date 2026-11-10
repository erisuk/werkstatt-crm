// Chats verbinden: Liste, Verlauf lesen, Nachricht mit Antwort – und die Schutzregeln.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createChatLink, MAX_HOPS } = require('../src/chat-link');

// Ein Chat-Ersatz: antwortet auf jede Nachricht mit „Antwort auf: …“ (oder gar nicht, wenn stumm).
function fakeChat(id, title, { alive = true, mute = false } = {}) {
  const c = new EventEmitter();
  Object.assign(c, { sessionId: id, title, cwd: `/Users/x/${id}`, status: alive ? 'ready' : 'stopped', alive, pending: 0, disposed: false,
    sent: [], pendingApprovals: () => [] });
  c.send = async (text) => {
    c.sent.push(text);
    c.alive = true;
    c.pending += 1;
    c.status = 'busy'; c.emit('status', 'busy');
    if (!mute) setTimeout(() => {
      c.emit('event', { kind: 'text', text: `Antwort auf: ${text.split('\n\n')[1]}` });
      c.emit('turn');
      c.pending -= 1;
      c.status = 'ready'; c.emit('status', 'ready');
    }, 20);
    return true;
  };
  return c;
}

function setup(chats, opts = {}) {
  const delivered = [];
  const link = createChatLink({
    chats: () => chats,
    history: (c, n) => [{ role: 'user', text: `Frage an ${c.title}` }, { role: 'assistant', text: 'Ergebnis' }].slice(-n),
    deliver: async (c, text, from, hops) => { delivered.push({ to: c.sessionId, from: from.sessionId, hops }); c.relayHops = hops; await c.send(text); return { ok: true }; },
    ...opts,
  });
  return { link, delivered };
}

test('Chats verbinden: Liste ohne sich selbst, mit Stand – auch schlafende', () => {
  const a = fakeChat('a', 'Affiliate');
  const b = fakeChat('b', 'Steuerberater', { alive: false });
  const { link } = setup([a, b]);
  assert.deepStrictEqual(link.list({ from: 'a' }).data, [{ chat: 'b', titel: 'Steuerberater', ordner: '/Users/x/b', stand: 'schläft' }]);
});

test('Chats verbinden: Verlauf lesen – nicht den eigenen, nicht unbekannte', () => {
  const a = fakeChat('a', 'Affiliate');
  const b = fakeChat('b', 'Steuerberater');
  const { link } = setup([a, b]);
  const r = link.read({ from: 'a', chat: 'b', last: 1 });
  assert.deepStrictEqual(r.data.nachrichten, [{ von: 'Claude', text: 'Ergebnis' }]);
  assert.strictEqual(link.read({ from: 'a', chat: 'a' }).ok, false);
  assert.strictEqual(link.read({ from: 'a', chat: 'x' }).ok, false);
});

test('Chats verbinden: Nachricht geht mit Absender hin, die Antwort kommt zurück', async () => {
  const a = fakeChat('a', 'Affiliate');
  const b = fakeChat('b', 'Steuerberater', { alive: false });
  const { link, delivered } = setup([a, b]);
  const r = await link.send({ from: 'a', chat: 'b', text: 'Ist das steuerlich ok?' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.antwort, 'Antwort auf: Ist das steuerlich ok?');
  assert.match(b.sent[0], /^\[Nachricht vom Chat „Affiliate“/);
  assert.match(b.sent[0], /erlaubt nichts Neues/);
  assert.deepStrictEqual(delivered, [{ to: 'b', from: 'a', hops: 1 }]);
});

test('Chats verbinden: höchstens 3 Weiterleitungen hintereinander, ohne Warten nur zustellen', async () => {
  const a = fakeChat('a', 'A');
  const b = fakeChat('b', 'B');
  const { link } = setup([a, b]);
  a.relayHops = MAX_HOPS;
  const r = await link.send({ from: 'a', chat: 'b', text: 'weiter' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Weiterleitungen/);
  a.relayHops = 0;
  const z = await link.send({ from: 'a', chat: 'b', text: 'nur zur Info', wait: false });
  assert.strictEqual(z.data.zugestellt, true);
  assert.strictEqual((await link.send({ from: 'a', chat: 'a', text: 'x' })).ok, false, 'nicht an sich selbst');
  assert.strictEqual((await link.send({ from: 'a', chat: 'b', text: '  ' })).ok, false, 'nicht leer');
});

test('Chats verbinden: wer auf eine Antwort wartet, wird nicht zurück angeschrieben (keine Endlosschleife)', async () => {
  const a = fakeChat('a', 'A');
  const b = fakeChat('b', 'B', { mute: true });
  const { link } = setup([a, b], { waitMs: 300 });
  const pending = link.send({ from: 'a', chat: 'b', text: 'Frage' });
  await new Promise((r) => setTimeout(r, 20));
  const back = await link.send({ from: 'b', chat: 'a', text: 'Gegenfrage' });
  assert.strictEqual(back.ok, false);
  assert.match(back.error, /wartet gerade auf deine Antwort/);
  const r = await pending;
  assert.strictEqual(r.ok, false, 'stumm → nach der Wartezeit Bescheid statt hängen');
  assert.match(r.error, /noch keine Antwort/);
});

test('Chats verbinden: Aufwachen meldet „bereit“, bevor die Nachricht ankommt – das zählt nicht als Antwort', async () => {
  const a = fakeChat('a', 'A');
  const b = fakeChat('b', 'B', { alive: false });
  const { link } = setup([a, b], {
    deliver: async (c, text) => { c.emit('status', 'ready'); await c.send(text); return { ok: true }; },
  });
  const r = await link.send({ from: 'a', chat: 'b', text: 'Hallo' });
  assert.strictEqual(r.data.antwort, 'Antwort auf: Hallo');
});
