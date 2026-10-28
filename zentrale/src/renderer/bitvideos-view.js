// Ansicht „Bit-Videos“: worüber Bit jeden Tag ein Video macht – Status, Wunschthemen, Radar-Themen, Suchradius, letzte Videos.
// Alles wirkt ab dem nächsten automatischen Lauf (täglich 10:00). Nutzt die Helfer aus app.js (h, fill, ui, api …).

const bit = { daten: null, komm: null, meldung: null, fehler: false, timer: null, meldungTimer: null, entwurf: {} };
const BIT_POLL_MS = 10000;      // Radar und Telegram-Freigaben ändern die Dateien auch von außen
const BIT_MELDUNG_MS = 4000;
const BIT_VIDEOS_ANZAHL = 8;
const FORMAT_NAME = { superkraft: 'Neue Fähigkeit', 'tool-ersatz': 'Spart Geld', 'github-fund': 'GitHub-Fund',
  'top-liste': 'Top-Liste', 'trend-erklaert': 'Erklärt', raum: 'Raum-Video' };
const VIDEO_STATUS = { wartet: ['wartet auf Freigabe', 'amber'], freigegeben: ['freigegeben', 'green'],
  abgelehnt: ['abgelehnt', ''], 'in Arbeit': ['in Arbeit', ''] };
const PLATTFORM_KURZ = { insta: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
const PUNKTE_NAME = { superkraft: 'Superkraft', spart: 'Ersparnis', wow: 'Wow', einfach: 'einfach', aktuell: 'aktuell' };

const datumDE = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const morgenISO = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString('sv-SE'); };

async function loadBitVideos() {
  if (ui.view !== 'bitvideos') { clearInterval(bit.timer); bit.timer = null; return; }
  let res;
  let kres;
  try { [res, kres] = await Promise.all([api.bit(), api.kommentare()]); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
  if (!res) return;
  if (!res.ok) { bit.daten = null; zeigeMeldung(res.error, true); return; }
  if (bit.fehler) zeigeMeldung(null);   // alte Ladefehler-Meldung weg, sobald es wieder geht
  const komm = kres && kres.ok ? kres.data : null;
  if (!changed('bitvideos', [res.data, komm, ui.state.claude.found])) return;
  bit.daten = res.data;
  bit.komm = komm;
  renderBitBody();
}

function zeigeMeldung(text, fehler = false) {
  bit.meldung = text;
  bit.fehler = !!text && fehler;
  clearTimeout(bit.meldungTimer);
  if (text && !fehler) bit.meldungTimer = setTimeout(() => { bit.meldung = null; renderBitBody(); }, BIT_MELDUNG_MS);
  renderBitBody();
}

// Führt eine Änderung aus und zeigt danach Erfolg oder Fehler. `fertig` leert nur bei Erfolg die genannten Eingabefelder.
async function bitAktion(aufruf, okText, fertig = []) {
  let res;
  try { res = await aufruf(); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
  const ok = !!(res && res.ok);
  if (ok) fertig.forEach((id) => { delete bit.entwurf[id]; });
  ui.sig.bitvideos = null;
  await loadBitVideos();
  zeigeMeldung(ok ? okText : (res && res.error) || 'Das hat nicht geklappt.', !ok);
}

// Eingabefeld, dessen ungespeicherter Text ein Neuzeichnen überlebt (Poll, Schalter-Klick …).
function bitFeld(tag, props, gespeichert = '') {
  const el = h(tag, { ...props, 'data-focus': props.id });
  el.value = props.id in bit.entwurf ? bit.entwurf[props.id] : gespeichert;
  const merken = () => { bit.entwurf[props.id] = el.value; };
  el.addEventListener('input', merken);
  el.addEventListener('change', merken);
  return el;
}

function bitSchritt(nr, titel, text) {
  return h('div', { class: 'section-head wrap' },
    h('h2', { text: `${nr}. ${titel}` }),
    text ? h('span', { class: 'sub bit-sub', text }) : null);
}

function bitStatusZeile(symbol, text) {
  return h('div', { class: 'title' }, h('span', { 'aria-hidden': 'true', text: `${symbol} ` }), text);
}

// 1. Läuft die Automatik, und was kommt als Nächstes?
function bitStatus(d) {
  const wunsch = d.wuensche.find((w) => !w.uebersprungen);
  const naechstes = wunsch ? `dein Wunschthema „${wunsch.thema}“` : 'das beste neue Thema vom Radar';
  if (d.pauseBis) {
    return h('div', { class: 'card form' },
      h('div', { class: 'full bit-status' },
        bitStatusZeile('⏸', `Pausiert bis ${datumDE(d.pauseBis)}`),
        h('div', { class: 'hint', text: `Ab dem ${datumDE(d.pauseBis)} macht Bit wieder jeden Tag um 10:00 ein Video. Als Nächstes dran: ${naechstes}.` })),
      h('div', { class: 'actions full' },
        h('button', { class: 'btn', 'data-focus': 'bit-weiter', onClick: () => bitAktion(() => api.bitPause(null), 'Pause beendet – der nächste Lauf ist wieder um 10:00.') }, 'Pause beenden')));
  }
  const bis = bitFeld('input', { id: 'bit-pause-bis', type: 'date', min: morgenISO(), required: true });
  return h('form', { class: 'card form', onSubmit: (e) => {
    e.preventDefault();
    bitAktion(() => api.bitPause(bis.value), `Pausiert bis ${datumDE(bis.value)}.`, ['bit-pause-bis']);
  } },
  h('div', { class: 'full bit-status' },
    bitStatusZeile('▶', 'Läuft – jeden Tag um 10:00 ein neues Video'),
    h('div', { class: 'hint', text: `Als Nächstes dran: ${naechstes}. Das fertige Video kommt zur Freigabe in Telegram.` })),
  h('div', { class: 'field' }, h('label', { for: 'bit-pause-bis', text: 'Pausieren bis (z. B. wenn das Stimmen-Guthaben leer ist)' }), bis),
  h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn ghost' }, 'Pausieren')));
}

function bitWunschZeile(w, i, erster) {
  const pill = w.uebersprungen ? h('span', { class: 'pill amber', text: `${w.versuche}× gescheitert` })
    : h('span', { class: `pill ${i === erster ? 'blue' : ''}`, text: i === erster ? 'als Nächstes' : `${i + 1}.` });
  let vor = null;
  if (w.uebersprungen) {
    vor = h('button', { class: 'link', 'aria-label': `Nochmal versuchen: ${w.thema}`, 'data-focus': `bit-w-vor:${w.id}`,
      onClick: () => bitAktion(() => api.bitWunschVor(w.id), 'Wird beim nächsten Lauf nochmal versucht.') }, 'Nochmal versuchen');
  } else if (i !== erster) {
    vor = h('button', { class: 'link', 'aria-label': `Vorziehen: ${w.thema}`, 'data-focus': `bit-w-vor:${w.id}`,
      onClick: () => bitAktion(() => api.bitWunschVor(w.id), 'Kommt als Nächstes dran.') }, 'Vorziehen');
  }
  return h('div', { class: 'row bit-row' }, pill,
    h('div', { class: 'grow' }, h('div', { class: 'title', text: w.thema }),
      h('div', { class: 'sub', text: w.uebersprungen ? 'wird übersprungen, bis du es nochmal versuchen lässt' : (w.link || 'ohne Link') })),
    vor,
    h('button', { class: 'link', 'aria-label': `Entfernen: ${w.thema}`, 'data-focus': `bit-w-weg:${w.id}`,
      onClick: () => bitAktion(() => api.bitWunschRemove(w.id), 'Entfernt.') }, 'Entfernen'));
}

// 2. Eigene Themen – kommen vor dem Radar dran.
function bitWuensche(d) {
  const thema = bitFeld('input', { id: 'bit-w-thema', type: 'text', maxlength: '200', required: true, placeholder: 'z. B. Claude kann jetzt Excel-Tabellen bauen' });
  const link = bitFeld('input', { id: 'bit-w-link', type: 'url', placeholder: 'https://… (optional, aber empfohlen)' });
  const form = h('form', { class: 'card form', onSubmit: (e) => {
    e.preventDefault();
    bitAktion(() => api.bitWunschAdd(thema.value, link.value), 'Wunschthema gespeichert.', ['bit-w-thema', 'bit-w-link']);
  } },
  h('div', { class: 'field' }, h('label', { for: 'bit-w-thema', text: 'Thema' }), thema),
  h('div', { class: 'field' }, h('label', { for: 'bit-w-link', text: 'Link zur Quelle' }), link),
  h('div', { class: 'actions full' },
    h('span', { class: 'hint', text: 'Mit Link liest Bit die Quelle und erklärt sie genau. Ohne Link bleibt er bei sicheren Allgemeinfakten.' }),
    h('span', { class: 'spacer' }), h('button', { type: 'submit', class: 'btn' }, 'Hinzufügen')));
  const erster = d.wuensche.findIndex((w) => !w.uebersprungen);
  const liste = d.wuensche.length ? h('div', { class: 'card list' }, d.wuensche.map((w, i) => bitWunschZeile(w, i, erster))) : null;
  return [form, liste];
}

function bitPunkte(t) {
  const teile = Object.entries(PUNKTE_NAME).map(([k, name]) => `${name} ${t.werte[k] ?? '–'}`).join(' · ');
  return h('span', { class: 'pill', title: teile, 'aria-label': `${t.summe} von 25 Punkten (${teile})`, text: `★ ${t.summe}/25` });
}

function bitSperrKnopf(t) {
  if (t.gemacht) return null;   // schon gemachte Themen schlägt das Radar ohnehin nicht mehr vor
  if (t.gesperrt) {
    return h('button', { class: 'link', 'aria-label': `Freigeben: ${t.thema}`, 'data-focus': `bit-r-sperre:${t.thema}`,
      onClick: () => bitAktion(() => api.bitSperren(t.thema, false), 'Wieder freigegeben.') }, 'Freigeben');
  }
  return h('button', { class: 'link danger', 'aria-label': `Sperren: ${t.thema}`, 'data-focus': `bit-r-sperre:${t.thema}`,
    onClick: () => {
      if (!confirm(`„${t.thema}“ sperren?\n\nDas Radar schlägt dieses Thema dann nie wieder vor.`)) return;
      bitAktion(() => api.bitSperren(t.thema, true), 'Gesperrt – kommt nie wieder.');
    } }, 'Sperren');
}

// 3. Was das Radar zuletzt gefunden hat.
function bitRadar(d) {
  const r = d.radar;
  if (!r.themen.length) return h('div', { class: 'card empty', text: 'Noch keine Themenliste. Das Radar läuft automatisch vor jedem Video.' });
  return h('div', { class: 'card list' }, r.themen.map((t) => {
    const wunschLink = t.quellen.find((q) => /^https?:\/\//i.test(q)) || '';
    const frei = !t.gemacht && !t.gesperrt && !t.vorgemerkt;
    return h('div', { class: 'row bit-row' },
      bitPunkte(t),
      h('div', { class: 'grow' },
        h('div', { class: 'title', text: t.thema }),
        h('div', { class: 'sub clamp', text: `${FORMAT_NAME[t.format] || t.format}${t.hook ? ` · „${t.hook}“` : ''}` })),
      t.gemacht ? h('span', { class: 'pill green', text: 'schon gemacht' }) : null,
      t.gesperrt ? h('span', { class: 'pill', text: 'gesperrt' }) : null,
      t.vorgemerkt ? h('span', { class: 'pill blue', text: 'auf deiner Liste' }) : null,
      frei ? h('button', { class: 'link', 'aria-label': `Als Wunsch übernehmen: ${t.thema}`, 'data-focus': `bit-r-wunsch:${t.thema}`,
        onClick: () => bitAktion(() => api.bitWunschAdd(t.thema, wunschLink), 'Als Wunschthema übernommen.') }, 'Als Wunsch') : null,
      bitSperrKnopf(t));
  }));
}

// 4. Wo und wie das Radar sucht.
function bitSuchradius(d) {
  const e = d.einstellungen;
  const quellen = h('div', { class: 'card list' }, d.quellen.map((q) => {
    const an = !e.quellen_aus.includes(q.id);
    return h('div', { class: 'row bit-quelle' },
      h('div', { class: 'grow' }, h('div', { class: 'title', text: q.name }), h('div', { class: 'sub', text: q.info })),
      h('button', { class: 'switch', role: 'switch', 'aria-checked': String(an), 'aria-label': q.name, 'data-focus': `bit-q:${q.id}`,
        onClick: () => {
          const aus = an ? [...e.quellen_aus, q.id] : e.quellen_aus.filter((x) => x !== q.id);
          bitAktion(() => api.bitSettings({ quellen_aus: aus }), `${q.name} ist jetzt ${an ? 'aus' : 'an'}.`);
        } }));
  }));
  const subs = bitFeld('input', { id: 'bit-subs', type: 'text' }, e.reddit_subs.join(', '));
  const takt = h('select', { id: 'bit-takt', 'data-focus': 'bit-takt' }, Array.from({ length: 11 }, (_, n) => h('option', { value: String(n),
    text: n === 0 ? 'nie bevorzugen' : n === 1 ? 'jedes Video' : `jedes ${n}. Video` })));
  takt.value = 'bit-takt' in bit.entwurf ? bit.entwurf['bit-takt'] : String(e.github_alle);
  takt.addEventListener('change', () => { bit.entwurf['bit-takt'] = takt.value; });
  const fokus = bitFeld('textarea', { id: 'bit-fokus', rows: '2', maxlength: '300', placeholder: 'z. B. mehr Bild- und Video-KI, weniger Programmier-Themen' }, e.fokus);
  const form = h('form', { class: 'card form', onSubmit: (ev) => {
    ev.preventDefault();
    bitAktion(() => api.bitSettings({ reddit_subs: subs.value, github_alle: Number(takt.value), fokus: fokus.value }),
      'Gespeichert – gilt ab dem nächsten Lauf.', ['bit-subs', 'bit-takt', 'bit-fokus']);
  } },
  h('div', { class: 'field full' }, h('label', { for: 'bit-fokus', text: 'Worauf soll Bit besonders achten?' }), fokus,
    h('span', { class: 'hint', text: 'Grundregel bleibt immer: KI-Bezug und echter Nutzen für normale Leute.' })),
  h('div', { class: 'field' }, h('label', { for: 'bit-subs', text: 'Reddit-Subreddits' }), subs,
    h('span', { class: 'hint', text: 'Mit Komma trennen, ohne „r/“.' })),
  h('div', { class: 'field' }, h('label', { for: 'bit-takt', text: 'GitHub-Fund bevorzugen' }), takt,
    h('span', { class: 'hint', text: 'Nur wenn der Fund fast so gut ist wie das beste Thema.' })),
  h('div', { class: 'actions full' }, h('button', { type: 'submit', class: 'btn ghost' }, 'Speichern')));
  return [quellen, form];
}

// 5. Die letzten Videos.
function bitVideos(d) {
  if (!d.videos.length) return h('div', { class: 'card empty', text: 'Noch keine Videos.' });
  return h('div', { class: 'card list' }, d.videos.slice(0, BIT_VIDEOS_ANZAHL).map((v) => {
    const [label, farbe] = VIDEO_STATUS[v.status] || [v.status, ''];
    const wort = v.aktion ? h('span', { class: `pill ${v.aktion.aktiv ? 'blue' : ''}`, title: 'Stichwort für die Kommentare', text: `💬 ${v.aktion.stichwort}` }) : null;
    const gepostet = v.gepostet.length ? `gepostet: ${v.gepostet.map((p) => PLATTFORM_KURZ[p] || p).join(', ')}` : 'noch nicht gepostet';
    const wann = /^\d{4}-\d{2}-\d{2}/.test(v.zeit) ? ` · ${v.zeit.slice(8, 10)}.${v.zeit.slice(5, 7)}.` : '';
    return h('div', { class: 'row bit-row' },
      h('span', { class: 'pill', text: `#${String(v.nr).padStart(3, '0')}` }),
      h('div', { class: 'grow' }, h('div', { class: 'title', text: v.thema }), h('div', { class: 'sub', text: gepostet + wann })),
      wort,
      h('span', { class: `pill ${farbe}`, text: label }));
  }));
}

function renderBitBody() {
  const box = $('#bit-body');
  if (!box) return;
  const d = bit.daten;
  const meldung = bit.meldung ? h('div', { class: `notice bit-meldung${bit.fehler ? ' bit-fehler' : ''}`, role: 'status', text: bit.meldung }) : null;
  if (!d) { fill(box, meldung || h('div', { class: 'card empty', text: 'Lädt …' })); return; }
  const radarText = d.radar.datum ? `Stand ${datumDE(d.radar.datum)}. Punkte: Superkraft, Ersparnis, Wow, einfach, aktuell – je bis 5.` : '';
  keepFocus(() => fill(box, meldung,
    h('section', { class: 'section' }, bitSchritt(1, 'Läuft die Automatik?'), bitStatus(d)),
    h('section', { class: 'section' }, bitSchritt(2, 'Kommentare & Antworten',
      'Bit sagt im Video „Schreib WORT in die Kommentare“. Wer das macht, landet hier und bekommt die Antwort des Videos.'), bitKommentare(bit.komm)),
    h('section', { class: 'section' }, bitSchritt(3, 'Deine Wunschthemen', 'Kommen vor dem Radar dran – das oberste als Nächstes.'), bitWuensche(d)),
    h('section', { class: 'section' }, bitSchritt(4, 'Themen vom Radar', radarText), bitRadar(d)),
    h('section', { class: 'section' }, bitSchritt(5, 'Wo Bit nach Themen sucht', 'Schalter wirken sofort, die Felder darunter erst mit „Speichern“.'), bitSuchradius(d)),
    h('section', { class: 'section' }, bitSchritt(6, 'Letzte Videos', `die letzten ${BIT_VIDEOS_ANZAHL}`), bitVideos(d))));
}

function renderBitVideos() {
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Bit-Videos' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: () => { ui.sig.bitvideos = null; loadBitVideos(); } }, 'Aktualisieren')),
    h('p', { class: 'date', text: 'Hier steuerst du, worüber Bit jeden Tag ein Video macht. Änderungen gelten ab dem nächsten Lauf.' }),
    h('div', { id: 'bit-body', class: 'section' }));
  bit.meldung = null;
  bit.fehler = false;
  ui.sig.bitvideos = null;
  renderBitBody();
  loadBitVideos();
  clearInterval(bit.timer);
  bit.timer = setInterval(loadBitVideos, BIT_POLL_MS);
}
