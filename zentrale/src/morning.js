// Morgen-Cockpit: fasst die Lage zusammen (Termine, Ungelesenes in den Web-Tabs, Fehler, Server, einsortierte Dateien)
// und schickt sie auf Wunsch einmal am Tag zur gewählten Uhrzeit als Mitteilung.
const DAY = 24 * 3600 * 1000;
const LATE_LIMIT_MIN = 180; // war der Mac zur Uhrzeit aus, wird höchstens drei Stunden später nachgeholt

function validTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Ist die Morgen-Mitteilung jetzt fällig? Einmal pro Tag, ab der Uhrzeit, nicht beliebig spät nachgeholt.
function isDue(now, time, lastSentDay) {
  if (!validTime(time)) return false;
  if (lastSentDay === dayKey(now)) return false;
  const [hh, mm] = time.split(':').map(Number);
  const minutes = now.getHours() * 60 + now.getMinutes() - (hh * 60 + mm);
  return minutes >= 0 && minutes <= LATE_LIMIT_MIN;
}

// Lage aus den einzelnen Quellen; fehlende Quellen werden einfach weggelassen.
function cockpit({ portals = [], alerts = [], watcherLog = [], unsorted = [], servers = [], now = Date.now() }) {
  const web = portals.filter((p) => p.unread > 0 && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(p.url))
    .map((p) => ({ id: p.id, name: p.name, unread: p.unread }));
  return {
    web,
    alerts: alerts.filter((a) => now - a.at < DAY),
    sorted: watcherLog.filter((e) => !e.undone && now - e.at < DAY).length,
    unsorted: unsorted.length,
    servers: servers.filter((s) => !s.system).length,
  };
}

function summaryText(c, events) {
  const parts = [];
  if (Array.isArray(events)) parts.push(events.length ? `${events.length} ${events.length === 1 ? 'Termin' : 'Termine'} heute` : 'keine Termine');
  const unread = c.web.reduce((n, p) => n + p.unread, 0);
  if (unread) parts.push(`${unread} ungelesen (${c.web.map((p) => p.name).slice(0, 3).join(', ')})`);
  if (c.alerts.length) parts.push(`${c.alerts.length} ${c.alerts.length === 1 ? 'Fehler' : 'Fehler'} seit gestern`);
  if (c.unsorted) parts.push(`${c.unsorted} neue Dateien ohne Platz`);
  parts.push(`${c.servers} ${c.servers === 1 ? 'Server läuft' : 'Server laufen'}`);
  return parts.join(' · ');
}

module.exports = { isDue, cockpit, summaryText, validTime, dayKey };
