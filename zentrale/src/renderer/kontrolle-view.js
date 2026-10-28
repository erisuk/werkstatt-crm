// Ansicht „Kontrollraum“: blinde Flecken, Tempo & Fehler (aus dem Data Layer), Simulation, Schutz.
// Nutzt die Helfer aus app.js (h, fill, ui, api …).

const kr = { tab: 'flecken', report: null, loading: false, probes: null, probing: false, message: null, dryKind: 'upload', dryDetail: '', bitTopic: '' };
const KR_TABS = [{ id: 'flecken', label: 'Blinde Flecken' }, { id: 'tempo', label: 'Tempo & Fehler' }, { id: 'simulation', label: 'Simulation' }, { id: 'schutz', label: 'Schutz' }];
const KR_LEVEL = { rot: ['dringend', 'red'], gelb: ['fehlt', 'amber'], info: ['Hinweis', ''], ok: ['ok', 'green'] };

async function loadKontrolle() {
  if (kr.loading) return;
  kr.loading = true;
  try { kr.report = await api.kontrolleReport(); } catch (e) { kr.message = e.message; }
  kr.loading = false;
  if (ui.view === 'kontrolle') renderKontrolleBody();
}

function krGo(action) {
  if (!action) return;
  if (action.view === 'kontrolle') { kr.tab = action.tab || 'flecken'; renderKontrolle(); return; }
  if (action.view === 'mac' && typeof macv !== 'undefined' && action.tab) macv.tab = action.tab;
  if (action.tab && action.view === 'web') api.webShow(action.tab);
  setView(action.view);
}

function krSpots() {
  const r = kr.report;
  if (!r) return h('div', { class: 'card empty', text: kr.loading ? 'Prüft …' : 'Noch nicht geprüft.' });
  if (!r.spots.length) return h('div', { class: 'card empty', text: 'Keine blinden Flecken gefunden. 🎉' });
  return h('div', { class: 'card list' }, r.spots.map((s) => h('div', { class: 'row' },
    h('span', { class: `pill ${KR_LEVEL[s.level][1]}`, text: KR_LEVEL[s.level][0] }),
    h('div', { class: 'grow' }, h('div', { class: 'title', text: s.title }), s.detail ? h('div', { class: 'sub', text: s.detail }) : null),
    s.action ? h('button', { class: 'link', 'aria-label': `${s.action.label}: ${s.title}`, onClick: () => krGo(s.action) }, s.action.label) : null)));
}

const krName = (n) => n.replace(/^ipc:/, '').replace(/^daten:/, 'Daten · ').replace(/^ansicht:/, 'Seite · ');
function krTempo() {
  const r = kr.report;
  if (!r) return h('div', { class: 'card empty', text: 'Lädt …' });
  const d = r.data;
  const table = (rows, cols) => rows.length ? h('table', { class: 'kr-table' },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col', text: c[0] })))),
    h('tbody', {}, rows.map((x) => h('tr', {}, cols.map((c) => h('td', { text: c[1](x) }))))))
    : h('div', { class: 'empty', text: 'Noch keine Daten.' });
  return [
    h('p', { class: 'date', text: `Gemessen seit ${new Date(d.since).toLocaleString('de-DE')} · ${d.total.toLocaleString('de-DE')} Abfragen. Gespeichert werden nur Namen und Zeiten – keine Inhalte, nichts aus „Privat“.` }),
    h('section', { class: 'section' }, h('h2', { text: 'Am langsamsten' }), h('div', { class: 'card' },
      table(d.slowest, [['Ablauf', (x) => krName(x.name)], ['im Schnitt', (x) => `${x.avgMs} ms`], ['längster', (x) => `${x.maxMs} ms`], ['Anzahl', (x) => String(x.count)]]))),
    h('section', { class: 'section' }, h('h2', { text: 'Fehler der letzten 7 Tage' }), h('div', { class: 'card' },
      table(d.errors, [['Wann', (x) => new Date(x.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })], ['Wo', (x) => krName(x.where)], ['Was', (x) => x.code]]))),
    h('section', { class: 'section' }, h('h2', { text: 'Am häufigsten' }), h('div', { class: 'card' },
      table(d.busiest, [['Ablauf', (x) => krName(x.name)], ['Anzahl', (x) => String(x.count)], ['im Schnitt', (x) => `${x.avgMs} ms`]]))),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onClick: async () => { if (confirm('Alle Messwerte zurücksetzen?')) { await api.kontrolleReset(); loadKontrolle(); } } }, 'Messwerte zurücksetzen')),
  ];
}

function krSimulation() {
  const dry = ui.state && ui.state.dryRun;
  const kind = h('select', { id: 'kr-dry-kind', 'data-focus': 'kr-dry-kind' },
    [['upload', 'Upload aus dem Planer'], ['n8n', 'n8n-Workflow'], ['kommentare', 'Kommentare einsammeln'], ['frei', 'Eigene Aufgabe']].map(([v, t]) => h('option', { value: v }, t)));
  kind.value = kr.dryKind;
  kind.addEventListener('change', () => { kr.dryKind = kind.value; });
  const detail = h('input', { id: 'kr-dry-detail', type: 'text', placeholder: 'Welcher Beitrag / Workflow / welche Aufgabe?', 'data-focus': 'kr-dry-detail' });
  detail.value = kr.dryDetail;
  detail.addEventListener('input', () => { kr.dryDetail = detail.value; });
  const topic = h('input', { id: 'kr-bit-topic', type: 'text', placeholder: 'leer = nächstes Wunsch- oder Radar-Thema', 'data-focus': 'kr-bit-topic' });
  topic.value = kr.bitTopic;
  topic.addEventListener('input', () => { kr.bitTopic = topic.value; });
  return [
    h('section', { class: 'section' }, h('div', { class: 'section-head wrap' }, h('h2', { text: 'Notfall-Probe' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', 'data-focus': 'kr-probe', disabled: kr.probing, onClick: async () => { kr.probing = true; renderKontrolleBody(); kr.probes = await api.simNotfall(); kr.probing = false; renderKontrolleBody(); announce('Notfall-Probe fertig.'); } }, kr.probing ? 'Läuft …' : 'Notfall-Probe starten'),
      h('button', { class: 'btn ghost', onClick: () => api.simTestNotify() }, 'Test-Mitteilung')),
    h('p', { class: 'date', text: 'Spielt Störungen mit gespielten Daten durch – nichts wird wirklich abgeschaltet. Was die Zentrale nicht bemerkt, ist ein blinder Fleck.' }),
    kr.probes ? h('div', { class: 'card list' }, kr.probes.map((p) => h('div', { class: 'row' },
      h('span', { class: `pill ${p.covered ? 'green' : 'red'}`, text: p.covered ? 'erkannt' : 'blinder Fleck' }),
      h('div', { class: 'grow' }, h('div', { class: 'title', text: p.title }), h('div', { class: 'sub', text: p.what }))))) : null),
    h('section', { class: 'section' }, h('h2', { text: 'Probelauf' }),
      h('p', { class: 'date', text: '30 Minuten lang klickt, tippt und lädt Claude in den Web-Tabs nichts wirklich und ändert keine n8n-Workflows – die Zentrale blockiert das selbst. Claude spielt alles durch und zeigt dir, was passieren würde.' }),
      dry ? h('div', { class: 'notice', text: `Probelauf läuft bis ${new Date(dry).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}.` }, ' ',
        h('button', { class: 'link', onClick: async () => { await api.simDryRunStop(); } }, 'Beenden')) : null,
      h('div', { class: 'card form' },
        h('div', { class: 'field' }, h('label', { for: 'kr-dry-kind', text: 'Was durchspielen?' }), kind),
        h('div', { class: 'field' }, h('label', { for: 'kr-dry-detail', text: 'Genauer' }), detail),
        h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
          h('button', { class: 'btn', disabled: !ui.state.claude.found, onClick: async () => {
            if (!okToLeaveBusyChat()) return;
            const r = await api.simDryRunStart(kr.dryKind, kr.dryDetail);
            if (r && r.ok) sendMessage(r.prompt);
          } }, 'Probelauf starten')))),
    h('section', { class: 'section' }, h('h2', { text: 'Bit-Video vorab' }),
      h('p', { class: 'date', text: 'Claude entwirft das Video nur auf dem Papier: Quelle, Skript, Länge, geschätzte Credits und die Prüfungen – ohne Rendern, ohne Stimme, ohne Credits.' }),
      h('div', { class: 'card form' },
        h('div', { class: 'field full' }, h('label', { for: 'kr-bit-topic', text: 'Thema' }), topic),
        h('div', { class: 'actions full' }, h('span', { class: 'spacer' }),
          h('button', { class: 'btn', disabled: !ui.state.claude.found, onClick: async () => {
            if (!okToLeaveBusyChat()) return;
            const r = await api.simBitPreview(kr.bitTopic);
            if (r && r.ok) sendMessage(r.prompt);
          } }, 'Vorab simulieren')))),
    h('p', { class: 'date', text: 'Finanz-Szenarien („Was wäre wenn“) findest du im Bereich Privat – dort bleiben die Zahlen.' }),
  ];
}

function krSchutz() {
  const r = kr.report;
  const lock = settings().appLock || { enabled: true, minutes: 15 };
  const minutes = h('select', { id: 'kr-lock-min', 'data-focus': 'kr-lock-min', onChange: (e) => api.updateSettings({ appLock: { minutes: Number(e.target.value) } }) },
    [1, 5, 15, 30, 60].map((m) => h('option', { value: String(m) }, `${m} Min`)));
  minutes.value = String(lock.minutes);
  return [
    h('section', { class: 'section' }, h('div', { class: 'section-head wrap' }, h('h2', { text: 'App-Sperre' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', 'data-focus': 'kr-lock-now', onClick: () => api.appLock() }, 'Jetzt sperren')),
      h('div', { class: 'card form' },
        h('label', { class: 'toggle-line full' },
          h('button', { class: 'switch', role: 'switch', 'aria-checked': String(lock.enabled), 'aria-label': 'App-Sperre mit Touch ID', 'data-focus': 'kr-lock',
            onClick: async () => { if (lock.enabled && !confirm('App-Sperre wirklich ausschalten? Dann sieht jeder, der an deinen Mac kommt, alles in der Zentrale.')) return; await api.updateSettings({ appLock: { enabled: !lock.enabled } }); } }),
          'Sperre mit Touch ID beim Start und nach'), h('div', { class: 'field' }, h('label', { for: 'kr-lock-min', text: 'ohne Nutzung' }), minutes))),
    h('section', { class: 'section' }, h('h2', { text: 'Sicherheits-Check' }),
      !r ? h('div', { class: 'card empty', text: 'Prüft …' }) : h('div', { class: 'card list' }, r.security.map((s) => h('div', { class: 'row' },
        h('span', { class: `pill ${KR_LEVEL[s.ok ? 'ok' : s.level][1]}`, text: s.ok ? 'geschützt' : KR_LEVEL[s.level][0] }),
        h('div', { class: 'grow' }, h('div', { class: 'title', text: s.title }), h('div', { class: 'sub', text: s.detail })))))),
    h('p', { class: 'date', text: 'Ehrlich: Eine Garantie „unhackbar“ gibt es nicht. Die Zentrale schließt die Wege, die es gibt – kein Zugang aus dem Netz, verschlüsselte Daten, Sperre, keine fremden Programme mit ihrer Identität. Das Wichtigste bleibt bei dir: Mac-Passwort, Updates und ein Backup.' }),
  ];
}

function renderKontrolleBody() {
  const box = $('#kr-body');
  if (!box) return;
  keepFocus(() => fill(box,
    noticeEl(kr.message),
    kr.tab === 'flecken' ? krSpots() : kr.tab === 'tempo' ? krTempo() : kr.tab === 'simulation' ? krSimulation() : krSchutz()));
}

function renderKontrolle() {
  kr.message = null;
  fill($('#main'),
    h('div', { class: 'section-head wrap' }, h('h1', { text: 'Kontrollraum' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: loadKontrolle }, 'Neu prüfen')),
    h('p', { class: 'date', text: 'Was fehlt, was scheitert, was langsam ist – und wie gut die Zentrale geschützt ist. Alles wird nur auf diesem Mac gemessen.' }),
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Bereiche' }, KR_TABS.map((t) => h('button', { 'aria-pressed': String(kr.tab === t.id), 'data-focus': `kr-tab:${t.id}`,
      onClick: () => { kr.tab = t.id; renderKontrolle(); } }, t.label))),
    h('div', { id: 'kr-body', class: 'section' }));
  renderKontrolleBody();
  loadKontrolle();
}
