// Mini-Player in der rechten Seitenleiste für Spotify und Apple Music.
// Fragt nur ab, solange das Fenster sichtbar und „Mein Mac“ verbunden ist. Nutzt die Helfer aus app.js.

const musicv = { data: null, at: 0, timer: null, tick: null, busy: false };
// Wechsel meldet der Mac sofort (siehe music-watch.js); die Abfrage ist nur noch die Absicherung.
const MUSIC_POLL_MS = 15000;
const MUSIC_TICK_MS = 1000;
const MUSIC_APPS = [
  { name: 'Spotify', path: '/Applications/Spotify.app' },
  { name: 'Apple Music', path: '/System/Applications/Music.app' },
];

function formatTime(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function loadMusic() {
  if (musicv.busy || document.hidden) return;
  const on = ui.state && ui.state.platform === 'darwin' && settings().connections.mac;
  $('#music-section').hidden = !on;
  if (!on) return;
  musicv.busy = true;
  // Bei einem kurzen Fehler den letzten Stand behalten, statt „keine Musik“ aufblitzen zu lassen.
  try { const res = await api.musicNow(); if (res && res.ok) { musicv.data = res.data; musicv.at = Date.now(); } } catch {}
  musicv.busy = false;
  renderMusic();
}

async function musicDo(app, action) {
  const res = await api.musicControl(app, action);
  if (res && !res.ok) alert(res.error);
  else if (res && res.data) { musicv.data = { ...(musicv.data || {}), current: res.data }; musicv.at = Date.now(); }
  renderMusic(); // den Rest meldet der Mac von selbst
}

function renderMusic() {
  const box = $('#music');
  if (!box) return;
  const cur = musicv.data && musicv.data.current;
  const t0 = cur && cur.track;
  // Zwischen zwei Abfragen läuft der Balken selbst weiter, solange gespielt wird.
  const pos = cur && Number.isFinite(cur.position) ? cur.position + (cur.playing ? (Date.now() - musicv.at) / 1000 : 0) : NaN;
  const pct0 = t0 && t0.duration && Number.isFinite(pos) ? Math.min(100, (pos / t0.duration) * 100) : 0;
  // Nur der Fortschritt hat sich geändert: Balken direkt anpassen, nichts neu aufbauen.
  if (!changed('music', cur && { app: cur.app, playing: cur.playing, track: t0 })) {
    const bar = box.querySelector('.bar');
    if (bar) { bar.firstChild.style.width = `${pct0}%`; bar.setAttribute('aria-valuenow', String(Math.round(pct0))); }
    return;
  }
  if (!cur) {
    fill(box, h('div', { class: 'card player' },
      h('div', { class: 'where', text: 'Gerade läuft keine Musik-App.' }),
      h('div', { class: 'actions' }, MUSIC_APPS.map((a) => h('button', { class: 'btn ghost', onClick: async () => {
        const res = await api.fsOpen(a.path);
        if (res && !res.ok) alert(res.error);
        setTimeout(loadMusic, 2500);
      } }, `${a.name} öffnen`)))));
    return;
  }
  const t = cur.track;
  const pct = pct0;
  const btn = (action, label, icon, main) => h('button', { class: main ? 'play' : '', 'aria-label': label, title: label,
    'data-focus': `music:${action}`, onClick: () => musicDo(cur.app, action) }, icon);
  keepFocus(() => fill(box, h('div', { class: 'card player' },
    h('div', { class: 'top' },
      h('div', { class: `cover ${cur.app}`, 'aria-hidden': 'true', text: '♪' }),
      h('div', { class: 'grow' },
        h('div', { class: 'name', text: t ? t.title : 'Kein Titel', title: t ? t.title : '' }),
        h('div', { class: 'where', text: t ? `${t.artist}${t.artist ? ' · ' : ''}${cur.label}` : cur.label }))),
    t && t.duration ? h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Fortschritt', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': String(Math.round(pct)), 'aria-valuetext': `${formatTime(t.duration)} lang` }, h('span', { style: { width: `${pct}%` } })) : null,
    h('div', { class: 'controls' },
      btn('previous', 'Vorheriger Titel', '⏮'),
      btn('playpause', cur.playing ? 'Pausieren' : 'Abspielen', cur.playing ? '⏸' : '▶', true),
      btn('next', 'Nächster Titel', '⏭')))));
}

function startMusic() {
  if (musicv.timer) return;
  loadMusic();
  musicv.timer = setInterval(loadMusic, MUSIC_POLL_MS);
  musicv.tick = setInterval(() => { const c = musicv.data && musicv.data.current; if (c && c.playing && !document.hidden) renderMusic(); }, MUSIC_TICK_MS);
}
window.zentrale.onMusicNow((d) => { musicv.data = d; musicv.at = Date.now(); renderMusic(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMusic(); });
window.zentrale.onState(() => { if (!musicv.timer) setTimeout(startMusic, 500); });
