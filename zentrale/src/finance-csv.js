// Kontoauszug-Import: liest die CSV-Datei, die man im Online-Banking herunterlädt (Sparkasse, ING, DKB, N26,
// Volksbank, comdirect …). Läuft komplett auf dem Mac. Kontonummern der Gegenseite werden nicht übernommen.
const crypto = require('crypto');
const { money, hasSecretNumber } = require('./finance');

// Je Spalte mehrere Namen, der erste Treffer in dieser Reihenfolge gewinnt (z. B. Verwendungszweck vor Buchungstext).
const COLS = {
  date: [/^(buchungs?tag|buchungsdatum|booking date)/i, /^(datum|date)/i, /^(wertstellung|valuta)/i],
  amount: [/^(betrag|umsatz|amount)/i],
  party: [/^(beguenstigter|begünstigter|zahlungsempfänger|empfänger|auftraggeber|zahlungspflichtige|payee|partner|gegenkonto.?name)/i, /^name/i],
  purpose: [/^verwendungszweck/i, /^(beschreibung|purpose|description)/i, /^(buchungstext|vorgang|text)/i],
};
const anyOf = (list, c) => list.some((re) => re.test(c));

// Einfache Zuordnung nach Stichwörtern; alles Unbekannte landet in „Sonstiges“.
const RULES = [
  ['Lebensmittel', /rewe|edeka|aldi|lidl|kaufland|netto|penny|dm-drogerie|rossmann|norma/i],
  ['Wohnen', /miete|wohnung|hausverwaltung|nebenkosten/i],
  ['Strom & Internet', /strom|stadtwerke|telekom|vodafone|1&1|o2 |congstar|internet/i],
  ['Versicherung', /versicherung|allianz|huk|axa|ergo|devk|krankenkasse|aok|tk |barmer/i],
  ['Auto & Mobilität', /tankstelle|aral|shell|esso|jet |deutsche bahn|db vertrieb|flixbus|swu|parken|kfz/i],
  ['Abos & Software', /netflix|spotify|disney|amazon prime|apple\.com|icloud|google \*|youtube|adobe|microsoft/i],
  ['KI & Werkzeuge', /anthropic|claude|openai|chatgpt|elevenlabs|higgsfield|fal\.ai|midjourney|replicate|github/i],
  ['Gesundheit', /apotheke|arzt|zahnarzt|praxis/i],
  ['Firma', /shopify|vantage|gewerbe|finanzamt|steuer/i],
  ['Freizeit', /restaurant|lieferando|mcdonald|burger|kino|steam|playstation|bar /i],
  ['Kredit', /kredit|darlehen|klarna|ratenzahlung/i],
];

function categorize(party, purpose) {
  const t = `${party} ${purpose}`;
  const hit = RULES.find(([, re]) => re.test(t));
  return hit ? hit[0] : 'Sonstiges';
}

// CSV mit ; oder , und Anführungszeichen.
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function toIsoDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(t);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Bankangaben aus Texten entfernen (IBAN, lange Nummern), damit sie nicht gespeichert werden.
const scrub = (s) => String(s || '').replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,}\s?[A-Z0-9]{0,4}/gi, '[IBAN]').replace(/(?:\d[ -]?){12,}/g, '[Nr.]').replace(/\s+/g, ' ').trim();

function importCsv(text, accountId = '') {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Die Datei ist leer.' };
  if (text.length > 20 * 1024 * 1024) return { ok: false, error: 'Die Datei ist zu groß.' };
  const rows = parseCsv(text.replace(/^﻿/, ''));
  // Kopfzeile suchen: die erste Zeile, in der Datum und Betrag vorkommen (manche Banken haben Vorspann-Zeilen).
  const headIdx = rows.findIndex((r) => r.some((c) => anyOf(COLS.date, c.trim())) && r.some((c) => anyOf(COLS.amount, c.trim())));
  if (headIdx < 0) return { ok: false, error: 'In der Datei wurden keine Spalten „Datum“ und „Betrag“ gefunden. Bitte den Umsatz-Export als CSV aus dem Online-Banking nehmen.' };
  const head = rows[headIdx].map((c) => c.trim());
  const col = (list) => { for (const re of list) { const i = head.findIndex((c) => re.test(c)); if (i >= 0) return i; } return -1; };
  const ix = { date: col(COLS.date), amount: col(COLS.amount), party: col(COLS.party), purpose: col(COLS.purpose) };
  const moves = [];
  let bad = 0;
  for (const r of rows.slice(headIdx + 1)) {
    const date = toIsoDate(r[ix.date]);
    const amount = money(r[ix.amount]);
    if (!date || amount === null) { bad += 1; continue; }
    const party = scrub(ix.party >= 0 ? r[ix.party] : '').slice(0, 80);
    const purpose = scrub(ix.purpose >= 0 ? r[ix.purpose] : '').slice(0, 140);
    if (hasSecretNumber(party) || hasSecretNumber(purpose)) { bad += 1; continue; }
    const key = crypto.createHash('sha256').update(`${accountId}|${date}|${amount}|${party}|${purpose}`).digest('hex').slice(0, 24);
    moves.push({ key, date, amount, party, purpose, category: categorize(party, purpose), account: accountId });
  }
  if (!moves.length) return { ok: false, error: 'Keine Buchungen erkannt.' };
  return { ok: true, moves, skipped: bad };
}

module.exports = { importCsv, parseCsv, categorize, toIsoDate, scrub };
