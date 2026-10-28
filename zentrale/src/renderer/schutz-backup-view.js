// Kontrollraum → Schutz: Backup (Time Machine + eigene Sicherung der Zentrale) und Mac-Firewall.
// Nutzt die Helfer aus app.js und kontrolle-view.js (h, api, kr, KR_LEVEL, renderKontrolleBody).

const sb = { state: null, busy: null, loading: false };

async function loadSchutz() {
  try { sb.state = await api.schutzState(); } catch (e) { kr.message = e.message; }
  if (ui.view === 'kontrolle' && kr.tab === 'schutz') renderKontrolleBody();
}

// Knopf, der während seiner Aktion gesperrt ist und danach Ergebnis + Zustand neu lädt.
function sbAction(id, label, fn, cls = 'btn') {
  return h('button', { class: cls, 'data-focus': `sb-${id}`, disabled: sb.busy !== null, 'aria-busy': String(sb.busy === id), onClick: async () => {
    sb.busy = id; renderKontrolleBody();
    try {
      const r = await fn();
      kr.message = (r && (r.message || r.error)) || null;
    } catch (e) { kr.message = e.message; }
    sb.busy = null;
    await loadSchutz();
    loadKontrolle();
  } }, sb.busy === id ? 'Läuft …' : label);
}

const sbDate = (t) => new Date(t).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const sbPill = (ok, okText, badText, level = 'rot') => h('span', { class: `pill ${KR_LEVEL[ok ? 'ok' : level][1]}`, text: ok ? okText : badText });

function sbTimeMachine(tm) {
  return h('div', { class: 'row' },
    sbPill(tm.configured, tm.running ? 'sichert gerade' : 'an', 'fehlt'),
    h('div', { class: 'grow' }, h('div', { class: 'title', text: 'Time Machine – sichert den ganzen Mac' }),
      h('div', { class: 'sub', text: tm.configured
        ? `Platte: ${tm.disks.join(', ')}${tm.latest ? ` · letztes Backup ${tm.latest}` : ''}. Sichert alles – Projekte, Fotos, die Zentrale.`
        : 'Noch keine Platte. Du brauchst eine externe Festplatte (am besten so groß wie dein Mac oder größer). Anstecken, dann „Einrichten“ – macOS führt dich durch.' })),
    tm.configured ? sbAction('tm-start', 'Jetzt sichern', () => api.tmStart().then((r) => (r.ok ? { message: 'Time Machine sichert jetzt im Hintergrund.' } : r))) : null,
    sbAction('tm-open', tm.configured ? 'Einstellungen' : 'Einrichten', () => api.tmOpen(), tm.configured ? 'btn ghost' : 'btn'));
}

function sbOwnBackup(s) {
  const { cfg, target, last, list } = s;
  const where = !cfg.dir ? 'Noch kein Ordner gewählt.'
    : target && target.ok ? `${cfg.dir.replace(/^\/Users\/[^/]+/, '~')}${target.sameDisk ? ' – liegt auf der Mac-Platte: schützt vor Versehen, nicht vor einem Defekt. Besser eine externe Platte.' : ''}`
    : `${cfg.dir.replace(/^\/Users\/[^/]+/, '~')} – ${target ? target.error : ''}`;
  const auto = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!cfg.auto), 'aria-label': 'Täglich automatisch sichern', 'data-focus': 'sb-auto',
    disabled: !cfg.dir, onClick: async () => { await api.updateSettings({ backup: { auto: !cfg.auto } }); await loadSchutz(); } });
  return [
    h('div', { class: 'row' },
      sbPill(!!(last && last.lastAt), 'gesichert', cfg.dir ? 'noch nie' : 'kein Ordner', cfg.dir ? 'gelb' : 'info'),
      h('div', { class: 'grow' }, h('div', { class: 'title', text: 'Sicherung der Zentrale' }),
        h('div', { class: 'sub', text: where }),
        last && last.lastAt ? h('div', { class: 'sub', text: `Zuletzt: ${sbDate(last.lastAt)} · ${list.length} Sicherung(en) vorhanden, die 7 neuesten bleiben liegen.` }) : null,
        last && last.lastError ? h('div', { class: 'sub', text: `Letzter Fehler: ${last.lastError}` }) : null),
      sbAction('choose', cfg.dir ? 'Ordner ändern' : 'Ordner wählen', () => api.backupChoose(), cfg.dir ? 'btn ghost' : 'btn'),
      cfg.dir ? sbAction('run', 'Jetzt sichern', () => api.backupRun().then((r) => (r.ok ? { message: `Gesichert: ${r.items} Einträge.${r.removed ? ` ${r.removed} alte Sicherung(en) in den Papierkorb.` : ''}` } : r))) : null,
      cfg.dir && target && target.ok ? sbAction('show', 'Im Finder', () => api.backupShow(), 'btn ghost') : null),
    h('label', { class: 'toggle-line full' }, auto, 'Täglich automatisch sichern, sobald der Ordner erreichbar ist'),
    h('p', { class: 'date', text: 'Gesichert werden Einstellungen, Planer, Web-Tabs (ohne Anmeldungen), Lernen, Training, Kommentare und dein privater Finanzbereich – der bleibt verschlüsselt und ist nur mit dem Schlüsselbund dieses Macs lesbar. iCloud-, Dropbox- und Google-Drive-Ordner lehnt die Zentrale ab, damit nichts auf einem fremden Server landet.' }),
  ];
}

function sbFirewall(fw, exposed) {
  return [
    h('div', { class: 'row' },
      sbPill(fw.on, fw.stealth ? 'an · Tarnmodus' : 'an', 'aus', 'gelb'),
      h('div', { class: 'grow' }, h('div', { class: 'title', text: 'Mac-Firewall' }),
        h('div', { class: 'sub', text: fw.on ? 'Eingehende Verbindungen aus dem Netz werden gefiltert. Programme, die erreichbar sein sollen, hast du (oder macOS) freigegeben.'
          : 'Aus. Jedes Programm, das auf Verbindungen wartet, ist für andere Geräte im selben WLAN erreichbar.' })),
      !fw.on ? sbAction('fw-on', 'Einschalten', () => api.fwEnable(false).then((r) => (r.ok ? { message: 'Die Firewall ist an.' } : r))) : null,
      fw.on && !fw.stealth ? sbAction('fw-stealth', 'Tarnmodus an', () => api.fwEnable(true).then((r) => (r.ok ? { message: 'Firewall und Tarnmodus sind an – der Mac antwortet nicht mehr auf Pings aus dem Netz.' } : r)), 'btn ghost') : null,
      sbAction('fw-open', 'Einstellungen', () => api.fwOpen(), 'btn ghost')),
    exposed.length ? h('div', { class: 'sb-sub' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: 'Gerade aus dem Netz erreichbar' }),
        h('div', { class: 'sub', text: fw.on ? 'Diese Programme warten auf Verbindungen von anderen Geräten.' : 'Mit Firewall fragt macOS bei diesen Programmen einmal „Eingehende Verbindungen erlauben?“. Erlaube nur, was du vom Handy oder anderen Geräten wirklich brauchst (z. B. Ollama für das Handy-Werkzeug).' }))),
      exposed.map((x) => h('div', { class: 'row' }, h('span', { class: 'kind', text: x.ports.map((p) => `:${p}`).join(' ') }), h('div', { class: 'grow' }, h('div', { class: 'title', text: x.name })))))
      : null,
  ];
}

function krBackupSections() {
  const s = sb.state;
  if (!s) { if (!sb.loading) { sb.loading = true; loadSchutz().finally(() => { sb.loading = false; }); } return [h('section', { class: 'section' }, h('h2', { text: 'Backup' }), h('div', { class: 'card empty', text: 'Prüft …' }))]; }
  return [
    h('section', { class: 'section' }, h('h2', { text: 'Backup' }), h('div', { class: 'card list sb' }, sbTimeMachine(s.tm), ...sbOwnBackup(s))),
    h('section', { class: 'section' }, h('h2', { text: 'Firewall' }), h('div', { class: 'card list sb' }, ...sbFirewall(s.fw, s.exposed))),
  ];
}
