// Blinde Flecken: was nicht verbunden ist, nie läuft, scheitert, langsam ist oder nie benutzt wird.
// Reine Logik – die Fakten sammelt main.js, so lässt sich alles testen.
const DAY = 24 * 3600 * 1000;
const VIEWS = { overview: 'Übersicht', chat: 'Chat', brain: 'Gehirn', web: 'Web', websites: 'Websites', planner: 'Planer', bitvideos: 'Bit-Videos',
  automations: 'Automatisierungen', local: 'Localhost', projects: 'Projekte & Server', mac: 'Mein Mac', library: 'Skills & Agenten',
  tasks: 'Tägliche Aufgaben', finance: 'Privat', connections: 'Verbindungen', kontrolle: 'Kontrollraum', lernen: 'Lernen & Training' };

// level: rot = kaputt/gefährlich, gelb = fehlt/vergessen, info = Hinweis
function blindSpots(f, now = Date.now()) {
  const out = [];
  const add = (level, title, detail, action) => out.push({ level, title, detail, action: action || null });
  if (!f.claudeFound) add('rot', 'Claude Code fehlt', 'Ohne Claude Code laufen Chat, Aufgaben und Assistenten nicht.', { label: 'Verbindungen', view: 'connections' });
  if (f.online === false) add('rot', 'Kein Internet', 'Claude, Web-Tabs, Uploads und Bit-Videos gehen gerade nicht. Lokales (Finanzen, Ordner, Server) läuft weiter.');
  if (f.claudeAuthProblem) add('rot', 'Claude ist abgemeldet', 'Gespräche und Aufgaben scheitern. Im Terminal `claude` starten und /login eingeben.', { label: 'Chat', view: 'chat' });
  if (f.n8n && !f.n8n.running) add('rot', 'n8n läuft nicht', 'Bit-Videos, Erinnerungen und Telegram hängen an n8n.', { label: 'Automatisierungen', view: 'automations' });
  else if (f.n8n && !f.n8n.hasKey) add('gelb', 'n8n nicht verbunden', 'Fehlgeschlagene Workflows werden dir so nicht gemeldet.', { label: 'Verbinden', view: 'automations' });
  if (f.connections && !f.connections.mac) add('gelb', '„Mein Mac“ ist aus', 'Kalender, Erinnerungen, Mail und Musik sind für Claude und „Heute“ unsichtbar.', { label: 'Einschalten', view: 'connections' });
  if (f.connections && !f.connections.web) add('gelb', 'Web-Tabs für Claude sind aus', 'Claude kann dann nichts in Instagram, YouTube oder Meta für dich erledigen.', { label: 'Einschalten', view: 'connections' });
  for (const t of f.logins || []) if (!t.loggedIn) add('gelb', `${t.name}: nicht angemeldet`, 'Uploads, Kommentare und Video-Analysen gehen hier erst nach deiner Anmeldung.', { label: 'Öffnen', view: 'web', tab: t.id });
  for (const t of f.tasks || []) {
    if (t.enabled && t.lastStatus === 'error') add('rot', `Aufgabe „${t.name}“ ist zuletzt gescheitert`, String(t.lastText || '').split('\n')[0].slice(0, 140), { label: 'Ansehen', view: 'tasks' });
    else if (t.enabled && t.lastRunAt && now - t.lastRunAt > 3 * DAY) add('gelb', `Aufgabe „${t.name}“ lief seit ${Math.floor((now - t.lastRunAt) / DAY)} Tagen nicht`, 'War der Mac zu dieser Zeit aus oder im Ruhezustand?', { label: 'Ansehen', view: 'tasks' });
  }
  for (const a of (f.alerts || []).filter((x) => now - x.at < DAY).slice(0, 3)) add('rot', a.title, a.body, a.view ? { label: 'Ansehen', view: a.view } : null);
  if (f.disk && f.disk.ok && f.disk.free < 15) add(f.disk.free < 8 ? 'rot' : 'gelb', `Nur noch ${f.disk.free} GB frei`, 'Ab etwa 10 GB wird der Mac langsam und Renderings brechen ab.', { label: 'Gesundheit', view: 'mac', tab: 'health' });
  if (f.unsorted > 5) add('info', `${f.unsorted} neue Dateien ohne Platz`, 'Eine Regel im Ordner-Wächter würde sie automatisch einsortieren.', { label: 'Ordner-Wächter', view: 'mac', tab: 'watch' });
  if (f.data) {
    for (const r of f.data.slowest.filter((x) => x.avgMs > 800 && x.count >= 3).slice(0, 3)) add('gelb', `Langsam: ${r.name}`, `im Schnitt ${r.avgMs} ms (${r.count}×)`, { label: 'Tempo', view: 'kontrolle', tab: 'tempo' });
    for (const r of f.data.failing.filter((x) => x.errors >= 3).slice(0, 3)) add('gelb', `Scheitert oft: ${r.name}`, `${r.errors}× – zuletzt „${r.lastError}“`, { label: 'Fehler', view: 'kontrolle', tab: 'tempo' });
    const used = f.data.views || {};
    const age = now - (f.data.since || now);
    if (age > 3 * DAY) {
      const never = Object.keys(VIEWS).filter((v) => !used[v] && v !== 'kontrolle').map((v) => VIEWS[v]);
      if (never.length) add('info', 'Nie benutzt', `${never.join(', ')} – brauchst du das, oder soll es weg?`);
    }
  }
  if (f.security) for (const s of f.security.filter((x) => !x.ok)) add(s.level || 'gelb', `Schutz: ${s.title}`, s.detail, { label: 'Schutz', view: 'kontrolle', tab: 'schutz' });
  const order = { rot: 0, gelb: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

module.exports = { blindSpots, VIEWS };
