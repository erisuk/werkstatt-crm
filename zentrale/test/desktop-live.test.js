// Abgleich mit der Claude-App: welche Gespräche dort gerade laufen (an deren Claude-Prozessen erkannt).
const test = require('node:test');
const assert = require('node:assert');
const { parsePs, createDesktopLive } = require('../src/desktop-live');

const A = '5d89afe8-1c0e-4dfd-a1e5-6a5504e7cab3';
const B = '0888d557-37c8-41e8-9cef-08ff6510e7df';
const PS = [
  `/Users/e/Library/Application Support/Claude/claude-code/2.1.308/a93ded4b1b47/claude.app/Contents/MacOS/claude --output-format stream-json --resume=${A}`,
  `/Users/e/Library/Application Support/Claude/claude-code/2.1.309/x/claude --session-id ${B} --verbose`,
  `/Users/e/.npm-global/bin/claude -p --input-format stream-json --resume 11111111-2222-3333-4444-555555555555`, // die Zentrale selbst
  '/Applications/Claude.app/Contents/MacOS/Claude',
].join('\n');

test('Claude-App: nur deren Claude-Prozesse zählen, nicht die der Zentrale', () => {
  assert.deepStrictEqual([...parsePs(PS)].sort(), [B, A].sort());
  assert.deepStrictEqual([...parsePs('')], []);
});

test('Claude-App: kurz zwischengespeichert, „force“ sieht frisch nach', async () => {
  let calls = 0;
  let t = 0;
  const live = createDesktopLive({ read: async () => { calls += 1; return PS; }, now: () => t, ttl: 4000 });
  await live();
  await live();
  assert.strictEqual(calls, 1);
  t += 5000;
  await live();
  await live({ force: true });
  assert.strictEqual(calls, 3);
});
