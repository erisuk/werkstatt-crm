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
const MAX_VERSUCHE = 2;   // wie pipeline/einstellungen.py: danach wird der Wunsch übersprungen
const KAPUTT = Symbol('kaputt');
const STICHWORT = /^[\p{L}\p{N}]{2,30}$/u;
const MAX_NACHRICHT = 500;
const ANTWORT_OHNE_LINK = 'Hey {name}, danke für deinen Kommentar! 🙌 Du bist auf der Liste – ich schick dir alles, sobald es fertig ist.';

// Kürzt nach Zeichen wie Python (Emoji = 1 Zeichen), nie mitten in einem Emoji.
const kurz = (s, n) => Array.from(String(s == null ? '' : s).trim()).slice(0, n).join('');
const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const versuche = (w) => (Number.isInteger(w.versuche) ? w.versuche : 0);

const studioPfad = () => process.env.ZENTRALE_BIT_STUDIO || STUDIO_STANDARD;
const gedaechtnis = (studio) => path.join(studio, 'gedaechtnis');
const datei = (studio, name) => path.join(gedaechtnis(studio), name);

function lesen(file, leer) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? leer : KAPUTT; }
  try { return JSON.parse(text); } catch { return KAPUTT; }
}

function schreiben(file, daten) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(daten, null, 1));
  fs.renameSync(tmp, file);
}

function einstellungen(studio) {
  const roh = lesen(datei(studio, 'radar_einstellungen.json'), {});
  const r = istObjekt(roh) ? roh : {};
  const aus = Array.isArray(r.quellen_aus) ? r.quellen_aus.filter((q) => QUELLEN_IDS.includes(q)) : [];
  const subs = Array.isArray(r.reddit_subs) ? r.reddit_subs.filter((s) => typeof s === 'string' && SUB.test(s)) : [];
  const alle = Number.isInteger(r.github_alle) && r.github_alle >= 0 && r.github_alle <= 10 ? r.github_alle : STANDARD.github_alle;
  return { quellen_aus: aus, reddit_subs: subs.length ? subs : STANDARD.reddit_subs, github_alle: alle,
    fokus: kurz(r.fokus || '', MAX_FOKUS) };
}

function wuensche(studio) {
  const liste = lesen(datei(studio, 'wunschthemen.json'), []);
  return Array.isArray(liste) ? liste.filter((w) => istObjekt(w) && String(w.id || '').trim() && String(w.thema || '').trim())
    .map((w) => ({ ...w, versuche: versuche(w), uebersprungen: versuche(w) >= MAX_VERSUCHE })) : [];
}

// Wunschliste ändern – nie, wenn die Datei gerade nicht lesbar ist (sonst wäre sie danach leer).
function wuenscheAendern(studio, aendern) {
  const roh = lesen(datei(studio, 'wunschthemen.json'), []);
  if (!Array.isArray(roh)) return { ok: false, error: 'Die Wunschliste ist gerade nicht lesbar – bitte gleich nochmal versuchen.' };
  const neu = aendern(roh.filter(istObjekt));
  if (!neu.ok) return neu;
  schreiben(datei(studio, 'wunschthemen.json'), neu.liste);
  return { ok: true };
}

function gesperrt(studio) {
  const liste = lesen(datei(studio, 'themen_gesperrt.json'), []);
  return Array.isArray(liste) ? liste.filter((t) => typeof t === 'string') : [];
}

// Fertige Videos (Nummern ab 900 sind Tests) mit Freigabe-/Post-Status aus der Telegram-Buchführung.
function videos(studio) {
  const roh = lesen(datei(studio, 'veroeffentlichung.json'), {});
  const status = istObjekt(roh) ? roh : {};
  let ordner = [];
  try { ordner = fs.readdirSync(path.join(studio, 'videos')).filter((n) => /^\d{3}-/.test(n) && Number(n.slice(0, 3)) < 900).sort().reverse(); } catch {}
  const eigeneRoh = lesen(datei(studio, 'kommentar_aktionen.json'), {});
  const eigene = istObjekt(eigeneRoh) ? eigeneRoh : {};
  return ordner.map((n) => {
    const id = `v${n.slice(0, 3)}`;
    const objekt = (f) => { const x = lesen(path.join(studio, 'videos', n, f), {}); return istObjekt(x) ? x : {}; };
    const sk = objekt('skript.json');
    const s = istObjekt(status[id]) ? status[id] : {};
    return { id, nr: Number(n.slice(0, 3)), thema: String(sk.thema || n.slice(4)), format: String(sk.format || ''),
      status: String(s.status || 'in Arbeit'), gepostet: Array.isArray(s.gepostet) ? s.gepostet.map(String) : [], zeit: String(s.zeit || ''),
      aktion: aktionVon(sk, objekt('post.json'), istObjekt(eigene[id]) ? eigene[id] : {}) };
  });
}

// Kommentar-Aktion eines Videos: das Stichwort, das Bit im Video nennt („Schreib MOD in die Kommentare“), und die
// Antwort, die jeder bekommt, der es kommentiert. Standard kommt aus dem Video selbst (skript.json kommentar_wort,
// post.json pin_kommentar mit dem Link); in der Zentrale geänderte Werte liegen in gedaechtnis/kommentar_aktionen.json.
function aktionVon(sk, post, eigen) {
  const wort = String(eigen.stichwort || sk.kommentar_wort || '').trim().toUpperCase();
  if (!STICHWORT.test(wort)) return null;
  const pin = String(post.pin_kommentar || '').trim();
  const standard = pin ? `Hey {name}! ${pin}` : ANTWORT_OHNE_LINK;
  const eigeneNachricht = kurz(eigen.nachricht || '', MAX_NACHRICHT);
  return { stichwort: wort, nachricht: eigeneNachricht || standard, aktiv: eigen.aktiv !== false, geaendert: !!(eigen.stichwort || eigeneNachricht) };
}

// Alle Videos mit Kommentar-Aktion, neueste zuerst.
function aktionen(studio = studioPfad()) {
  return videos(studio).filter((v) => v.aktion).map((v) => ({ video: v.id, nr: v.nr, thema: v.thema, ...v.aktion }));
}

function aktionSetzen(video, patch, studio = studioPfad()) {
  if (!/^v\d{3}$/.test(String(video)) || !istObjekt(patch)) return { ok: false, error: 'Ungültige Angaben.' };
  if (!videos(studio).some((v) => v.id === video)) return { ok: false, error: 'Dieses Video gibt es nicht.' };
  const f = datei(studio, 'kommentar_aktionen.json');
  const roh = lesen(f, {});
  if (!istObjekt(roh)) return { ok: false, error: 'Die Kommentar-Einstellungen sind gerade nicht lesbar.' };
  const neu = { ...(istObjekt(roh[video]) ? roh[video] : {}) };
  if ('stichwort' in patch) {
    const w = String(patch.stichwort || '').trim().toUpperCase();
    if (!STICHWORT.test(w)) return { ok: false, error: 'Das Stichwort muss ein Wort aus 2–30 Buchstaben oder Ziffern sein.' };
    neu.stichwort = w;
  }
  if ('nachricht' in patch) {
    const t = kurz(patch.nachricht, MAX_NACHRICHT);
    if (!t) return { ok: false, error: 'Die Antwort darf nicht leer sein.' };
    neu.nachricht = t;
  }
  if ('aktiv' in patch) neu.aktiv = !!patch.aktiv;
  schreiben(f, { ...roh, [video]: neu });
  return { ok: true };
}

// Neueste Themenliste des Radars.
function radar(studio) {
  const ordner = path.join(gedaechtnis(studio), 'recherche');
  let tage = [];
  try { tage = fs.readdirSync(ordner).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(); } catch {}
  const letzte = tage[tage.length - 1];
  if (!letzte) return { datum: null, themen: [], ausfaelle: [] };
  const roh = lesen(path.join(ordner, letzte), {});
  const d = istObjekt(roh) ? roh : {};
  const themen = (Array.isArray(d.themen) ? d.themen : []).filter(istObjekt).map((t) => ({
    thema: String(t.thema || ''), format: String(t.format || ''), hook: String(t.hook || ''),
    warum: String(t.warum_jetzt || ''), summe: Number(t.summe) || 0, quellen: Array.isArray(t.quellen) ? t.quellen.slice(0, 3) : [],
    werte: Object.fromEntries(['superkraft', 'spart', 'wow', 'einfach', 'aktuell'].map((k) => [k, Number.isFinite(t[k]) ? t[k] : null])) }));
  return { datum: letzte.slice(0, 10), themen, ausfaelle: Array.isArray(d.ausfaelle) ? d.ausfaelle.map(String) : [] };
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
  try { return { ok: true, data: daten(studio) }; } catch (e) { return { ok: false, error: `Studio-Daten nicht lesbar: ${e.message}` }; }
}

function daten(studio) {
  const vids = videos(studio);
  const gemacht = new Set(vids.map((v) => v.thema));
  const gesperrtListe = gesperrt(studio);
  const r = radar(studio);
  const wunschListe = wuensche(studio);
  const vorgemerkt = new Set(wunschListe.map((w) => w.thema.toLowerCase()));
  return {
    pauseBis: pauseBis(studio), videos: vids, einstellungen: einstellungen(studio), wuensche: wunschListe,
    gesperrt: gesperrtListe, quellen: QUELLEN.map(([id, name, info]) => ({ id, name, info })),
    radar: { ...r, themen: r.themen.map((t) => ({ ...t, gemacht: gemacht.has(t.thema), gesperrt: gesperrtListe.includes(t.thema),
      vorgemerkt: vorgemerkt.has(t.thema.toLowerCase()) })) },
  };
}

function pauseSetzen(bis, studio = studioPfad()) {
  const f = datei(studio, 'pause_bis.txt');
  if (!bis) { fs.rmSync(f, { force: true }); return { ok: true }; }
  if (!DATUM.test(String(bis)) || String(bis) <= heute()) return { ok: false, error: 'Bitte ein Datum in der Zukunft wählen.' };
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${bis}\n`);
  fs.renameSync(tmp, f);
  return { ok: true };
}

function einstellen(patch, studio = studioPfad()) {
  const alt = einstellungen(studio);
  if (!istObjekt(patch)) return { ok: false, error: 'Ungültige Einstellungen.' };
  const p = patch;
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
  if ('fokus' in p) neu.fokus = kurz(p.fokus || '', MAX_FOKUS);
  schreiben(datei(studio, 'radar_einstellungen.json'), neu);
  return { ok: true };
}

// Gleiche Regel wie link_ok in pipeline/einstellungen.py: nur öffentliche Adressen, nie localhost oder Geräte im eigenen Netz.
function linkOk(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(u.protocol) || !host || host === 'localhost' || /\.(localhost|local)$/.test(host)) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (host.includes(':')) return !/^(::1?|f[cd]|fe[89ab]|::ffff:)/.test(host);
  return host.includes('.');
}

function wunschHinzu(thema, link, studio = studioPfad()) {
  const t = kurz(thema, MAX_THEMA);
  const l = String(link || '').trim();
  if (!t) return { ok: false, error: 'Bitte ein Thema eintragen.' };
  if (l && !linkOk(l)) return { ok: false, error: 'Der Link muss eine öffentliche Internetadresse sein (https://…).' };
  return wuenscheAendern(studio, (liste) => {
    if (liste.length >= MAX_WUENSCHE) return { ok: false, error: `Höchstens ${MAX_WUENSCHE} Wunschthemen in der Warteschlange.` };
    if (liste.some((w) => String(w.thema || '').toLowerCase() === t.toLowerCase())) return { ok: false, error: 'Dieses Thema steht schon auf deiner Liste.' };
    return { ok: true, liste: [...liste, { id: crypto.randomUUID(), thema: t, link: l, angelegt: Date.now() }] };
  });
}

function wunschEntfernen(id, studio = studioPfad()) {
  return wuenscheAendern(studio, (liste) => ({ ok: true, liste: liste.filter((w) => w.id !== id) }));
}

// Nach oben schieben = kommt beim nächsten Lauf dran. Setzt auch gescheiterte Versuche zurück („nochmal versuchen“).
function wunschVor(id, studio = studioPfad()) {
  return wuenscheAendern(studio, (liste) => {
    const w = liste.find((x) => x.id === id);
    if (!w) return { ok: false, error: 'Dieses Wunschthema gibt es nicht mehr.' };
    return { ok: true, liste: [{ ...w, versuche: 0 }, ...liste.filter((x) => x.id !== id)] };
  });
}

function sperren(thema, an, studio = studioPfad()) {
  const t = kurz(thema, 300);
  if (!t) return { ok: false, error: 'Kein Thema angegeben.' };
  const roh = lesen(datei(studio, 'themen_gesperrt.json'), []);
  if (!Array.isArray(roh)) return { ok: false, error: 'Die Sperrliste ist gerade nicht lesbar – bitte gleich nochmal versuchen.' };
  const liste = roh.filter((x) => x !== t);
  schreiben(datei(studio, 'themen_gesperrt.json'), an ? [...liste, t] : liste);
  return { ok: true };
}

module.exports = { uebersicht, aktionen, aktionSetzen, pauseSetzen, einstellen, wunschHinzu, wunschEntfernen, wunschVor, sperren, einstellungen, linkOk,
  STANDARD, QUELLEN_IDS, MAX_VERSUCHE };
