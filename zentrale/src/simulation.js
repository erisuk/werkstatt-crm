// Simulationen:
//  1. Notfall-Probe – spielt Störungen mit gespielten Daten durch die echte Erkennungs-Logik und zeigt,
//     ob die Zentrale es merkt. Was sie nicht merkt, ist ein blinder Fleck.
//  2. Probelauf – solange er läuft, führen Claudes Werkzeuge nichts Echtes aus (kein Klick, kein Tippen,
//     kein Upload, keine n8n-Änderung). Das erzwingt die Zentrale selbst, nicht nur eine Bitte an Claude.
//  3. Aufträge für Probelauf und „Bit-Video vorab“.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AlertWatch } = require('./alerts');
const { blindSpots } = require('./blind-spots');
const kommentare = require('./kommentare');

// ---------- 1. Notfall-Probe ----------

async function probeAlerts(kind) {
  const sent = [];
  if (kind === 'server') {
    let list = [{ port: 4310, pid: 1, proc: 'node', title: 'Gold-Desk', launchd: true, system: false }];
    const a = new AlertWatch({ listServers: async () => list, notify: (t, b) => sent.push(`${t}: ${b}`) });
    await a.checkServers(); list = []; await a.checkServers(); await a.checkServers();
  } else {
    let execs = [{ id: '1', workflowId: 'w', status: 'success' }];
    const a = new AlertWatch({ listServers: async () => [], listExecutions: async () => ({ ok: true, data: execs }),
      listWorkflows: async () => ({ ok: true, data: [{ id: 'w', name: 'BIT AI News – Tagesvideo' }] }), notify: (t, b) => sent.push(`${t}: ${b}`) });
    await a.checkN8n(); execs = [{ id: '2', workflowId: 'w', status: 'error' }, ...execs]; await a.checkN8n();
  }
  return sent;
}

const spotsFor = (facts) => blindSpots({ claudeFound: true, n8n: { running: true, hasKey: true }, connections: { mac: true, web: true }, online: true, ...facts });

// Jede Probe: Titel, Ergebnis (abgedeckt ja/nein) und was du sehen würdest.
async function emergencyProbe() {
  const probes = [];
  const add = (id, title, covered, what, tip) => probes.push({ id, title, covered, what, tip: covered ? null : tip });

  const s = await probeAlerts('server');
  add('server', 'Ein wichtiger Server fällt aus', s.length === 1, s[0] || 'Keine Mitteilung.', 'Server-Überwachung prüfen.');
  const n = await probeAlerts('n8n');
  add('n8n-fehler', 'Ein n8n-Workflow scheitert', n.length === 1, n[0] || 'Keine Mitteilung.', 'n8n-Verbindung prüfen.');
  const off = spotsFor({ n8n: { running: false, hasKey: true } });
  add('n8n-aus', 'n8n ist abgestürzt', off.some((x) => /n8n läuft nicht/.test(x.title)), (off.find((x) => /n8n/.test(x.title)) || {}).title || '–', '');
  const disk = spotsFor({ disk: { ok: true, free: 6 } });
  add('platte', 'Die Platte ist fast voll', disk.some((x) => /GB frei/.test(x.title)), (disk.find((x) => /GB frei/.test(x.title)) || {}).title || '–', '');
  const net = spotsFor({ online: false });
  add('internet', 'Das Internet ist weg', net.some((x) => /Internet/.test(x.title)), (net.find((x) => /Internet/.test(x.title)) || {}).title || '–', '');
  const auth = spotsFor({ claudeAuthProblem: true });
  add('claude-login', 'Claude ist abgemeldet', auth.some((x) => /abgemeldet/.test(x.title)), (auth.find((x) => /abgemeldet/.test(x.title)) || {}).title || '–', '');
  const task = spotsFor({ tasks: [{ name: 'Bit: Kommentare einsammeln', enabled: true, lastStatus: 'error', lastText: 'Abgebrochen' }] });
  add('aufgabe', 'Eine tägliche Aufgabe scheitert', task.some((x) => /gescheitert/.test(x.title)), (task.find((x) => /gescheitert/.test(x.title)) || {}).title || '–', '');
  const login = spotsFor({ logins: [{ id: 'x', name: 'Bit · Instagram', loggedIn: false }] });
  add('login', 'Ein Bit-Konto ist abgemeldet', login.some((x) => /nicht angemeldet/.test(x.title)), (login.find((x) => /angemeldet/.test(x.title)) || {}).title || '–', '');
  // Kaputte Datei: darf nie leer überschrieben werden.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrale-probe-'));
  const file = path.join(dir, 'k.json');
  fs.writeFileSync(file, '{kaputt');
  let safe = false;
  try { kommentare.save(file, kommentare.load(file)); } catch { safe = fs.readFileSync(file, 'utf8') === '{kaputt'; }
  fs.rmSync(dir, { recursive: true, force: true });
  add('datei', 'Eine Datei ist beschädigt', safe, safe ? 'Die Zentrale überschreibt sie nicht und meldet den Fehler.' : 'Die Datei würde überschrieben!', 'Speichern absichern.');
  return probes;
}

// ---------- 2. Probelauf ----------

const DRY_BROWSER = new Set(['click', 'type', 'key', 'upload', 'open']);
const DRY_N8N = new Set(['createWorkflow', 'updateWorkflow', 'setActive']);

// Wickelt die Werkzeug-Aktionen ein: im Probelauf wird nichts ausgeführt, nur gemeldet, was passiert wäre.
function dryRunOps(ops, writeSet, isDry, label) {
  const out = {};
  for (const [name, fn] of Object.entries(ops)) {
    out[name] = (a) => {
      if (!writeSet.has(name) || !isDry()) return fn(a);
      return Promise.resolve({ ok: true, probelauf: true,
        data: `PROBELAUF – nichts ausgeführt. ${label}: „${name}“ wäre jetzt passiert (${summarize(a)}). Beschreib dem Nutzer, was du als Nächstes tun würdest, und mach im Probelauf so weiter.` });
    };
  }
  return out;
}

function summarize(a) {
  if (!a || typeof a !== 'object') return 'ohne Angaben';
  const parts = [];
  if (a.ref) parts.push(`Element ${a.ref}`);
  if (a.text) parts.push(`Text „${String(a.text).slice(0, 60)}${String(a.text).length > 60 ? '…' : ''}“`);
  if (a.files) parts.push(`${[].concat(a.files).length} Datei(en)`);
  if (a.url) parts.push(String(a.url).slice(0, 80));
  if (a.key) parts.push(`Taste ${a.key}`);
  if (a.id) parts.push(`Workflow ${a.id}`);
  if (typeof a.active === 'boolean') parts.push(a.active ? 'einschalten' : 'ausschalten');
  return parts.join(', ') || 'ohne Angaben';
}

const DRY_HEAD = 'PROBELAUF: Die Zentrale hat einen Probelauf eingeschaltet. Klicks, Tippen, Uploads und n8n-Änderungen werden NICHT ausgeführt – die Werkzeuge melden nur zurück, was passiert wäre. Lesen und Screenshots gehen normal. Führe außerdem keine Bash-Befehle aus, die etwas verändern, und sende nichts.';

function dryRunPrompt(kind, detail) {
  const q = (s) => JSON.stringify(String(s || ''));
  const tasks = {
    upload: `Spiel den Upload dieses geplanten Beitrags durch: ${q(detail)}. Prüfe das angemeldete Konto, geh alle Schritte bis „Veröffentlichen“ durch und liste jeden Schritt, der echt passieren würde.`,
    n8n: `Spiel den n8n-Workflow ${q(detail)} Knoten für Knoten durch (lies ihn mit n8n_get_workflow). Sag für jeden Knoten, was er mit echten Daten täte, was nach außen geht (Mails, Nachrichten, Uploads, Kosten) und wo er scheitern könnte.`,
    kommentare: 'Spiel das Einsammeln der Kommentare und das Vorbereiten der Antworten durch – welche Kommentare würdest du finden, welche Nachricht an wen tippen?',
    frei: `Spiel diese Aufgabe durch: ${q(detail)}.`,
  };
  return [DRY_HEAD, '', tasks[kind] || tasks.frei, '', 'Am Ende: eine Liste „Das würde echt passieren“, „Risiken“ und „Was du vorher prüfen solltest“.'].join('\n');
}

function bitPreviewPrompt(topic) {
  const t = String(topic || '').trim();
  return [
    'BIT-VIDEO VORAB (Simulation): Baue NICHTS. Kein Rendern, keine ElevenLabs-Stimme, kein Telegram, keine Änderung in ~/ki-creator/studio.',
    'Lies zuerst ~/ki-creator/FEHLER-UND-REGELN.md und halte dich an alle Regeln dort.',
    t ? `Thema: ${JSON.stringify(t)}` : 'Thema: das nächste Wunschthema bzw. das beste Radar-Thema (lies es aus studio/gedaechtnis, nur lesen).',
    '',
    'Liefere:',
    '1. Primärquelle (Hersteller, Repo, Produktseite) – ohne Primärquelle: abbrechen und sagen warum.',
    '2. Skript-Entwurf im Format „Neuigkeit + 3 Wege“ (Hook, 3 Alltagsnutzen, ehrlicher Haken, Kommentar-Wort), 55–95 Wörter, Bit als einziger Absender.',
    '3. Wörter, geschätzte Länge in Sekunden (ElevenLabs speed 1.08) und geschätzte ElevenLabs-Credits (≈ Zeichen) – als Schätzung kennzeichnen.',
    '4. Prüfung gegen die Regeln: Mehrwert (Zeit/Geld/Problem), keine erfundenen Fähigkeiten, Einschränkungen genannt, Anonymität.',
    '5. Risiken und ob du es so bauen würdest.',
  ].join('\n');
}

module.exports = { emergencyProbe, dryRunOps, dryRunPrompt, bitPreviewPrompt, DRY_BROWSER, DRY_N8N };
