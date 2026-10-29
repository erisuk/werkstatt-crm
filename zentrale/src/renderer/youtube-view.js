// Verbindungen → YouTube: Anleitung für das Google-Cloud-Projekt, Datei wählen, im Browser anmelden.
// Danach lädt der Planer Videos über die offizielle Schnittstelle hoch. Nutzt die Helfer aus app.js und connections-view.js.

const yt = { status: null, busy: null, message: null, file: null, loading: false };

async function loadYouTube() {
  yt.loading = true;
  try { yt.status = await api.ytStatus(); } catch (e) { yt.message = e.message; }
  yt.loading = false;
  if (ui.view === 'connections') renderConnections();
}

async function ytAction(id, fn) {
  yt.busy = id; yt.message = null; renderConnections();
  try {
    const r = await fn();
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

function ytCard() {
  const st = yt.status;
  if (!st && !yt.loading && !yt.message) loadYouTube();
  const connected = st && st.connected;
  const btn = (id, label, fn, cls = 'btn') => h('button', { class: cls, 'data-focus': `yt-${id}`, disabled: yt.busy !== null, 'aria-busy': String(yt.busy === id), onClick: () => ytAction(id, fn) },
    yt.busy === id ? (id === 'connect' ? 'Warte auf den Browser …' : 'Läuft …') : label);
  const pickFile = () => api.ytClientFile().then((r) => { if (r && r.ok) { yt.file = r.file; return { message: 'Anmeldedaten übernommen. Jetzt „Mit YouTube anmelden“.' }; } return r && r.cancelled ? null : r; });
  return connCard({ icon: '▶', title: 'YouTube',
    text: 'Videos direkt über die offizielle YouTube-Schnittstelle hochladen – ohne Web-Tab. Zur Wunschzeit veröffentlicht YouTube selbst.',
    right: h('span', { class: `pill ${connected ? 'green' : ''}`, text: connected ? 'verbunden' : st && st.hasClient ? 'Anmeldung fehlt' : 'nicht eingerichtet' }),
    extra: h('div', { class: 'conn-extra' },
      yt.message ? h('div', { class: 'sub', role: 'status', text: yt.message }) : null,
      connected
        ? [h('div', { class: 'sub', text: `Kanal: ${st.channel.title}${st.lastUpload ? ` · zuletzt hochgeladen: „${st.lastUpload.title}“` : ''}` }),
          h('div', { class: 'actions' },
            st.lastUpload ? h('button', { class: 'btn ghost', onClick: () => api.openExternal(st.lastUpload.url) }, 'Letztes Video ansehen') : null,
            btn('disconnect', 'Trennen', () => (confirm('YouTube trennen? Die Zentrale gibt den Zugang dann auch bei Google zurück.') ? api.ytDisconnect() : null), 'btn ghost'))]
        : [ytGuide(),
          h('div', { class: 'actions' },
            btn('file', st && st.hasClient ? 'Andere Datei wählen' : 'Datei wählen', pickFile, st && st.hasClient ? 'btn ghost' : 'btn'),
            st && st.hasClient ? btn('connect', 'Mit YouTube anmelden', () => api.ytConnect().then((r) => (r.ok ? { message: `Verbunden mit „${r.channel.title}“.` } : r))) : null)],
      yt.file ? h('div', { class: 'sub' }, 'Die heruntergeladene Datei enthält dein Client-Geheimnis und wird nicht mehr gebraucht. ',
        h('button', { class: 'link', onClick: async () => { const f = yt.file; yt.file = null; const r = await api.ytTrashFile(f); yt.message = r.ok ? 'Datei liegt im Papierkorb.' : 'Die Datei ließ sich nicht verschieben.'; renderConnections(); } }, 'In den Papierkorb')) : null,
      h('div', { class: 'sub', text: 'Die Zentrale speichert den Zugang nur verschlüsselt im Schlüsselbund dieses Macs. MURIS-Kanäle verbindet sie nie.' })) });
}
