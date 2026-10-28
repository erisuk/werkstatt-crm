// Tests für den privaten Finanzbereich: keine vollen Nummern, Verschlüsselung, Berechnungen, CSV-Import.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FinanceStore, clean, summary, money, hasSecretNumber } = require('../src/finance');
const { importCsv, toIsoDate, scrub, categorize } = require('../src/finance-csv');

// Test-Verschlüsselung (in der App: macOS-Schlüsselbund)
const crypt = { encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64').split('').reverse().join('')), decrypt: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString() };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-fin-')), 'privat', 'finanzen.bin');

test('Volle Karten- und Kontonummern werden abgelehnt, nur die letzten 4 Ziffern', () => {
  assert.ok(hasSecretNumber('4111 1111 1111 1111'));
  assert.ok(hasSecretNumber('DE89 3704 0044 0532 0130 00'));
  assert.ok(hasSecretNumber('DE89370400440532013000'));
  assert.ok(!hasSecretNumber('Miete 950'));
  assert.strictEqual(clean('accounts', { name: 'Visa', balance: '0', note: '4111111111111111' }).ok, false);
  assert.strictEqual(clean('accounts', { name: 'Visa', balance: '0', last4: '12345' }).ok, false);
  assert.strictEqual(clean('accounts', { name: 'Visa', balance: '0', last4: '1a34' }).ok, false);
  assert.strictEqual(clean('accounts', { name: 'Visa', balance: '-300,50', last4: '1234', kind: 'kredit' }).item.balance, -300.5);
});

test('Beträge im deutschen Format', () => {
  assert.strictEqual(money('1.234,56'), 1234.56);
  assert.strictEqual(money('1234,5'), 1234.5);
  assert.strictEqual(money('-12'), -12);
  assert.strictEqual(money('12,99 €'), 12.99);
  assert.strictEqual(money('abc'), null);
  assert.strictEqual(money(''), null);
});

test('Ablage ist verschlüsselt, Rechnung stimmt', () => {
  const file = tmp();
  const s = new FinanceStore(file, crypt);
  const giro = s.upsert('accounts', { name: 'Giro', balance: '1.500,00' }).item;
  s.upsert('accounts', { name: 'Kreditkarte', balance: '-200', kind: 'kredit' });
  s.upsert('fixed', { name: 'Miete', amount: '600', interval: 'monat', category: 'Wohnen', account: giro.id, next: '2026-11-01' });
  s.upsert('fixed', { name: 'Versicherung', amount: '120', interval: 'jahr', category: 'Versicherung', cancelBy: '2026-11-10' });
  s.upsert('incomes', { name: 'Minijob', amount: '600', interval: 'monat' });
  s.upsert('incomes', { name: 'Einmalig', amount: '50', interval: 'einmal', date: '2026-10-01' });
  s.upsert('bills', { name: 'Zahnarzt', amount: '80', due: '2026-10-20' });
  assert.strictEqual(s.upsert('fixed', { name: 'Kaputt', amount: '-5' }).ok, false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!/Miete|Minijob|Giro/.test(raw), 'Klartext in der Datei');
  assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600);
  const sum = summary(new FinanceStore(file, crypt).load(), new Date('2026-10-28T12:00:00'));
  assert.strictEqual(sum.netWorth, 1300);
  assert.strictEqual(sum.debt, 200);
  assert.strictEqual(sum.fixedMonth, 610);
  assert.strictEqual(sum.incomeMonth, 600);
  assert.strictEqual(sum.freeMonth, -10);
  assert.strictEqual(sum.openBills, 80);
  assert.deepStrictEqual(sum.upcoming.map((u) => [u.name, u.overdue]), [['Zahnarzt', true], ['Miete', false]]);
  assert.deepStrictEqual(sum.cancelSoon.map((f) => f.name), ['Versicherung']);
  s.remove('bills', s.load().bills[0].id);
  assert.strictEqual(s.load().bills.length, 0);
});

test('Kontoauszug: Sparkasse-Format mit Vorspann, ohne IBANs, keine Doppelten', () => {
  const csv = [
    'Umsätze Girokonto;;;', '',
    '"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"Betrag";"Waehrung"',
    '"DE00";"01.10.26";"01.10.26";"LASTSCHRIFT";"Miete Oktober";"Hausverwaltung Ulm";"DE89370400440532013000";"-600,00";"EUR"',
    '"DE00";"02.10.26";"02.10.26";"KARTENZAHLUNG";"REWE SAGT DANKE";"REWE Markt";"";"-23,45";"EUR"',
    '"DE00";"05.10.26";"05.10.26";"GUTSCHRIFT";"Lohn DE12 3456 7890 1234 5678 90";"ESA Dienstleistungen";"";"600,00";"EUR"',
    '"DE00";"kaputt";"";"";"";"";"";"x";"EUR"',
  ].join('\n');
  const r = importCsv(csv, 'giro');
  assert.ok(r.ok);
  assert.strictEqual(r.moves.length, 3);
  assert.strictEqual(r.skipped, 1);
  assert.deepStrictEqual(r.moves.map((m) => [m.date, m.amount, m.category]), [['2026-10-01', -600, 'Wohnen'], ['2026-10-02', -23.45, 'Lebensmittel'], ['2026-10-05', 600, 'Sonstiges']]);
  assert.ok(!JSON.stringify(r.moves).includes('DE89'));
  assert.match(r.moves[2].purpose, /\[IBAN\]/);
  const s = new FinanceStore(tmp(), crypt);
  assert.strictEqual(s.addMoves(r.moves).added, 3);
  assert.strictEqual(s.addMoves(importCsv(csv, 'giro').moves).added, 0);
  const sum = summary(s.load());
  assert.deepStrictEqual(sum.flow.months, [{ month: '2026-10', in: 600, out: 623.45 }]);
  assert.strictEqual(sum.flow.inFrom[0].name, 'ESA Dienstleistungen');
  assert.strictEqual(importCsv('a;b\n1;2', '').ok, false);
});

test('Hilfen: Datum, Schwärzen, Kategorien', () => {
  assert.strictEqual(toIsoDate('1.2.2026'), '2026-02-01');
  assert.strictEqual(toIsoDate('2026-02-01'), '2026-02-01');
  assert.strictEqual(toIsoDate('morgen'), null);
  assert.strictEqual(scrub('Karte 4111 1111 1111 1111'), 'Karte [Nr.]');
  assert.strictEqual(categorize('ANTHROPIC', 'Claude Pro'), 'KI & Werkzeuge');
});

test('Prüfung: UUIDs mit langen Ziffern, Tausenderpunkte, Ortszeit', () => {
  assert.ok(clean('fixed', { id: '12345678-1234-4abc-8def-123456789012', name: 'Miete', amount: '600', account: '12345678-1234-4abc-8def-123456789012' }).ok);
  assert.strictEqual(money('1.250'), 1250);
  assert.strictEqual(money('12.500.000'), 12500000);
  assert.strictEqual(money('1.25'), 1.25);
  // 00:30 Ortszeit: „heute“ ist der lokale Tag, nicht der UTC-Tag davor
  const sum = summary({ accounts: [], fixed: [], incomes: [], moves: [], snapshots: [], bills: [{ name: 'X', amount: 1, due: '2026-10-27', paid: false }] }, new Date(2026, 9, 28, 0, 30));
  assert.strictEqual(sum.upcoming[0].overdue, true);
});
