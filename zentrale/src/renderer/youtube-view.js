// Verbindungen → YouTube: Anleitung für das Google-Cloud-Projekt, Datei wählen, im Browser anmelden.
// Danach lädt der Planer Videos über die offizielle Schnittstelle hoch. Nutzt die Helfer aus app.js und connections-view.js.

const yt = { status: null, busy: null, message: null, file: null, loading: false, at: 0 };
const YT_STALE_MS = 30000; // so alt darf der angezeigte Status sein – z. B. hat ein Upload im Planer den Zugang verloren

async function loadYouTube() {
  yt.loading = true;
  try { yt.status = (await api.ytStatus()) || yt.status; } catch (e) { yt.message = e.message || 'Der YouTube-Status ließ sich nicht laden.'; }
  yt.loading = false;
  yt.at = Date.now(); // auch nach einem Fehler – sonst lädt jedes Zeichnen sofort wieder (Endlosschleife)
  if (ui.view === 'connections') renderConnections();
}

async function ytAction(id, fn) {
  yt.busy = id; yt.message = null; renderConnections();
  try {
    const r = await fn();
    if (r && r.superseded) return; // eine neu gestartete Anmeldung übernimmt Knopf und Meldung
    if (r && r.error) yt.message = r.error;
    else if (r && r.message) yt.message = r.message;
  } catch (e) { yt.message = e.message; }
  yt.busy = null;
  await loadYouTube();
}

const YT_GUIDE = [
  ['Projekt anlegen', 'Bei Google Cloud ein neues Projekt „Zentrale“ anlegen (kostenlos, keine Karte nötig).', 'https://console.cloud.google.com/projectcreate'],
  ['Schnittstelle einschalten', 'Im Projekt „YouTube Data API v3“ öffnen und auf „Aktivieren“ klicken.', 'https://console.cloud.google.com/apis/library/youtube.googleapis.com'],
  ['App-Angaben', 'Unter „Google Auth Platform“ auf „Los gehts“: App-Name „Zentrale“, deine E-Mail, Zielgruppe „Extern“. Danach unter „Zielgruppe“ auf „App veröffentlichen“ – sonst läuft die Anmeldung nach 7 Tagen ab.', 'https://console.cloud.google.com/auth/overview'],
  ['Anmeldedaten', 'Unter „Clients“ → „Client erstellen“ → Anwendungstyp „Desktop-App“, Name „Zentrale“. Dann die JSON-Datei herunterladen.', 'https://console.cloud.google.com/auth/clients'],
  ['Hier verbinden', 'Unten „Datei wählen“, dann „Mit YouTube anmelden“. Im Browser das Konto mit deinem Kanal wählen. Bei „Google hat diese App nicht überprüft“ auf „Erweitert“ → „Weiter zu Zentrale“ – das ist bei deiner eigenen App normal.', null],
];

function ytGuide() {
  return h('ol', { class: 'yt-guide' }, YT_GUIDE.map(([title, text, url]) => h('li', {},
    h('div', { class: 'title', text: title }), h('div', { class: 'sub', text }),
    url ? h('button', { class: 'link', onClick: () => api.openExternal(url) }, 'Öffnen ↗') : null)));
}

// Von der Zentrale hochgeladene Videos – ansehen oder löschen (macOS fragt vor dem Löschen noch einmal).
const YT_PRIVACY = { private: 'privat', unlisted: 'nicht gelistet', public: 'öffentlich' };
function ytUploads(st, btn, connect) {
  const list = st.uploads || [];
  if (!list.length) return null;
  return h('div', { class: 'yt-uploads' },
    h('div', { class: 'title', text: 'Von der Zentrale hochgeladen' }),
    !st.canDelete ? h('div', { class: 'sub' }, 'Zum Löschen braucht die Zentrale ein erweitertes Recht. ',
      btn('connect', 'Neu anmelden', connect, 'link')) : null,
    h('div', { class: 'card list' }, list.map((u) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title', text: u.title || u.id }),
        h('div', { class: 'sub', text: `${new Date(u.at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })} · ${YT_PRIVACY[u.privacy] || u.privacy || '–'}` })),
      h('button', { class: 'btn ghost', 'data-focus': `yt-open:${u.id}`, onClick: () => api.openExternal(u.url) }, 'Ansehen'),
      st.canDelete ? btn(`del:${u.id}`, 'Löschen', () => api.ytDelete(u.id).then((r) => (r && r.ok
        ? { message: r.alreadyGone ? `„${r.title}“ war bei YouTube schon weg – aus der Liste entfernt.` : `„${r.title}“ ist bei YouTube gelöscht.` }
        : r && r.cancelled ? null : r)), 'btn ghost danger') : null))));
}

function ytCard() {
  const st = yt.status;
  if (!yt.loading && !yt.busy && (!yt.at || Date.now() - yt.at > YT_STALE_MS)) loadYouTube();
  const connected = st && st.connected;
  const btn = (id, label, fn, cls = 'btn') => h('button', { class: cls, 'data-focus': `yt-${id}`, disabled: yt.busy !== null, 'aria-busy': String(yt.busy === id), onClick: () => ytAction(id, fn) },
    yt.busy === id ? (id === 'connect' ? 'Warte auf den Browser …' : 'Läuft …') : label);
  const connect = () => api.ytConnect().then((r) => (r && r.ok ? { message: `Verbunden mit „${r.channel.title}“.` } : r));
  const pickFile = () => api.ytClientFile().then((r) => { if (r && r.ok) { yt.file = r.file; return { message: 'Anmeldedaten übernommen. Jetzt „Mit YouTube anmelden“.' }; } return r && r.cancelled ? null : r; });
  return connCard({ icon: '▶', title: 'YouTube',
    text: 'Videos direkt über die offizielle YouTube-Schnittstelle hochladen – ohne Web-Tab. Zur Wunschzeit veröffentlicht YouTube selbst.',
    right: h('span', { class: `pill ${connected ? 'green' : ''}`, text: connected ? 'verbunden' : st && st.hasClient ? 'Anmeldung fehlt' : 'nicht eingerichtet' }),
    extra: h('div', { class: 'conn-extra' },
      yt.message ? h('div', { class: 'sub', role: 'status', text: yt.message }) : null,
      !connected && st && st.lost ? h('div', { class: 'sub warn', role: 'status', text: 'Google hat die Anmeldung beendet – bitte unten neu anmelden. Passiert das alle 7 Tage, steht die App bei Google noch im Testmodus (Schritt 3: „App veröffentlichen“).' }) : null,
      connected
        ? [h('div', { class: 'sub', text: `Kanal: ${st.channel.title}${st.lastUpload ? ` · zuletzt hochgeladen: „${st.lastUpload.title}“` : ''}` }),
          h('div', { class: 'actions' },
            st.lastUpload ? h('button', { class: 'btn ghost', onClick: () => api.openExternal(st.lastUpload.url) }, 'Letztes Video ansehen') : null,
            btn('disconnect', 'Trennen', () => (confirm('YouTube trennen? Die Zentrale gibt den Zugang dann auch bei Google zurück.') ? api.ytDisconnect() : null), 'btn ghost')),
          ytUploads(st, btn, connect)]
        : [ytGuide(),
          h('div', { class: 'actions' },
            btn('file', st && st.hasClient ? 'Andere Datei wählen' : 'Datei wählen', pickFile, st && st.hasClient ? 'btn ghost' : 'btn'),
            st && st.hasClient ? btn('connect', 'Mit YouTube anmelden', connect) : null,
            // Tab geschlossen oder verloren: Anmeldung neu starten statt bis zum Zeitlimit zu warten.
            yt.busy === 'connect' ? h('button', { class: 'link', 'data-focus': 'yt-reconnect', onClick: () => ytAction('connect', connect) }, 'Browser nochmal öffnen') : null)],
      yt.file ? h('div', { class: 'sub' }, 'Die heruntergeladene Datei enthält dein Client-Geheimnis und wird nicht mehr gebraucht. ',
        h('button', { class: 'link', 'data-focus': 'yt-trash', onClick: async () => {
          const r = (await api.ytTrashFile(yt.file)) || {};
          if (r.ok) yt.file = null; // bei einem Fehler bleibt der Knopf für einen zweiten Versuch
          yt.message = r.ok ? 'Datei liegt im Papierkorb.' : `Die Datei ließ sich nicht verschieben${r.error ? `: ${r.error}` : '.'}`;
          renderConnections();
        } }, 'In den Papierkorb')) : null,
      h('div', { class: 'sub', text: 'Die Zentrale speichert den Zugang nur verschlüsselt im Schlüsselbund dieses Macs. MURIS-Kanäle verbindet sie nie.' })) });
}
