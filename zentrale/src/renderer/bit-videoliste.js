// Reiter „Videos“ der Seite Bit-Videos: alle Videos mit Posting-Stand, ein Klick zeigt das Video,
// ein Knopf postet auf allen Plattformen. Nutzt die Helfer aus app.js (h, fill, ui, api, sendMessage …).

const BV_PLATTFORMEN = [['tiktok', 'TikTok', 'TT'], ['insta', 'Instagram', 'IG'], ['youtube', 'YouTube', 'YT']];
const BV_FILTER = [['offen', 'Noch nicht gepostet'], ['gepostet', 'Gepostet'], ['alle', 'Alle']];
const bv = { liste: null, youtube: null, tabs: null, filter: 'offen', auswahl: null, fortschritt: null, meldung: null, fehler: false };

const bvMedien = (name) => `bitvideo://out/${name}`;
const bvNr = (v) => `#${String(v.nr).padStart(3, '0')}`;
const bvSchluessel = (v) => v.ordner || v.id;

// Wo steht ein Video? Eine klare Zeile für die Liste.
function bvStand(v) {
  if (v.doppelt) return { text: 'Nummer doppelt', farbe: 'red' };
  if (v.status === 'abgelehnt') return { text: 'Abgelehnt', farbe: '' };
  if (!v.datei) return { text: 'In Arbeit', farbe: '' };
  const n = BV_PLATTFORMEN.filter(([p]) => v.gepostet.includes(p)).length;
  if (n === BV_PLATTFORMEN.length) return { text: 'Überall gepostet', farbe: 'green' };
  if (n) return { text: `${n} von 3 gepostet`, farbe: 'amber' };
  if (v.status === 'wartet') return { text: 'Noch nicht freigegeben', farbe: 'amber' };
  return { text: 'Bereit zum Posten', farbe: 'blue' };
}
const bvFertig = (v) => BV_PLATTFORMEN.every(([p]) => v.gepostet.includes(p));
const bvPostbar = (v) => !!v.datei && !v.doppelt && v.status !== 'abgelehnt';
const bvOffen = (v) => BV_PLATTFORMEN.map(([p]) => p).filter((p) => !v.gepostet.includes(p));

function bvGefiltert() {
  const l = bv.liste || [];
  if (bv.filter === 'gepostet') return l.filter(bvFertig);
  if (bv.filter === 'offen') return l.filter((v) => !bvFertig(v) && v.status !== 'abgelehnt');
  return l;
}

async function bvLaden() {
  let r;
  try { r = await api.bitVideos(); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (!r || !r.ok) { bv.meldung = (r && r.error) || 'Bit-Videos nicht lesbar.'; bv.fehler = true; renderBitBody(); return; }
  if (!changed('bvListe', [r.videos, r.youtube, r.tabs])) return;
  bv.liste = r.videos;
  bv.youtube = r.youtube;
  bv.tabs = r.tabs;
  if (bv.youtube && !bv.youtube.laeuft) bv.fortschritt = null;
  renderBitBody();
}

function bvMelden(text, fehler = false) {
  bv.meldung = text;
  bv.fehler = fehler;
  renderBitBody();
}

async function bvPosten(v, plattformen) {
  let r;
  try { r = await api.bitPosten(v.id, plattformen); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (!r || r.cancelled) return;
  if (!r.ok) { bvMelden(r.error || 'Das ging nicht.', true); return; }
  if (r.youtube) { bv.fortschritt = { video: v.id, progress: 0 }; bvMelden(`YouTube: Video ${v.nr} wird hochgeladen …`); }
  // Instagram/TikTok: Claude in einem eigenen Chat – der bisherige läuft im Hintergrund weiter.
  if (r.auftrag) { await newSession(); sendMessage(r.auftrag); }
}

async function bvAbhaken(v, p, an) {
  const name = BV_PLATTFORMEN.find(([x]) => x === p)[1];
  if (!an && !confirm(`Video ${v.nr} auf ${name} wieder als „nicht gepostet“ markieren?\n\nDas ändert nur die Liste – der Beitrag selbst bleibt online.`)) return;
  const r = await api.bitGepostet(v.id, [p], an);
  if (!r || !r.ok) bvMelden((r && r.error) || 'Das ging nicht.', true);
  else { ui.sig.bvListe = null; await bvLaden(); }
}

function bvPunkte(v) {
  return h('span', { class: 'bv-dots', 'aria-label': BV_PLATTFORMEN.map(([p, name]) => `${name} ${v.gepostet.includes(p) ? 'gepostet' : 'offen'}`).join(', ') },
    BV_PLATTFORMEN.map(([p, name, kurz]) => h('span', { class: `bv-dot${v.gepostet.includes(p) ? ' an' : ''}`, title: `${name}: ${v.gepostet.includes(p) ? 'gepostet' : 'noch nicht'}`, text: kurz })));
}

function bvZeile(v) {
  const st = bvStand(v);
  const aktiv = bv.auswahl === bvSchluessel(v);
  return h('button', { class: `bv-zeile${aktiv ? ' aktiv' : ''}`, 'aria-pressed': String(aktiv), 'data-focus': `bv:${bvSchluessel(v)}`,
    onClick: () => { bv.auswahl = bvSchluessel(v); renderBitBody(); } },
  v.cover ? h('img', { class: 'bv-thumb', src: bvMedien(`${v.id}_cover.png`), alt: '', loading: 'lazy' }) : h('span', { class: 'bv-thumb leer', 'aria-hidden': 'true' }),
  h('span', { class: 'bv-text' },
    h('span', { class: 'bv-titel', text: v.thema }),
    h('span', { class: 'bv-meta' }, h('span', { class: 'bv-nr', text: bvNr(v) }), bvPunkte(v))),
  h('span', { class: `pill ${st.farbe}`, text: st.text }));
}

function bvTextBox(v, p) {
  const t = v.texte[p];
  if (!t) return h('p', { class: 'hint', text: 'Kein Post-Text vorhanden.' });
  const kopieren = h('button', { class: 'link', onClick: async () => {
    try { await navigator.clipboard.writeText(p === 'youtube' ? `${t.titel}\n\n${t.text}` : t.text); kopieren.textContent = 'Kopiert ✓'; setTimeout(() => { kopieren.textContent = 'Kopieren'; }, 1200); }
    catch { alert('Kopieren ging nicht.'); }
  } }, 'Kopieren');
  return h('details', { class: 'bv-textbox' }, h('summary', { text: 'Text ansehen' }),
    p === 'youtube' && t.titel ? h('div', { class: 'bv-yt-titel', text: t.titel }) : null,
    h('pre', { class: 'bv-posttext', text: t.text }), kopieren);
}

function bvPlattformZeile(v, p, name) {
  const an = v.gepostet.includes(p);
  const wann = v.gepostetAm[p] ? ` am ${v.gepostetAm[p].slice(8, 10)}.${v.gepostetAm[p].slice(5, 7)}. ${v.gepostetAm[p].slice(11, 16)}` : '';
  const laeuft = p === 'youtube' && bv.fortschritt && bv.fortschritt.video === v.id;
  const knoepfe = [];
  if (an) {
    if (p === 'youtube' && v.youtubeUrl) knoepfe.push(h('button', { class: 'link', onClick: () => api.openExternal(v.youtubeUrl) }, 'Ansehen'));
    knoepfe.push(h('button', { class: 'link muted', onClick: () => bvAbhaken(v, p, false) }, 'Rückgängig'));
  } else if (laeuft) {
    knoepfe.push(h('span', { class: 'bv-progress', role: 'progressbar', 'aria-valuenow': String(Math.round(bv.fortschritt.progress * 100)) },
      h('span', { style: { width: `${Math.round(bv.fortschritt.progress * 100)}%` } })));
  } else {
    if (bvPostbar(v)) knoepfe.push(h('button', { class: 'btn ghost small', onClick: () => bvPosten(v, [p]) }, `Nur ${name}`));
    if (!v.doppelt) knoepfe.push(h('button', { class: 'link muted', title: 'Hast du es schon selbst gepostet? Dann hier abhaken.', onClick: () => bvAbhaken(v, p, true) }, 'Schon gepostet'));
  }
  return h('div', { class: 'bv-plattform' },
    h('div', { class: 'bv-plattform-kopf' },
      h('span', { class: `bv-check${an ? ' an' : ''}`, 'aria-hidden': 'true', text: an ? '✓' : '' }),
      h('span', { class: 'grow' }, h('span', { class: 'bv-pname', text: name }), h('span', { class: 'sub', text: an ? ` gepostet${wann}` : laeuft ? ' wird hochgeladen …' : ' noch nicht' })),
      ...knoepfe),
    bvTextBox(v, p));
}

function bvHinweis(v) {
  if (v.doppelt) return `Die Nummer ${v.nr} gibt es zweimal (${v.ordner}). Erst einen der beiden Ordner umbenennen – sonst ist unklar, welches Video gepostet wird.`;
  if (v.status === 'abgelehnt') return `Abgelehnt${v.grund ? `: ${v.grund}` : ''}. Wird nicht gepostet.`;
  if (!v.datei) return 'Das Video wird noch gebaut – posten geht, sobald die fertige Datei da ist.';
  if (v.status === 'wartet') return 'Noch nicht in Telegram freigegeben. Wenn du hier postest, gilt es als freigegeben.';
  return null;
}

function bvDetail(v) {
  if (!v) return h('div', { class: 'card empty', text: 'Wähl links ein Video aus.' });
  const offen = bvOffen(v);
  const st = bvStand(v);
  const hinweis = bvHinweis(v);
  const alle = bvPostbar(v) && offen.length
    ? h('button', { class: 'btn bv-alle', 'data-focus': 'bv-alle', disabled: !!(bv.fortschritt && offen.includes('youtube')),
      onClick: () => bvPosten(v, offen) }, offen.length === 3 ? 'Auf allen Plattformen posten' : `Auf ${offen.map((p) => BV_PLATTFORMEN.find(([x]) => x === p)[1]).join(' + ')} posten`)
    : null;
  return h('div', { class: 'card bv-detail' }, h('div', { class: 'bv-detail-innen' },
    h('div', { class: 'bv-film' }, v.datei
      ? h('video', { src: bvMedien(`${v.id}.mp4`), poster: v.cover ? bvMedien(`${v.id}_cover.png`) : null, controls: true, preload: 'metadata', playsinline: true })
      : h('div', { class: 'bv-film-leer', text: 'Noch kein fertiges Video' })),
    h('div', { class: 'bv-info' },
      h('div', { class: 'bv-kopf' }, h('span', { class: 'bv-nr', text: bvNr(v) }), h('span', { class: `pill ${st.farbe}`, text: st.text })),
      h('h2', { class: 'bv-detail-titel', text: v.thema }),
      hinweis ? h('p', { class: `bv-hinweis${v.doppelt ? ' fehler' : ''}`, text: hinweis }) : null,
      alle,
      alle ? h('p', { class: 'hint', text: `YouTube lädt die Zentrale direkt hoch. Instagram und TikTok postet Claude in den Web-Tabs${bv.tabs && bv.tabs.insta ? ` „${bv.tabs.insta}“` : ''}${bv.tabs && bv.tabs.tiktok ? ` und „${bv.tabs.tiktok}“` : ''} – vorher prüft er das Konto.${v.kiLabel ? ' Immer mit KI-Label.' : ''}` }) : null,
      h('div', { class: 'bv-plattformen' }, BV_PLATTFORMEN.map(([p, name]) => bvPlattformZeile(v, p, name))),
      v.aktion ? h('p', { class: 'hint', text: `Kommentar-Wort im Video: ${v.aktion.stichwort}` }) : null,
      v.datei ? h('button', { class: 'link', onClick: () => api.fsReveal(v.datei) }, 'Im Finder zeigen') : null)));
}

function bvAnsicht() {
  if (!bv.liste) return [h('div', { class: 'card empty', text: 'Lädt …' })];
  const liste = bvGefiltert();
  if (!bv.auswahl || !bv.liste.some((v) => bvSchluessel(v) === bv.auswahl)) bv.auswahl = liste.length ? bvSchluessel(liste[0]) : null;
  const gewaehlt = bv.liste.find((v) => bvSchluessel(v) === bv.auswahl) || null;
  const offenZahl = bv.liste.filter((v) => !bvFertig(v) && bvPostbar(v)).length;
  const fertigZahl = bv.liste.filter(bvFertig).length;
  const zahl = { offen: offenZahl, gepostet: fertigZahl, alle: bv.liste.length };
  const meldung = bv.meldung ? h('div', { class: `notice bit-meldung${bv.fehler ? ' bit-fehler' : ''}`, role: 'status', text: bv.meldung }) : null;
  const filter = h('div', { class: 'segmented bv-filter', role: 'group', 'aria-label': 'Videos filtern' },
    BV_FILTER.map(([id, name]) => h('button', { 'aria-pressed': String(bv.filter === id), 'data-focus': `bv-f:${id}`,
      onClick: () => { bv.filter = id; bv.auswahl = null; renderBitBody(); } }, `${name} (${zahl[id]})`)));
  const youtubeHinweis = bv.youtube && !bv.youtube.verbunden
    ? h('div', { class: 'notice', text: bv.youtube.kanal ? `YouTube ist mit „${bv.youtube.kanal}“ verbunden, nicht mit Bits Kanal.` : 'YouTube ist nicht verbunden (Verbindungen → YouTube).' }) : null;
  return [meldung, youtubeHinweis, filter,
    h('div', { class: 'bv-split' },
      h('div', { class: 'bv-liste card' }, liste.length ? liste.map(bvZeile) : h('div', { class: 'empty', text: bv.filter === 'offen' ? 'Alles gepostet 🎉' : 'Keine Videos.' })),
      bvDetail(gewaehlt))];
}

// window.zentrale statt api: app.js (mit „api“) lädt erst nach dieser Datei.
window.zentrale.onBitChanged(() => { ui.sig.bvListe = null; if (ui.view === 'bitvideos') bvLaden(); });
window.zentrale.onBitProgress((d) => {
  bv.fortschritt = d;
  if (ui.view === 'bitvideos' && bit.reiter === 'videos') renderBitBody();
});
