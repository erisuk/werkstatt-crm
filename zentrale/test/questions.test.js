// Auswahlfragen von Claude: Karte statt Text, Antwort im Format der Claude-Kommandozeile.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { ClaudeChat } = require('../src/claude');
const { cleanQuestions, answersFor } = require('../src/questions');

const FAKE = path.join(__dirname, 'fake-claude.js');
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
const texts = (chat) => { const out = []; chat.on('event', (e) => { if (e.kind === 'text') out.push(e.text); }); return out; };

const Q = [
  { question: 'Welche Farbe?', header: 'Farbe', options: [{ label: 'Rot', description: 'warm' }, { label: 'Blau' }] },
  { question: 'Welche Extras?', multiSelect: true, options: [{ label: 'Licht' }, { label: 'Ton' }, { label: 'Text' }] },
];

test('Fragen: nur was die Karte braucht, ohne leere oder doppelte Fragen', () => {
  const q = cleanQuestions({ questions: [...Q, { question: 'Welche Farbe?', options: [{ label: 'x' }] }, { question: '  ' }, { foo: 1 }],
    geheim: 'x' });
  assert.strictEqual(q.length, 2);
  assert.deepStrictEqual(q[0], { question: 'Welche Farbe?', header: 'Farbe', multiSelect: false,
    options: [{ label: 'Rot', description: 'warm' }, { label: 'Blau', description: '' }] });
  assert.strictEqual(q[1].multiSelect, true);
  assert.deepStrictEqual(cleanQuestions(null), []);
  assert.strictEqual(cleanQuestions({ questions: Array.from({ length: 9 }, (_, i) => ({ question: `F${i}`, options: [] })) }).length, 4);
});

test('Antworten: Möglichkeit, mehrere mit Komma, eigener Text – Unpassendes wird abgewiesen', () => {
  const q = cleanQuestions({ questions: Q });
  assert.deepStrictEqual(answersFor(q, [{ labels: ['Blau'] }, { labels: ['Text', 'Licht'], other: 'Musik' }]),
    { 'Welche Farbe?': 'Blau', 'Welche Extras?': 'Licht, Text, Musik' });
  assert.deepStrictEqual(answersFor(q, [{ other: ' Grün ' }, { labels: ['Ton'] }]), { 'Welche Farbe?': 'Grün', 'Welche Extras?': 'Ton' });
  assert.strictEqual(answersFor(q, [{ labels: ['Blau'] }, { labels: [] }]), null, 'jede Frage braucht eine Antwort');
  assert.strictEqual(answersFor(q, [{ labels: ['Lila'] }, { labels: ['Ton'] }]), null, 'nur angebotene Möglichkeiten');
  assert.strictEqual(answersFor(q, [{ labels: ['Rot', 'Blau'] }, { labels: ['Ton'] }]), null, 'Einzelauswahl bleibt einzeln');
  assert.strictEqual(answersFor(q, [{ labels: ['Blau'] }]), null);
  assert.strictEqual(answersFor(q, 'x'), null);
});

test('Chat: Frage erscheint als Karte – auch wenn sonst alles ohne Rückfrage läuft – und die Antwort geht an Claude', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: process.env, cwd: os.tmpdir(), allowAll: () => true, askQuestions: true });
  const out = texts(chat);
  try {
    await chat.send('AUSWAHL:Welche Farbe?');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    const [a] = chat.pendingApprovals();
    assert.strictEqual(a.kind, 'question');
    assert.strictEqual(a.questions[0].header, 'Wahl');
    assert.strictEqual(a.questions[0].options[0].description, 'erste');
    chat.allowPending(); // „Ohne Rückfrage arbeiten“ einschalten beantwortet keine Frage
    assert.strictEqual(chat.pendingApprovals().length, 1);
    assert.strictEqual(chat.respond(a.id, 'allow'), false, 'erlauben ohne Antwort geht nicht');
    assert.strictEqual(chat.answer(a.id, [{ labels: ['C'] }]), false);
    assert.strictEqual(chat.answer(a.id, [{ labels: ['B'] }]), true);
    assert.ok(await waitFor(() => out.includes('allow:{"Welche Farbe?":"B"}')));
    assert.strictEqual(chat.pendingApprovals().length, 0);
  } finally {
    await chat.stop();
  }
});

test('Chat: Frage überspringen – Claude macht mit einer Annahme weiter', async () => {
  const chat = new ClaudeChat({ bin: FAKE, env: process.env, cwd: os.tmpdir(), askQuestions: true });
  const out = texts(chat);
  try {
    await chat.send('AUSWAHL:Welche Farbe?');
    assert.ok(await waitFor(() => chat.pendingApprovals().length === 1));
    assert.strictEqual(chat.respond(chat.pendingApprovals()[0].id, 'deny'), true);
    assert.ok(await waitFor(() => out.some((t) => t.startsWith('deny:') && t.includes('übersprungen'))));
  } finally {
    await chat.stop();
  }
});
