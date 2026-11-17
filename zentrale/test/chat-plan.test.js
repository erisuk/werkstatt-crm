// Aufgabenliste und Abschluss-Box: Eingaben werden geprüft und gekürzt.
const test = require('node:test');
const assert = require('node:assert');
const { cleanPlan, cleanAbschluss } = require('../src/chat-plan');

test('Aufgabenliste: Status übersetzt, höchstens einer läuft, leere Schritte fallen weg', () => {
  const r = cleanPlan({ schritte: [{ text: 'Bauen', status: 'erledigt' }, { text: 'Testen', status: 'läuft' }, { text: 'Doppelt', status: 'in_progress' }, { text: ' ', status: 'offen' }, { text: 'Committen' }] });
  assert.deepStrictEqual(r.plan.schritte, [{ text: 'Bauen', status: 'erledigt' }, { text: 'Testen', status: 'läuft' }, { text: 'Doppelt', status: 'offen' }, { text: 'Committen', status: 'offen' }]);
  assert.strictEqual(cleanPlan({ schritte: [] }).ok, false);
  assert.strictEqual(cleanPlan({}).ok, false);
  assert.strictEqual(cleanPlan({ schritte: Array.from({ length: 20 }, (_, i) => ({ text: `S${i}` })) }).plan.schritte.length, 12);
});

test('Abschluss: Zusammenfassung Pflicht, Knöpfe nur mit Frage, höchstens drei', () => {
  assert.strictEqual(cleanAbschluss({}).ok, false);
  const ohne = cleanAbschluss({ zusammenfassung: 'Fertig.', knoepfe: [{ text: 'Ja' }] });
  assert.deepStrictEqual(ohne.abschluss, { zusammenfassung: 'Fertig.', frage: null, knoepfe: [] });
  const mit = cleanAbschluss({ zusammenfassung: 'Gebaut.', frage: 'Installieren?', knoepfe: [{ text: 'Ja, installieren' }, { text: 'Später', nachricht: 'Später bitte' }, { text: 'x' }, { text: 'y' }] });
  assert.deepStrictEqual(mit.abschluss.knoepfe, [{ text: 'Ja, installieren', nachricht: 'Ja, installieren' }, { text: 'Später', nachricht: 'Später bitte' }, { text: 'x', nachricht: 'x' }]);
});
