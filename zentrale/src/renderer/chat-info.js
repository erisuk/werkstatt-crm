// Info-Leiste im Chat wie in der Claude-App: Umgebung, Kontext, Konnektoren, Ausgaben, Änderungen.
// Sie ersetzt im Chat die rechte Spalte (Aufgaben, Musik, Schnell fragen); die Agenten bleiben darunter.
const CHAT_ENV_MS = 60 * 1000;
const CONNECTORS_SHOWN = 3;
const OUTPUTS_SHOWN = 8;
const OUTPUT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

function chatInfoOpen() {
  if (typeof ui.chatInfoOpen === 'boolean') return ui.chatInfoOpen;
  try { ui.chatInfoOpen = localStorage.getItem('chatInfoOpen') !== '0'; } catch { ui.chatInfoOpen = true; }
  return ui.chatInfoOpen;
}

function toggleChatInfo() {
  ui.chatInfoOpen = !chatInfoOpen();
  try { localStorage.setItem('chatInfoOpen', ui.chatInfoOpen ? '1' : '0'); } catch { /* nur Bequemlichkeit */ }
  renderChatInfo();
  updateChatHead(true);
}

// Git-Angaben des Arbeitsordners: einmal pro Minute oder wenn der Ordner wechselt.
function loadChatEnv(cwd, force) {
  if (!force && ui.chatEnv && ui.chatEnv.cwd === cwd && Date.now() - ui.chatEnvAt < CHAT_ENV_MS) return;
  if (ui.chatEnvLoading === cwd) return;
  ui.chatEnvLoading = cwd;
  api.chatEnv(cwd, force).then((env) => {
    ui.chatEnvLoading = null;
    ui.chatEnv = env || { cwd, folder: cwd.split('/').pop() || cwd, git: false };
    ui.chatEnvAt = Date.now();
    renderChatInfo();
  }).catch(() => { ui.chatEnvLoading = null; });
}

// Dateien, die Claude in diesem Chat angelegt oder geändert hat – die neueste zuerst.
function chatOutputs() {
  const seen = new Set();
  const out = [];
  for (let i = ui.messages.length - 1; i >= 0; i -= 1) {
    const m = ui.messages[i];
    if (m.kind !== 'tool' || !OUTPUT_TOOLS.test(m.tool || '') || !m.path || m.error || seen.has(m.path)) continue;
    seen.add(m.path);
    out.push(m.path);
  }
  return out;
}

function prettyServer(name) {
  const n = String(name).replace(/^claude\.ai\s+/, '').replace(/^plugin:[^:]+:/, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function infoSection(title, ...children) {
  return h('section', { class: 'info-section' }, h('h3', { text: title }), ...children);
}

function infoRow(icon, label, opts = {}) {
  return h(opts.onClick ? 'button' : 'div', { class: `info-row${opts.onClick ? ' clickable' : ''}`, title: opts.title || label, onClick: opts.onClick },
    h('span', { class: 'info-icon', 'aria-hidden': 'true', text: icon }),
    h('span', { class: 'info-label', text: label }),
    opts.right ? h('span', { class: `info-right ${opts.rightClass || ''}`, text: opts.right }) : null);
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace('.', ',')}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace('.', ',')}k` : String(n);
}

function contextSection(c) {
  const ctx = c.context;
  if (!ctx || !ctx.used) return infoSection('Kontext', h('p', { class: 'info-empty', text: 'Kommt mit Claudes erster Antwort.' }));
  const win = ctx.window || 200000;
  const pct = (n) => Math.min(100, (n / win) * 100);
  const base = ctx.baseline && ctx.baseline <= ctx.used ? ctx.baseline : 0;
  const talk = ctx.used - base;
  const free = Math.max(0, win - ctx.used);
  const fmtPct = (n) => `${pct(n).toFixed(1).replace('.', ',')} %`;
  const bar = h('div', { class: 'ctx-bar', role: 'img', 'aria-label': `${Math.round(pct(ctx.used))} Prozent genutzt` },
    h('span', { class: 'ctx-talk', style: { width: `${pct(talk)}%` } }),
    base ? h('span', { class: 'ctx-base', style: { width: `${pct(base)}%` } }) : null);
  const legend = [
    ['ctx-talk', base ? 'Gespräch' : 'Gesamt', talk],
    base ? ['ctx-base', 'Grundausstattung', base] : null,
    ['ctx-free', 'Frei', free],
  ].filter(Boolean).map(([cls, label, n]) => h('div', { class: 'ctx-row' },
    h('span', { class: `ctx-dot ${cls}` }), h('span', { class: 'ctx-label', text: label }),
    h('span', { class: 'ctx-num', text: fmtTokens(n) }), h('span', { class: 'ctx-pct', text: fmtPct(n) })));
  return infoSection('Kontext',
    h('div', { class: 'ctx-head' }, h('span', { text: `${Math.round(pct(ctx.used))} % genutzt` }), h('span', { class: 'ctx-total', text: `${fmtTokens(ctx.used)} / ${fmtTokens(win)}` })),
    bar, ...legend,
    base ? h('p', { class: 'info-note', text: 'Grundausstattung = System, Werkzeuge und Gedächtnis beim Start dieses Gesprächs.' }) : null);
}

function connectorsSection(c) {
  const list = Array.isArray(c.mcp) ? c.mcp : [];
  if (!list.length) return infoSection('Konnektoren', h('p', { class: 'info-empty', text: 'Kommt mit Claudes erster Antwort.' }));
  // Erst, was Aufmerksamkeit braucht – wie in der Claude-App.
  const order = { 'needs-auth': 0, failed: 1, connected: 2 };
  const sorted = [...list].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || prettyServer(a.name).localeCompare(prettyServer(b.name)));
  const shown = ui.chatInfoMore ? sorted : sorted.slice(0, CONNECTORS_SHOWN);
  const rows = shown.map((x) => {
    const label = prettyServer(x.name);
    if (x.status === 'connected') return infoRow('●', label, { right: 'verbunden', rightClass: 'ok' });
    if (x.status === 'needs-auth') {
      const onClaudeAi = /^claude\.ai\s/.test(x.name);
      return infoRow('○', label, {
        right: 'Anmelden', rightClass: 'warn',
        title: onClaudeAi ? 'Auf claude.ai unter „Connectors“ anmelden' : 'Im Terminal mit „claude“ und dann „/mcp“ anmelden',
        onClick: onClaudeAi ? () => api.openExternal('https://claude.ai/settings/connectors') : () => alert(`„${label}“ meldest du im Terminal an: „claude“ starten, dann „/mcp“ eingeben.`),
      });
    }
    return infoRow('○', label, { right: x.status === 'failed' ? 'Fehler' : 'aus', rightClass: x.status === 'failed' ? 'bad' : '' });
  });
  const connected = list.filter((x) => x.status === 'connected').length;
  const more = sorted.length > CONNECTORS_SHOWN
    ? h('button', { class: 'link', 'data-focus': 'info-more', onClick: () => { ui.chatInfoMore = !ui.chatInfoMore; renderChatInfo(); } },
      ui.chatInfoMore ? 'Weniger anzeigen' : `Mehr anzeigen (${sorted.length - CONNECTORS_SHOWN})`) : null;
  return infoSection(`Konnektoren · ${connected} von ${list.length} verbunden`, ...rows, more);
}

function outputsSection() {
  const outs = chatOutputs();
  if (!outs.length) return infoSection('Ausgaben', h('p', { class: 'info-empty', text: 'Noch keine Dateien in diesem Chat.' }));
  return infoSection('Ausgaben', ...outs.slice(0, OUTPUTS_SHOWN).map((p) =>
    infoRow('▤', p.split('/').pop(), { title: `${p}\nKlicken zum Öffnen`, onClick: () => api.fsOpen(p) })));
}

function changesSection(env) {
  if (!env) return infoSection('Änderungen', h('p', { class: 'info-empty', text: 'Wird geladen …' }));
  if (!env.git) return infoSection('Änderungen', h('p', { class: 'info-empty', text: 'Kein Git-Projekt.' }));
  const rows = [];
  if (env.pr) rows.push(infoRow('⑂', `${env.pr.title} · #${env.pr.number}`, { title: env.pr.url, onClick: () => api.openExternal(env.pr.url) }));
  for (const x of env.commits || []) rows.push(infoRow('•', x.subject || x.hash, { title: x.hash }));
  return infoSection('Änderungen', ...(rows.length ? rows : [h('p', { class: 'info-empty', text: 'Noch keine Commits.' })]));
}

function envSection(c, env) {
  const rows = [infoRow('⌂', c.name, { title: `${c.cwd}\nIm Finder zeigen`, onClick: () => api.fsReveal(c.cwd) })];
  if (env && env.git) {
    if (env.repo && env.repo !== c.name) rows.push(infoRow('▣', env.repo, { title: 'Git-Projekt' }));
    if (env.branch) rows.push(infoRow('⑂', env.branch, { title: 'Branch' }));
  }
  for (const d of c.addDirs || []) rows.push(extraDirRow(d));
  rows.push(h('button', { class: 'link info-add', 'data-focus': 'info-add-dir', title: 'Claude arbeitet dann auch in diesem Ordner',
    onClick: addChatFolder }, '+ Ordner hinzufügen'));
  return infoSection('Umgebung', ...rows);
}

// Ein weiterer Ordner: Name, Verknüpfung (🔗 = kommt bei jedem neuen Chat in diesem Projekt mit), entfernen.
function extraDirRow(d) {
  return h('div', { class: 'info-row extra-dir' },
    h('span', { class: 'info-icon', 'aria-hidden': 'true', text: '+' }),
    h('button', { class: 'info-label link-plain', title: `${d.path}\nIm Finder zeigen`, onClick: () => api.fsReveal(d.path) }, d.name),
    h('button', { class: `dir-link${d.linked ? ' on' : ''}`, 'data-focus': `dir-link:${d.path}`, 'aria-pressed': String(!!d.linked),
      title: d.linked ? 'Verknüpft: kommt bei jedem neuen Chat in diesem Projekt mit. Klicken zum Lösen.' : 'Mit diesem Projekt verknüpfen: kommt dann bei jedem neuen Chat hier mit',
      onClick: () => api.chatFolderLink(d.path, !d.linked) }, d.linked ? 'verknüpft' : 'verknüpfen'),
    h('button', { class: 'dir-remove', 'aria-label': `${d.name} aus dem Chat nehmen`, 'data-focus': `dir-remove:${d.path}`,
      onClick: () => api.chatFolderRemove(d.path) }, '×'));
}

async function addChatFolder() {
  const link = confirm('Soll dieser Ordner dauerhaft mit dem Projekt verknüpft werden?\n\nOK = auch jeder neue Chat in diesem Projekt sieht ihn.\nAbbrechen = nur in diesem Chat.');
  const res = await api.chatFolderAdd(link);
  if (res && res.error) alert(res.error);
}

function renderChatInfo() {
  const box = $('#chat-info');
  const aside = $('.aside');
  if (!box || !aside) return;
  const c = ui.state && ui.state.chat;
  const show = ui.view === 'chat' && !!c && chatInfoOpen();
  box.hidden = !show;
  aside.classList.toggle('chat-mode', show);
  if (!show) return;
  loadChatEnv(c.cwd);
  const env = ui.chatEnv && ui.chatEnv.cwd === c.cwd ? ui.chatEnv : null;
  const outs = chatOutputs();
  if (!changed('chatInfo', [c.cwd, c.context, c.mcp, c.addDirs, outs, env, ui.chatInfoMore])) return;
  keepFocus(() => fill(box, envSection(c, env), contextSection(c), connectorsSection(c), outputsSection(), changesSection(env)));
}
