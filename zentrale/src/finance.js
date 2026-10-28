// Privater Finanzbereich: Konten, Karten, feste Kosten, Rechnungen, Einnahmen und Kontobewegungen.
// Alles bleibt auf diesem Mac – verschlüsselt mit dem Schlüssel aus dem macOS-Schlüsselbund (safeStorage).
// Kein Netz, keine Claude-Werkzeuge, keine Zahlungen. Volle Karten- oder Kontonummern werden abgelehnt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = { giro: 'Girokonto', spar: 'Sparkonto', kredit: 'Kreditkarte', debit: 'Bankkarte', bar: 'Bargeld', depot: 'Depot', paypal: 'PayPal', sonst: 'Sonstiges' };
const INTERVALS = { woche: 52 / 12, monat: 1, quartal: 1 / 3, halbjahr: 1 / 6, jahr: 1 / 12 };
const CATEGORIES = ['Wohnen', 'Strom & Internet', 'Handy', 'Versicherung', 'Auto & Mobilität', 'Abos & Software', 'KI & Werkzeuge',
  'Lebensmittel', 'Gesundheit', 'Kredit', 'Sparen', 'Firma', 'Freizeit', 'Sonstiges'];
const MAX = { accounts: 50, fixed: 200, bills: 300, incomes: 200, moves: 5000 };

// Volle Karten- oder Kontonummern haben hier nichts verloren: 12+ Ziffern am Stück (auch mit Leerzeichen) oder eine IBAN.
const LONG_NUMBER = /(?:\d[ -]?){12,}/;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,}/i;
function hasSecretNumber(v) {
  const s = String(v || '');
  return LONG_NUMBER.test(s) || IBAN.test(s);
}

const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const s = String(v || '').trim().replace(/\s|€|EUR/gi, '');
  if (!s) return null;
  // 1.234,56 · 1234,56 · 1234.56 · -12
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) && Math.abs(n) < 1e9 ? Math.round(n * 100) / 100 : null;
}
function day(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : s;
}

// Jedes Eingabefeld läuft hier durch. Gibt { ok, item } oder { ok:false, error } zurück.
function clean(kind, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const strings = Object.values(r).filter((v) => typeof v === 'string');
  if (strings.some(hasSecretNumber)) return { ok: false, error: 'Bitte keine vollständigen Karten- oder Kontonummern eintragen – nur die letzten 4 Ziffern.' };
  const id = typeof r.id === 'string' && /^[\w-]{8,64}$/.test(r.id) ? r.id : crypto.randomUUID();
  if (kind === 'accounts') {
    const name = text(r.name, 60);
    if (!name) return { ok: false, error: 'Bitte einen Namen angeben (z. B. „Sparkasse Giro“).' };
    const last4 = text(r.last4, 4);
    if (last4 && !/^\d{4}$/.test(last4)) return { ok: false, error: 'Bei „Endet auf“ bitte genau 4 Ziffern.' };
    const balance = money(r.balance);
    if (balance === null) return { ok: false, error: 'Bitte einen Kontostand angeben (z. B. 1.250,00 oder -300).' };
    const limit = r.limit === '' || r.limit == null ? null : money(r.limit);
    return { ok: true, item: { id, name, bank: text(r.bank, 60), kind: KINDS[r.kind] ? r.kind : 'giro', last4, balance, limit,
      note: text(r.note, 200), updatedAt: Date.now() } };
  }
  if (kind === 'fixed') {
    const name = text(r.name, 60);
    const amount = money(r.amount);
    if (!name || amount === null || amount <= 0) return { ok: false, error: 'Bitte Name und Betrag (größer 0) angeben.' };
    return { ok: true, item: { id, name, amount, interval: INTERVALS[r.interval] ? r.interval : 'monat',
      category: CATEGORIES.includes(r.category) ? r.category : 'Sonstiges', account: text(r.account, 64), next: day(r.next),
      cancelBy: day(r.cancelBy), note: text(r.note, 200) } };
  }
  if (kind === 'bills') {
    const name = text(r.name, 80);
    const amount = money(r.amount);
    if (!name || amount === null || amount <= 0) return { ok: false, error: 'Bitte Name und Betrag (größer 0) angeben.' };
    return { ok: true, item: { id, name, amount, due: day(r.due), paid: r.paid === true, category: CATEGORIES.includes(r.category) ? r.category : 'Sonstiges', note: text(r.note, 200) } };
  }
  if (kind === 'incomes') {
    const name = text(r.name, 60);
    const amount = money(r.amount);
    if (!name || amount === null || amount <= 0) return { ok: false, error: 'Bitte Quelle und Betrag (größer 0) angeben.' };
    const interval = r.interval === 'einmal' ? 'einmal' : (INTERVALS[r.interval] ? r.interval : 'monat');
    return { ok: true, item: { id, name, amount, interval, date: day(r.date) || new Date().toISOString().slice(0, 10), account: text(r.account, 64), note: text(r.note, 200) } };
  }
  return { ok: false, error: 'Unbekannte Art.' };
}

const EMPTY = () => ({ version: 1, accounts: [], fixed: [], bills: [], incomes: [], moves: [], snapshots: [] });

// Verschlüsselte Ablage. crypt = { encrypt(string) → Buffer, decrypt(Buffer) → string } (in der App: safeStorage).
class FinanceStore {
  constructor(file, crypt) {
    this.file = file;
    this.crypt = crypt;
  }

  load() {
    if (!fs.existsSync(this.file)) return EMPTY();
    const raw = this.crypt.decrypt(fs.readFileSync(this.file));
    const d = JSON.parse(raw);
    const base = EMPTY();
    for (const k of Object.keys(base)) if (Array.isArray(d[k])) base[k] = d[k];
    return base;
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.crypt.encrypt(JSON.stringify(data)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  upsert(kind, raw) {
    if (!MAX[kind] || kind === 'moves') return { ok: false, error: 'Unbekannte Art.' };
    const res = clean(kind, raw);
    if (!res.ok) return res;
    const d = this.load();
    const exists = d[kind].some((x) => x.id === res.item.id);
    if (!exists && d[kind].length >= MAX[kind]) return { ok: false, error: 'Zu viele Einträge.' };
    d[kind] = exists ? d[kind].map((x) => (x.id === res.item.id ? res.item : x)) : [...d[kind], res.item];
    // Verlauf: einmal am Tag den Gesamtstand merken, wenn sich ein Konto ändert.
    if (kind === 'accounts') d.snapshots = snapshot(d);
    this.write(d);
    return { ok: true, item: res.item };
  }

  remove(kind, id) {
    if (!MAX[kind]) return { ok: false, error: 'Unbekannte Art.' };
    const d = this.load();
    d[kind] = d[kind].filter((x) => x.id !== id);
    if (kind === 'accounts') d.snapshots = snapshot(d);
    this.write(d);
    return { ok: true };
  }

  addMoves(list) {
    const d = this.load();
    const seen = new Set(d.moves.map((m) => m.key));
    const fresh = list.filter((m) => !seen.has(m.key));
    d.moves = [...d.moves, ...fresh].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX.moves);
    this.write(d);
    return { ok: true, added: fresh.length, skipped: list.length - fresh.length };
  }

  clearMoves() {
    const d = this.load();
    d.moves = [];
    this.write(d);
    return { ok: true };
  }
}

function netWorth(accounts) {
  return Math.round(accounts.reduce((n, a) => n + a.balance, 0) * 100) / 100;
}

function snapshot(d) {
  const today = new Date().toISOString().slice(0, 10);
  const rest = (d.snapshots || []).filter((s) => s.date !== today);
  return [...rest, { date: today, total: netWorth(d.accounts) }].slice(-730);
}

const perMonth = (amount, interval) => Math.round(amount * (INTERVALS[interval] || 0) * 100) / 100;

// Zahlen fürs Dashboard – alles aus den eigenen Einträgen, nichts geschätzt.
function summary(d, now = new Date()) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const fixedMonth = r2(d.fixed.reduce((n, f) => n + perMonth(f.amount, f.interval), 0));
  const incomeMonth = r2(d.incomes.filter((i) => i.interval !== 'einmal').reduce((n, i) => n + perMonth(i.amount, i.interval), 0));
  const byCategory = {};
  for (const f of d.fixed) byCategory[f.category] = r2((byCategory[f.category] || 0) + perMonth(f.amount, f.interval));
  const debts = d.accounts.filter((a) => a.balance < 0);
  const upcoming = [
    ...d.bills.filter((b) => !b.paid && b.due && b.due <= in30).map((b) => ({ type: 'Rechnung', name: b.name, amount: b.amount, date: b.due, overdue: b.due < today })),
    ...d.fixed.filter((f) => f.next && f.next >= today && f.next <= in30).map((f) => ({ type: 'Fest', name: f.name, amount: f.amount, date: f.next, overdue: false })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const cancelSoon = d.fixed.filter((f) => f.cancelBy && f.cancelBy >= today && f.cancelBy <= in30);
  // Kontobewegungen: je Monat rein/raus, wohin das Geld ging, woher es kam.
  const months = {};
  const outTo = {};
  const inFrom = {};
  for (const m of d.moves) {
    const k = m.date.slice(0, 7);
    months[k] = months[k] || { month: k, in: 0, out: 0 };
    if (m.amount >= 0) { months[k].in = r2(months[k].in + m.amount); inFrom[m.party || 'Unbekannt'] = r2((inFrom[m.party || 'Unbekannt'] || 0) + m.amount); }
    else { months[k].out = r2(months[k].out - m.amount); outTo[m.category] = r2((outTo[m.category] || 0) - m.amount); }
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, amount]) => ({ name, amount }));
  return {
    netWorth: netWorth(d.accounts), debt: r2(debts.reduce((n, a) => n - a.balance, 0)), fixedMonth, incomeMonth,
    freeMonth: r2(incomeMonth - fixedMonth), byCategory: top(byCategory, 20), upcoming, cancelSoon,
    openBills: r2(d.bills.filter((b) => !b.paid).reduce((n, b) => n + b.amount, 0)),
    flow: { months: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).slice(-12), outTo: top(outTo, 8), inFrom: top(inFrom, 8) },
    history: d.snapshots.slice(-90),
  };
}

module.exports = { FinanceStore, clean, summary, money, hasSecretNumber, perMonth, KINDS, INTERVALS, CATEGORIES };
