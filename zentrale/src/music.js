// Musik: Spotify und Apple Music über die Mac-Automatisierung abfragen und steuern.
// Abgefragt wird nur, was schon läuft – die Zentrale öffnet keine Musik-App ungefragt.
const { runScript } = require('./mac');

const APPS = { spotify: 'Spotify', music: 'Music' };
const ACTIONS = ['playpause', 'play', 'pause', 'next', 'previous'];
const APP_LABEL = { spotify: 'Spotify', music: 'Apple Music' };

// argv[0] = App-Name, argv[1] = Aktion ('now' = nur abfragen).
const SCRIPT = `function run(argv) {
  var A = Application(argv[0]);
  if (!A.running()) return JSON.stringify({ running: false });
  var action = argv[1];
  if (action === 'playpause') A.playpause();
  else if (action === 'play') A.play();
  else if (action === 'pause') A.pause();
  else if (action === 'next') A.nextTrack();
  else if (action === 'previous') A.previousTrack();
  var state = '';
  try { state = String(A.playerState()); } catch (e) {}
  var track = null;
  try {
    var c = A.currentTrack;
    track = { title: c.name(), artist: c.artist(), album: c.album(), duration: Number(c.duration()) };
  } catch (e) {}
  var position = null;
  try { position = Number(A.playerPosition()); } catch (e) {}
  return JSON.stringify({ running: true, state: state, track: track, position: position });
}`;

// Spotify zählt die Länge in Millisekunden, Apple Music in Sekunden – hier immer Sekunden.
function normalize(app, data) {
  if (!data || !data.running) return { app, label: APP_LABEL[app], running: false };
  const t = data.track && data.track.title ? data.track : null;
  const duration = t && Number.isFinite(t.duration) ? (app === 'spotify' ? t.duration / 1000 : t.duration) : null;
  return {
    app, label: APP_LABEL[app], running: true,
    playing: /playing/i.test(data.state || ''),
    track: t ? { title: String(t.title), artist: String(t.artist || ''), album: String(t.album || ''), duration } : null,
    position: Number.isFinite(data.position) ? data.position : null,
  };
}

async function query(app, action) {
  const res = await runScript(SCRIPT, [APPS[app], action], { app: APP_LABEL[app], timeout: 8000 });
  if (!res.ok) return { app, label: APP_LABEL[app], running: false, error: res.error };
  let data = null;
  try { data = JSON.parse(res.out); } catch { return { app, label: APP_LABEL[app], running: false, error: 'Unerwartete Antwort.' }; }
  return normalize(app, data);
}

// Was gerade läuft: bevorzugt die App, die abspielt; sonst die erste, die geöffnet ist.
async function nowPlaying() {
  const all = await Promise.all(Object.keys(APPS).map((a) => query(a, 'now')));
  const current = all.find((x) => x.playing) || all.find((x) => x.running && x.track) || all.find((x) => x.running) || null;
  return { ok: true, data: { current, apps: all } };
}

async function control(app, action) {
  if (!APPS[app]) return { ok: false, error: 'Unbekannte Musik-App (spotify oder music).' };
  if (!ACTIONS.includes(action)) return { ok: false, error: `Unbekannte Aktion (${ACTIONS.join(', ')}).` };
  const res = await query(app, action);
  if (!res.running) return { ok: false, error: res.error || `${APP_LABEL[app]} ist nicht geöffnet.` };
  return { ok: true, data: res };
}

module.exports = { nowPlaying, control, normalize, APPS, ACTIONS, APP_LABEL };
