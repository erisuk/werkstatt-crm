// Seite „Bit-Videos“: zeigt und steuert die Video-Automatik im Studio-Ordner (Themen-Radar, Wunschthemen, Pause).
// Die Zentrale schreibt nur Dateien in studio/gedaechtnis/ – das Tagesvideo (pipeline/tagesvideo.py) liest sie beim
// nächsten Lauf. Gleiche Regeln wie pipeline/einstellungen.py: Ungültiges wird verworfen, nie halb geschrieben.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STUDIO_STANDARD = path.join(os.homedir(), 'ki-creator', 'studio');
const QUELLEN = [
  ['claude-neu', 'Claude-Neuigkeiten', 'Offizielle Claude-Artikel und Claude-Code-Änderungen'],
  ['anthropic', 'Anthropic-News', 'Ankündigungen von Anthropic'],
  ['github', 'GitHub', 'Neue Projekte, die gerade viele Sterne sammeln (mit Betrugs-Prüfung)'],
  ['reddit', 'Reddit', 'Tages-Top aus den Subreddits unten'],
  ['hacker-news', 'Hacker News', 'Startseite der Tech-Community'],
  ['product-hunt', 'Product Hunt', 'Neue Apps und Tools'],
  ['google-trends', 'Google Trends', 'Was in Deutschland gerade gesucht wird'],
  ['heise', 'heise', 'Deutsche Tech-News'],
];
const QUELLEN_IDS = QUELLEN.map(([id]) => id);
const STANDARD = {
  quellen_aus: [],
  reddit_subs: ['ClaudeAI', 'LocalLLaMA', 'artificial', 'OpenAI', 'ChatGPT', 'technology', 'gadgets', 'InternetIsBeautiful'],
  github_alle: 3,
  fokus: '',
};
const SUB = /^[A-Za-z0-9_]{2,21}$/;
const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FOKUS = 300;
const MAX_THEMA = 200;
const MAX_WUENSCHE = 30;

const studioPfad = () => process.env.ZENTRALE_BIT_STUDIO || STUDIO_STANDARD;
const gedaechtnis = (studio) => path.join(studio, 'gedaechtnis');
const datei = (studio, name) => path.join(gedaechtnis(studio), name);

function lesen(file, leer) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return leer; }
}

function schreiben(file, daten) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(daten, null, 1));
  fs.renameSync(tmp, file);
}

function einstellungen(studio) {
  const roh = lesen(datei(studio, 'radar_einstellungen.json'), {});
  const r = roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {};
  const aus = Array.isArray(r.quellen_aus) ? r.quellen_aus.filter((q) => QUELLEN_IDS.includes(q)) : [];
  const subs = Array.isArray(r.reddit_subs) ? r.reddit_subs.filter((s) => typeof s === 'string' && SUB.test(s)) : [];
  const alle = Number.isInteger(r.github_alle) && r.github_alle >= 0 && r.github_alle <= 10 ? r.github_alle : STANDARD.github_alle;
  return { quellen_aus: aus, reddit_subs: subs.length ? subs : STANDARD.reddit_subs, github_alle: alle,
    fokus: String(r.fokus || '').trim().slice(0, MAX_FOKUS) };
}

function wuensche(studio) {
  const liste = lesen(datei(studio, 'wunschthemen.json'), []);
  return Array.isArray(liste) ? liste.filter((w) => w && String(w.thema || '').trim()) : [];
}

function gesperrt(studio) {
  const liste = lesen(datei(studio, 'themen_gesperrt.json'), []);
  return Array.isArray(liste) ? liste.filter((t) => typeof t === 'string') : [];
}

// Fertige Videos (Nummern ab 900 sind Tests) mit Freigabe-/Post-Status aus der Telegram-Buchführung.
function videos(studio) {
  const status = lesen(datei(studio, 'veroeffentlichung.json'), {});
  let ordner = [];
  try { ordner = fs.readdirSync(path.join(studio, 'videos')).filter((n) => /^\d{3}-/.test(n) && Number(n.slice(0, 3)) < 900).sort().reverse(); } catch {}
  return ordner.map((n) => {
    const sk = lesen(path.join(studio, 'videos', n, 'skript.json'), {});
    const s = status[`v${n.slice(0, 3)}`] || {};
    return { nr: Number(n.slice(0, 3)), thema: String(sk.thema || n.slice(4)), format: String(sk.format || ''),
      status: s.status || 'in Arbeit', gepostet: Array.isArray(s.gepostet) ? s.gepostet : [], zeit: s.zeit || '' };
  });
}

// Neueste Themenliste des Radars.
function radar(studio) {
  const ordner = path.join(gedaechtnis(studio), 'recherche');
  let tage = [];
  try { tage = fs.readdirSync(ordner).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(); } catch {}
  const letzte = tage[tage.length - 1];
  if (!letzte) return { datum: null, themen: [], ausfaelle: [] };
  const d = lesen(path.join(ordner, letzte), {});
  const themen = (Array.isArray(d.themen) ? d.themen : []).map((t) => ({
    thema: String(t.thema || ''), format: String(t.format || ''), hook: String(t.hook || ''),
    warum: String(t.warum_jetzt || ''), summe: Number(t.summe) || 0, quellen: Array.isArray(t.quellen) ? t.quellen.slice(0, 3) : [],
    werte: { superkraft: t.superkraft, spart: t.spart, wow: t.wow, einfach: t.einfach, aktuell: t.aktuell } }));
  return { datum: letzte.slice(0, 10), themen, ausfaelle: Array.isArray(d.ausfaelle) ? d.ausfaelle : [] };
}

function pauseBis(studio) {
  try {
    const bis = fs.readFileSync(datei(studio, 'pause_bis.txt'), 'utf8').trim();
    return DATUM.test(bis) && bis > heute() ? bis : null;
  } catch { return null; }
}

const heute = () => new Date().toLocaleDateString('sv-SE');   // JJJJ-MM-TT in Ortszeit

function uebersicht(studio = studioPfad()) {
  if (!fs.existsSync(gedaechtnis(studio))) return { ok: false, error: `Studio-Ordner nicht gefunden: ${studio}` };
  const vids = videos(studio);
  const gemacht = new Set(vids.map((v) => v.thema));
  const gesperrtListe = gesperrt(studio);
  const r = radar(studio);
  return { ok: true, data: {
    pauseBis: pauseBis(studio), videos: vids, einstellungen: einstellungen(studio), wuensche: wuensche(studio),
    gesperrt: gesperrtListe, quellen: QUELLEN.map(([id, name, info]) => ({ id, name, info })),
    radar: { ...r, themen: r.themen.map((t) => ({ ...t, gemacht: gemacht.has(t.thema), gesperrt: gesperrtListe.includes(t.thema) })) },
  } };
}

function pauseSetzen(bis, studio = studioPfad()) {
  const f = datei(studio, 'pause_bis.txt');
  if (!bis) { fs.rmSync(f, { force: true }); return { ok: true }; }
  if (!DATUM.test(String(bis)) || String(bis) <= heute()) return { ok: false, error: 'Bitte ein Datum in der Zukunft wählen.' };
  fs.writeFileSync(f, `${bis}\n`);
  return { ok: true };
}

function einstellen(patch, studio = studioPfad()) {
  const alt = einstellungen(studio);
  const p = patch || {};
  const neu = { ...alt };
  if ('quellen_aus' in p) {
    if (!Array.isArray(p.quellen_aus)) return { ok: false, error: 'Quellen ungültig.' };
    neu.quellen_aus = p.quellen_aus.filter((q) => QUELLEN_IDS.includes(q));
    if (neu.quellen_aus.length === QUELLEN_IDS.length) return { ok: false, error: 'Mindestens eine Quelle muss an bleiben.' };
  }
  if ('reddit_subs' in p) {
    const subs = String(p.reddit_subs || '').split(/[\s,]+/).map((s) => s.replace(/^\/?r\//i, '')).filter(Boolean);
    const falsch = subs.filter((s) => !SUB.test(s));
    if (falsch.length) return { ok: false, error: `Kein gültiger Subreddit-Name: ${falsch.join(', ')}` };
    if (!subs.length) return { ok: false, error: 'Mindestens ein Subreddit eintragen.' };
    neu.reddit_subs = [...new Set(subs)];
  }
  if ('github_alle' in p) {
    const n = Number(p.github_alle);
    if (!Number.isInteger(n) || n < 0 || n > 10) return { ok: false, error: 'GitHub-Takt muss zwischen 0 und 10 liegen.' };
    neu.github_alle = n;
  }
  if ('fokus' in p) neu.fokus = String(p.fokus || '').trim().slice(0, MAX_FOKUS);
  schreiben(datei(studio, 'radar_einstellungen.json'), neu);
  return { ok: true };
}

function wunschHinzu(thema, link, studio = studioPfad()) {
  const t = String(thema || '').trim().slice(0, MAX_THEMA);
  const l = String(link || '').trim();
  if (!t) return { ok: false, error: 'Bitte ein Thema eintragen.' };
  if (l && !/^https?:\/\/\S+$/i.test(l)) return { ok: false, error: 'Der Link muss mit https:// anfangen.' };
  const liste = wuensche(studio);
  if (liste.length >= MAX_WUENSCHE) return { ok: false, error: `Höchstens ${MAX_WUENSCHE} Wunschthemen in der Warteschlange.` };
  schreiben(datei(studio, 'wunschthemen.json'), [...liste, { id: crypto.randomUUID(), thema: t, link: l, angelegt: Date.now() }]);
  return { ok: true };
}

function wunschEntfernen(id, studio = studioPfad()) {
  schreiben(datei(studio, 'wunschthemen.json'), wuensche(studio).filter((w) => w.id !== id));
  return { ok: true };
}

// Nach oben schieben = kommt beim nächsten Lauf dran.
function wunschVor(id, studio = studioPfad()) {
  const liste = wuensche(studio);
  const w = liste.find((x) => x.id === id);
  if (!w) return { ok: false, error: 'Dieses Wunschthema gibt es nicht mehr.' };
  schreiben(datei(studio, 'wunschthemen.json'), [w, ...liste.filter((x) => x.id !== id)]);
  return { ok: true };
}

function sperren(thema, an, studio = studioPfad()) {
  const t = String(thema || '').trim().slice(0, 300);
  if (!t) return { ok: false, error: 'Kein Thema angegeben.' };
  const liste = gesperrt(studio).filter((x) => x !== t);
  schreiben(datei(studio, 'themen_gesperrt.json'), an ? [...liste, t] : liste);
  return { ok: true };
}

module.exports = { uebersicht, pauseSetzen, einstellen, wunschHinzu, wunschEntfernen, wunschVor, sperren, einstellungen, STANDARD, QUELLEN_IDS };
