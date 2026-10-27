// Ansicht „Verbindungen“. Nutzt die Helfer aus app.js (h, fill, ui, api …).
const STATUS_LABEL = { connected: 'verbunden', auth: 'Anmeldung nötig', failed: 'Fehler', off: 'nicht eingerichtet', unknown: 'unbekannt' };
const STATUS_PILL = { connected: 'green', auth: 'amber', failed: 'red', off: '', unknown: '' };

function findConnection(re) {
  return (ui.connections || []).filter((c) => re.test(c.name));
}

// Läuft schon eine Prüfung, warten alle auf dieselbe – egal welche Ansicht sie gestartet hat.
let connectionsPromise = null;
function loadConnections() {
  if (connectionsPromise) return connectionsPromise;
  ui.connectionsLoading = true;
  if (ui.view === 'connections') renderConnections();
  connectionsPromise = (async () => {
    try { ui.connections = (await api.listConnections()) || []; } catch { ui.connections = []; }
    ui.connectionsLoading = false;
    connectionsPromise = null;
    if (ui.view === 'connections') renderConnections();
  })();
  return connectionsPromise;
}

async function setConnection(key, value) {
  const res = await api.updateSettings({ connections: { [key]: value } });
  if (res && res.applied === false) ui.notice = 'Gespeichert. Claude arbeitet gerade – die neue Verbindung gilt, sobald er fertig ist und du die nächste Nachricht schickst.';
  else if (res && res.interrupted) ui.notice = 'Verbindung getrennt. Claude wurde dafür neu gestartet; eine laufende Antwort wurde abgebrochen.';
  else ui.notice = null;
  ui.todayAt = 0;
  renderConnections();
}

function connSwitch(key, label, disabled) {
  const on = !!settings().connections[key];
  return h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': label, disabled,
    'data-focus': `conn:${key}`, onClick: () => setConnection(key, !on) });
}

function statusPill(items, fallback) {
  if (ui.connectionsLoading && !ui.connections) return h('span', { class: 'pill', text: 'wird geprüft …' });
  if (!items.length) return h('span', { class: 'pill', text: fallback });
  const best = items.find((c) => c.status === 'connected') || items[0];
  return h('span', { class: `pill ${STATUS_PILL[best.status]}`, text: STATUS_LABEL[best.status] });
}

function connCard({ icon, title, text, right, extra }) {
  return h('div', { class: 'card conn' },
    h('div', { class: 'conn-head' },
      h('span', { class: 'conn-icon', 'aria-hidden': 'true', text: icon }),
      h('div', { class: 'grow' }, h('div', { class: 'name', text: title }), h('div', { class: 'sub', text })),
      right),
    extra);
}

function macTestResult() {
  const r = ui.macTest;
  if (!r) return null;
  if (r.error) return h('div', { class: 'sub warn', text: r.error });
  const line = (label, x) => h('li', { class: x && x.ok ? '' : 'warn' }, `${label}: `, x && x.ok ? 'funktioniert' : (x ? x.error : '…'));
  return h('ul', { class: 'today-list' }, line('Kalender', r.calendar), line('Erinnerungen', r.reminders), line('Mitteilungen', r.notify));
}

function renderConnections() {
  const s = ui.state;
  const mac = isMac();
  const gmail = findConnection(/gmail/i);
  const m365 = findConnection(/microsoft|outlook|m365|office/i);
  const others = (ui.connections || []).filter((c) => !/gmail|microsoft|outlook|m365|office/i.test(c.name));
  const conn = settings().connections;
  const link = (url, label) => h('button', { class: 'btn ghost', onClick: () => api.openExternal(url) }, label);

  keepFocus(() => fill($('#main'),
    h('div', { class: 'section-head wrap' },
      h('h1', { text: 'Verbindungen' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', 'data-focus': 'conn-refresh', disabled: ui.connectionsLoading || !s.claude.found, onClick: loadConnections },
        ui.connectionsLoading ? 'Wird geprüft …' : 'Status prüfen')),
    h('p', { class: 'date', text: 'Hier verbindest du Claude mit deinem Mac und deinen Konten. Lesen geht ohne Rückfrage – bevor Claude etwas sendet, anlegt, öffnet oder löscht, fragt die Zentrale dich.' }),
    ui.notice ? h('div', { class: 'notice', text: ui.notice }) : null,

    connCard({ icon: '⌘', title: 'Mein Mac',
      text: 'Kalender, Erinnerungen, Notizen, Apple Mail, Outlook-App, Dateisuche – und jede andere App per AppleScript.',
      right: connSwitch('mac', 'Mac verbinden', !mac),
      extra: !mac ? h('div', { class: 'sub warn', text: 'Das geht nur auf dem Mac.' }) : conn.mac ? h('div', { class: 'conn-extra' },
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost', 'data-focus': 'mac-test', onClick: async () => { ui.macTest = {}; renderConnections(); ui.macTest = await api.macTest(); renderConnections(); } }, 'Zugriff testen'),
          link('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation', 'Mac-Rechte öffnen')),
        h('div', { class: 'sub', text: 'Beim ersten Zugriff fragt macOS, ob die Zentrale die jeweilige App steuern darf. Bitte jeweils „OK“ klicken.' }),
        macTestResult()) : null }),

    connCard({ icon: 'G', title: 'Gmail',
      text: 'Über deine claude.ai-Verbindung: Mails lesen, zusammenfassen, Entwürfe schreiben.',
      right: statusPill(gmail, ui.connections ? 'nicht verbunden' : '–'),
      extra: h('div', { class: 'conn-extra' },
        h('div', { class: 'sub', text: 'Verbinde Gmail einmal auf claude.ai unter „Connectors“ – danach steht es hier automatisch zur Verfügung. Alternativ: Gmail im Browser über Chrome.' }),
        h('div', { class: 'actions' }, link('https://claude.ai/settings/connectors', 'Auf claude.ai verbinden'))) }),

    connCard({ icon: 'O', title: 'Outlook',
      text: 'Drei Wege – nimm, was zu dir passt:',
      right: null,
      extra: h('ul', { class: 'ways' },
        h('li', {}, h('strong', { text: 'Outlook-App: ' }), 'über „Mein Mac“ (klassisches Outlook). ',
          h('span', { class: `pill ${conn.mac && mac ? 'green' : ''}`, text: conn.mac && mac ? 'aktiv' : 'aus' })),
        h('li', {}, h('strong', { text: 'Outlook im Browser: ' }), 'über Chrome (outlook.com oder Microsoft 365 im Web). ',
          h('span', { class: `pill ${conn.chrome ? 'green' : ''}`, text: conn.chrome ? 'aktiv' : 'aus' })),
        h('li', {}, h('strong', { text: 'Microsoft 365: ' }), 'claude.ai-Verbindung, nur mit Firmenkonto. ',
          statusPill(m365, ui.connections ? 'nicht verbunden' : '–'))) }),

    connCard({ icon: '◎', title: 'Chrome',
      text: 'Claude öffnet und bedient Webseiten in deinem Chrome – z. B. Outlook oder Gmail im Browser.',
      right: connSwitch('chrome', 'Chrome verbinden', false),
      extra: h('div', { class: 'conn-extra' },
        h('div', { class: 'sub', text: 'Dafür brauchst du die Chrome-Erweiterung „Claude in Chrome“ und musst in ihr angemeldet sein. Diese Verbindung ist neu – falls sie hakt, sag mir Bescheid.' }),
        h('div', { class: 'actions' }, link('https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn', 'Erweiterung installieren'))) }),

    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Weitere Verbindungen' })),
      !ui.connections
        ? h('div', { class: 'card empty', text: ui.connectionsLoading ? 'Wird geprüft …' : 'Klick auf „Status prüfen“.' })
        : others.length
          ? h('div', { class: 'card list' }, others.map((c) => h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'title', text: c.name }), h('div', { class: 'sub', text: c.statusText })),
            h('span', { class: `pill ${STATUS_PILL[c.status]}`, text: STATUS_LABEL[c.status] }))))
          : h('div', { class: 'card empty', text: 'Keine weiteren Verbindungen eingerichtet.' }))));
}

