// Hauptprozess: öffnet das Fenster, startet Claude automatisch und hält alles synchron.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, nativeImage, safeStorage, clipboard, globalShortcut, systemPreferences, powerMonitor, net } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { resolveClaude, ClaudeChat, runTask, stopAllTasks, listMcpServers, permissionModeFor } = require('./claude');
const { listProjects, readMessages, watchSessions, shortTitle, DEFAULT_ROOT } = require('./sessions');
const { TaskScheduler } = require('./tasks');
const { Settings } = require('./settings');
const mac = require('./mac');
const { TopicStore, groupByTopic, TOPICS } = require('./categories');
const { desktopMeta } = require('./desktop-meta');
const library = require('./library');
const files = require('./files');
const music = require('./music');
const vault = require('./vault');
const servers = require('./servers');
const health = require('./health');
const { FolderWatcher } = require('./watcher');
const { AlertWatch } = require('./alerts');
const morning = require('./morning');
const { PlanStore, uploadPrompt, YT_API_TARGET } = require('./planner');
const { YouTube } = require('./youtube');
const { PortalStore, PRESETS, partitionFor, BIT_PROFILE, BIT_TABS, browserTarget } = require('./portals');
const { WebTabs, portalSession } = require('./web-tabs');
const { videoSite, cookieFileText, analyzePrompt } = require('./video-analyze');
const { WebsiteStudio, AGENT: WEB_AGENT } = require('./website-studio');
const { FinanceStore, summary: financeSummary, simulate: financeSimulate } = require('./finance');
const { importCsv } = require('./finance-csv');
const { MusicWatch } = require('./music-watch');
const simulation = require('./simulation');
const learning = require('./learning');
const training = require('./training');
const { DataLayer } = require('./data-layer');
const { blindSpots } = require('./blind-spots');
const security = require('./security');
const backup = require('./backup');
const { READ_ONLY_TOOLS } = require('./mcp/mac-server');
const { READ_ONLY_TOOLS: N8N_READ_ONLY } = require('./mcp/n8n-server');
const { N8n, DEFAULT_URL: N8N_DEFAULT_URL, normalizeBase, isLoopback } = require('./n8n');
const { startProxy, makeOps, socketPath: n8nSocketPath } = require('./n8n-proxy');
const { BrowserControl, makeBrowserOps } = require('./browser-control');
const { READ_ONLY_TOOLS: BROWSER_READ_ONLY } = require('./mcp/browser-server');
const { ALLOWED_TOOLS: KOMMENTARE_TOOLS } = require('./mcp/kommentare-server');
const kommentare = require('./kommentare');
const bitvideos = require('./bitvideos');

const KOMMENTARE_TASK = 'Bit: Kommentare einsammeln';
const KOMMENTARE_ZEIT = '18:00';
const KOMMENTARE_PROMPT = 'Hol dir mit dem Werkzeug kommentare_auftrag den aktuellen Auftrag und führe ihn genau so aus. '
  + 'Schreib, like und sende nichts. Bricht der Auftrag ab (z. B. weil ein anderes Konto angemeldet ist), melde nur den Grund.';

// Links, die die Oberfläche öffnen darf.
const EXTERNAL_LINKS = new Set([
  'https://claude.ai/settings/connectors',
  'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
]);

// Läuft im angemeldeten n8n-Tab (eigene, isolierte Skriptwelt) und legt dort einen API-Schlüssel an.
// n8n verlangt bei Anfragen mit Anmelde-Cookie die browser-id aus dem localStorage der Seite.
const N8N_WORLD = 1730;
const N8N_CREATE_KEY = `(async () => {
  const headers = { 'Content-Type': 'application/json', 'browser-id': localStorage.getItem('n8n-browserId') || '' };
  const me = await fetch('/rest/login', { headers, credentials: 'include' });
  if (!me.ok) return { error: 'login' };
  let scopes = null;
  try { const r = await fetch('/rest/api-keys/scopes', { headers, credentials: 'include' }); if (r.ok) { const j = await r.json(); if (Array.isArray(j.data)) scopes = j.data; } } catch (e) {}
  const body = { label: 'Zentrale ' + new Date().toISOString().slice(0, 10), expiresAt: null };
  if (scopes) body.scopes = scopes;
  const r = await fetch('/rest/api-keys', { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) return { error: 'http', status: r.status, message: (j && j.message) || text.slice(0, 160) };
  const d = (j && j.data) || {};
  const key = d.rawApiKey || (typeof d.apiKey === 'string' && !d.apiKey.includes('*') ? d.apiKey : null);
  return key ? { key } : { error: 'nokey' };
})()`;

// Hinweis an Claude: das Gehirn des Nutzers ist sein Obsidian-Vault.
const vaultHint = (dir) => `Das Gedächtnis („Gehirn“) des Nutzers ist sein Obsidian-Vault unter ${dir}. `
  + 'Bevor du zu Personen, Projekten oder früheren Entscheidungen antwortest, schau dort nach (z. B. mit /was-weiss-ich oder Grep). '
  + 'Neue wichtige Erkenntnisse legst du mit /merk-dir ab; Notizen im Vault nie löschen, nur ergänzen.';

// Hinweis an Claude, wenn „Web-Tabs für Claude“ eingeschaltet ist.
const WEB_HINT = 'Du läufst in der Zentrale des Nutzers. Webseiten (z. B. Meta Business, Shopify, Gmail, Instagram) bedienst du '
  + 'mit den Werkzeugen zentrale_web_* in den Web-Tabs der Zentrale, wo der Nutzer angemeldet ist und live zusieht – nicht mit '
  + 'Playwright und nicht mit einem separaten Chrome. Lies die Seite (zentrale_web_read) vor und nach jeder Aktion. '
  + 'Passwörter, Karten- und Bankdaten gibt nur der Nutzer selbst ein. Vor allem, was Geld kostet oder etwas veröffentlicht, '
  + 'fasst du zusammen, was passieren wird, und lässt den Nutzer entscheiden. '
  + 'Bei Social Media (YouTube, Instagram, TikTok, Facebook, Meta) prüfst du vor jeder Aktion, welches Konto angemeldet ist, und nennst es. '
  + 'Konten von MURIS (z. B. @shop.muris) bearbeitest du nie. Dateien wie Videos lädst du mit zentrale_web_upload hoch.';

// So frisch geschriebene Gespräche benutzt vermutlich gerade ein anderes Claude-Fenster.
const IN_USE_MS = 2 * 60 * 1000;

// Nur eine Zentrale gleichzeitig, sonst liefen tägliche Aufgaben doppelt.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  setup();
}

function setup() {
  // Data Layer: misst jeden IPC-Kanal (Dauer, Fehler) und hält Daten kurz zwischengespeichert.
  // Muss vor dem ersten ipcMain.handle stehen, damit alle Kanäle erfasst werden.
  const dataLayer = new DataLayer({ file: path.join(app.getPath('userData'), 'datenschicht.json') });
  dataLayer.wrapIpc(ipcMain);
  // App-Sperre: solange gesperrt, beantwortet die Zentrale nur „Entsperren“ – sonst nichts.
  let appLocked = false;
  const LOCK_ALLOWED = new Set(['app-unlock']);
  {
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => handle(channel, (e, ...a) => (appLocked && !LOCK_ALLOWED.has(channel) ? null : fn(e, ...a)));
  }
  let win = null;
  let claude = { bin: null, env: process.env, version: null, checking: true };
  let chat = null;
  let claudeAuthProblemAt = 0;
  let dryRunUntil = 0;
  const dryRunActive = () => Date.now() < dryRunUntil;
  let chatGen = 0;
  let scheduler = null;
  let settings = null;
  let topicStore = null;
  let webTabs = null;
  const iconCache = new Map();
  let sessionWatcher = null;
  let projectsCache = [];
  // Die Gesprächsliste ist groß (500+ Gespräche ≈ 200 KB) – sie geht nur mit, wenn sie sich wirklich geändert hat.
  let projectsRev = 0;
  let projectsJson = '';
  let sentProjectsRev = -1;
  let quitting = false;
  let cleanedUp = false;
  let macConfigFile = null;
  let n8nConfigFile = null;
  let n8nProxy = null;
  let browserProxy = null;
  let browser = null;
  let browserConfigFile = null;
  let kommentareConfigFile = null;
  const kommentareFile = () => path.join(app.getPath('userData'), 'kommentare.json');
  let n8nConfig = { url: 'http://localhost:5678', key: null };
  const taskChats = new Map(); // laufende Aufgaben-Chats → Name der Aufgabe
  const notified = new Set();
  const liveNotifications = new Set(); // Referenz halten, sonst geht der Klick auf die Mitteilung verloren
  // Anfragen aus der Oberfläche warten, bis die Suche nach Claude abgeschlossen ist.
  let markClaudeReady;
  const claudeReady = new Promise((r) => { markClaudeReady = r; });

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  // Jede Sitzung bekommt ihr Thema; der Textausschnitt dafür bleibt im Hauptprozess.
  // Titel, Archiv-Status und geplante Läufe kommen aus der Claude-App, sofern sie das Gespräch kennt.
  function withDesktopMeta(projects) {
    let meta;
    try { meta = desktopMeta(); } catch { meta = new Map(); }
    const generic = /^(wir setzen eine arbeit fort|unten steht der verlauf|ohne titel)/i;
    return projects.map((p) => ({ ...p, sessions: p.sessions.map((x) => {
      const m = meta.get(x.id);
      if (!m) return x;
      const title = m.title && !generic.test(m.title) ? m.title : x.title;
      return { ...x, title, archived: m.archived, scheduled: m.scheduled };
    }) }));
  }

  function refreshProjects() {
    try {
      const raw = withDesktopMeta(listProjects());
      const topicOf = new Map();
      for (const g of groupByTopic(raw, topicStore)) for (const x of g.sessions) topicOf.set(x.id, x);
      projectsCache = raw.map((p) => ({ ...p, sessions: p.sessions.map(({ snippet, ...x }) => ({
        ...x, topic: topicOf.get(x.id).topic, topicManual: topicOf.get(x.id).topicManual })) }));
    } catch { projectsCache = []; }
    const json = JSON.stringify(projectsCache, (k, v) => (k === 'updatedAt' ? Math.floor(v / 60000) : v));
    if (json !== projectsJson) { projectsJson = json; projectsRev += 1; }
    return projectsCache;
  }

  function chatInfo() {
    if (!chat) return null;
    return { gen: chatGen, cwd: chat.cwd, name: path.basename(chat.cwd) || chat.cwd, sessionId: chat.sessionId, status: chat.status,
      title: chat.title, careful: chat.permissionMode !== 'acceptEdits' && !allowAll(), allowAll: allowAll() };
  }

  // Einstellung „Ohne Rückfrage arbeiten“: Claude darf alles, ohne zu fragen (Standard, Eris' Wunsch).
  function allowAll() {
    return !!settings && settings.get().askFirst !== true;
  }

  function approvals() {
    const list = [];
    if (chat) for (const a of chat.pendingApprovals()) list.push({ ...a, source: chat.title ? `Chat „${chat.title}“` : 'Chat' });
    for (const [c, name] of taskChats) for (const a of c.pendingApprovals()) list.push({ ...a, source: `Tägliche Aufgabe „${name}“` });
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  function snapshot() {
    return {
      dryRun: dryRunActive() ? dryRunUntil : 0,
      claude: { found: !!claude.bin, checking: claude.checking, version: claude.version },
      projects: projectsCache,
      topics: TOPICS,
      chat: chatInfo(),
      tasks: scheduler ? scheduler.list() : [],
      approvals: approvals(),
      settings: settings ? settings.get() : null,
      platform: process.platform,
    };
  }

  function pushState() {
    const s = snapshot();
    if (sentProjectsRev === projectsRev) delete s.projects; // unverändert: die Oberfläche behält ihre Liste
    else sentProjectsRev = projectsRev;
    send('state', s);
  }

  // Mac-Mitteilung (Klick holt die Zentrale nach vorn). view: welche Ansicht dabei geöffnet werden soll.
  function notify(title, body, view) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: String(body || '').slice(0, 240) });
    liveNotifications.add(n);
    const drop = () => liveNotifications.delete(n);
    n.on('click', () => { drop(); if (!win) createWindow(); win.show(); win.focus(); if (view) send('go-view', view); });
    n.on('close', drop);
    n.show();
  }

  // Neue Freigabe-Anfragen melden, auch wenn das Fenster gerade nicht vorne ist.
  function onApprovalsChanged() {
    pushState();
    for (const a of approvals()) {
      if (notified.has(a.id)) continue;
      notified.add(a.id);
      if (win && win.isVisible() && win.isFocused()) continue;
      if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'Claude braucht deine Freigabe', body: `${a.title} · ${a.source}` });
        liveNotifications.add(n);
        const drop = () => liveNotifications.delete(n);
        n.on('click', () => { drop(); if (!win) createWindow(); win.show(); win.focus(); });
        n.on('close', drop);
        n.show();
      }
    }
  }

  // Zusätzliche Startoptionen für Claude, je nach eingeschalteten Verbindungen.
  function extraArgs() {
    const c = settings ? settings.get().connections : {};
    const args = [];
    const allowed = [];
    if (c.mac && macConfigFile) {
      args.push(`--mcp-config=${macConfigFile}`);
      allowed.push(...READ_ONLY_TOOLS.map((t) => `mcp__mac__${t}`));
    }
    if (n8nConfig.key && n8nConfigFile) {
      args.push(`--mcp-config=${n8nConfigFile}`);
      allowed.push(...N8N_READ_ONLY.map((t) => `mcp__n8n__${t}`));
    }
    if (c.web && browserConfigFile) {
      args.push(`--mcp-config=${browserConfigFile}`);
      allowed.push(...BROWSER_READ_ONLY.map((t) => `mcp__web__${t}`));
    }
    // Die Kommentar-Liste ist lokal – immer dabei, ohne Rückfrage.
    if (kommentareConfigFile) {
      args.push(`--mcp-config=${kommentareConfigFile}`);
      allowed.push(...KOMMENTARE_TOOLS.map((t) => `mcp__kommentare__${t}`));
    }
    // Ein gemeinsamer Hinweis: wo das Gehirn (Obsidian) liegt und – falls an – wie Webseiten bedient werden.
    const hints = [];
    const v = currentVault();
    if (v) hints.push(vaultHint(v.path));
    if (c.web && browserConfigFile) hints.push(WEB_HINT);
    hints.push(learning.systemHint(learnStore().activeLesson()));
    if (hints.length) args.push('--append-system-prompt', hints.join('\n\n'));
    if (allowed.length) args.push(`--allowedTools=${allowed.join(',')}`);
    if (c.chrome) args.push('--chrome');
    return args;
  }


  // Freigaben für Browser-Aktionen zeigen, welcher Knopf auf welcher Seite gemeint ist.
  function approvalInfo(toolName, input) {
    return browser ? browser.approvalInfo(toolName, input) : null;
  }

  // Die MCP-Server laufen mit dem normalen Node (das Claude Code ohnehin braucht) – nicht „als Zentrale“.
  // So darf in der installierten App niemand Code mit der Identität der Zentrale ausführen
  // (Fuse RunAsNode ist aus) und damit an ihren Schlüsselbund-Eintrag kommen.
  const NODE_BIN = ['/usr/local/bin/node', '/opt/homebrew/bin/node', path.join(os.homedir(), '.npm-global', 'bin', 'node')].find((x) => fs.existsSync(x)) || null;
  function writeMcpConfig(name, script, env = {}) {
    const server = path.join(__dirname, 'mcp', script).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const file = path.join(app.getPath('userData'), `mcp-${name}.json`);
    const command = NODE_BIN || process.execPath;
    const config = { mcpServers: { [name]: { type: 'stdio', command, args: [server], env: NODE_BIN ? env : { ELECTRON_RUN_AS_NODE: '1', ...env } } } };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return file;
    } catch {
      return null;
    }
  }

  function writeMacConfig() {
    macConfigFile = writeMcpConfig('mac', 'mac-server.js');
    // Der n8n-Server bekommt nur den Weg zur Vermittlung in der Zentrale – keinen Schlüssel.
    n8nConfigFile = writeMcpConfig('n8n', 'n8n-server.js', { ZENTRALE_N8N_SOCKET: n8nSocketPath(app.getPath('userData')) });
    browserConfigFile = writeMcpConfig('web', 'browser-server.js', { ZENTRALE_BROWSER_SOCKET: n8nSocketPath(app.getPath('userData'), 'browser') });
    kommentareConfigFile = writeMcpConfig('kommentare', 'kommentare-server.js', { ZENTRALE_KOMMENTARE_FILE: kommentareFile() });
  }

  // ---------- n8n: Adresse und verschlüsselter Schlüssel (macOS-Schlüsselbund) ----------

  function n8nFile() { return path.join(app.getPath('userData'), 'n8n.json'); }

  function loadN8n() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(n8nFile(), 'utf8')); } catch {}
    let key = null;
    if (raw.key && safeStorage.isEncryptionAvailable()) {
      try { key = safeStorage.decryptString(Buffer.from(raw.key, 'base64')); } catch { key = null; }
    }
    n8nConfig = { url: normalizeBase(raw.url) || N8N_DEFAULT_URL, key, off: raw.off === true };
  }

  function saveN8n(next) {
    if (next.key && !safeStorage.isEncryptionAvailable()) return false;
    const data = { url: next.url, key: next.key ? safeStorage.encryptString(next.key).toString('base64') : null, off: next.off === true };
    try {
      fs.mkdirSync(path.dirname(n8nFile()), { recursive: true });
      fs.writeFileSync(`${n8nFile()}.tmp`, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(`${n8nFile()}.tmp`, n8nFile());
    } catch { return false; }
    n8nConfig = next;
    // Claude startet vor der nächsten Nachricht neu und kennt dann die n8n-Werkzeuge.
    if (chat) chat.needsRestart = true;
    return true;
  }

  const n8nClient = () => new N8n({ baseUrl: n8nConfig.url, apiKey: n8nConfig.key });

  // Rollen der Agenten (z. B. „Marketing“, „Recherche“) – nur für die Ordnung in der Zentrale.
  const roles = {
    file: () => path.join(app.getPath('userData'), 'agent-roles.json'),
    get() { try { const r = JSON.parse(fs.readFileSync(this.file(), 'utf8')); return r && typeof r === 'object' ? r : {}; } catch { return {}; } },
    write(map) { try { fs.writeFileSync(this.file(), JSON.stringify(map, null, 2)); return true; } catch { return false; } },
    set(id, role) {
      if (typeof id !== 'string' || !/^[\w.-]+\.md$/.test(id)) return false;
      const r = String(role || '').trim().slice(0, 40);
      const { [id]: _old, ...rest } = this.get();
      return this.write(r ? { ...rest, [id]: r } : rest);
    },
    remove(id) { const { [id]: _old, ...rest } = this.get(); this.write(rest); },
  };

  function findSession(id) {
    for (const p of projectsCache) {
      const s = p.sessions.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  }

  function isDir(p) {
    try { return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; }
  }

  async function openChat({ cwd, sessionId = null, title = null }) {
    if (!claude.bin) return null;
    const old = chat;
    chatGen += 1;
    const gen = chatGen;
    // In Website-Ordnern arbeitet Claude als Webdesigner (Agent aus ~/.claude/agents).
    const agent = studio().isSite(cwd) && fs.existsSync(path.join(os.homedir(), '.claude', 'agents', `${WEB_AGENT}.md`)) ? WEB_AGENT : null;
    const args = agent ? () => [...extraArgs(), '--agent', agent] : extraArgs;
    const c = new ClaudeChat({ bin: claude.bin, env: claude.env, cwd, resume: sessionId, title, extraArgs: args, approvalInfo, allowAll });
    chat = c;
    c.on('event', (ev) => {
      send('chat-event', { ...ev, gen });
      // Abgemeldet? (Fehler mit Login/OAuth) – fällt im Kontrollraum als blinder Fleck auf.
      if (ev.kind === 'error' && /log ?in|oauth|authent|401|anmeld/i.test(`${ev.text || ''} ${ev.details || ''}`)) claudeAuthProblemAt = Date.now();
      else if (ev.kind === 'text' || ev.kind === 'result') claudeAuthProblemAt = 0;
    });
    c.on('status', () => pushState());
    c.on('approvals', onApprovalsChanged);
    // Den alten Claude im Hintergrund beenden – nicht darauf warten, sonst dauert jeder Wechsel ~1 s.
    // Ausnahme: dasselbe Gespräch – dann erst fertig beenden, sonst schreiben zwei Prozesse in dieselbe Datei.
    if (old && old.sessionId === sessionId) await old.dispose().catch(() => {});
    else if (old) old.dispose().catch(() => {});
    if (gen !== chatGen || chat !== c) return chatInfo();
    c.start();
    pushState();
    return chatInfo();
  }

  // Löst den offenen Chat (z. B. weil sein Gespräch gelöscht wird) und beendet ihn.
  async function detachChat() {
    const c = chat;
    if (!c) return;
    chat = null;
    chatGen += 1;
    pushState();
    await c.dispose();
  }

  function defaultCwd() {
    const recent = projectsCache.find((p) => isDir(p.path));
    return recent ? recent.path : os.homedir();
  }

  // Seite ins Fenster laden – mit Wächter: kommt sie nicht an (z. B. weil macOS beim Start am Schlüsselbund-Dialog
  // festhing), stürzt sie ab oder hängt sie, lädt die Zentrale sie neu. Sonst bliebe das Fenster grau.
  const PAGE_TIMEOUT_MS = 15000;
  const PAGE_RETRIES = 20; // 20 × 15 s – übersteht auch einen langen Schlüsselbund-Dialog
  let pageTimer = null;
  let pageTries = 0;
  const pageFile = () => path.join(__dirname, 'renderer', appLocked ? 'lock.html' : 'index.html');
  function loadPage(retry = false) {
    if (!win || win.isDestroyed()) return;
    pageTries = retry ? pageTries + 1 : 0;
    if (pageTries > PAGE_RETRIES) return;
    clearTimeout(pageTimer);
    pageTimer = setTimeout(() => loadPage(true), PAGE_TIMEOUT_MS);
    win.loadFile(pageFile()).catch(() => {}); // Fehler meldet did-fail-load
  }
  function watchPage(w) {
    const again = () => { clearTimeout(pageTimer); pageTimer = setTimeout(() => loadPage(true), 1000); };
    w.webContents.on('did-finish-load', () => { clearTimeout(pageTimer); pageTries = 0; });
    w.webContents.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => { if (isMainFrame && code !== -3) again(); }); // -3 = abgebrochen durch neues Laden
    w.webContents.on('render-process-gone', again);
    let hangTimer = null;
    w.on('unresponsive', () => { clearTimeout(hangTimer); hangTimer = setTimeout(() => { if (!w.isDestroyed()) { w.webContents.forcefullyCrashRenderer(); again(); } }, 10000); });
    w.on('responsive', () => clearTimeout(hangTimer));
  }

  function createWindow() {
    const isMac = process.platform === 'darwin';
    win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1040,
      minHeight: 660,
      title: 'Zentrale',
      titleBarStyle: isMac ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 20, y: 20 },
      vibrancy: isMac ? 'under-window' : undefined,
      visualEffectState: 'active',
      backgroundColor: isMac ? '#00000000' : '#f7f8fb',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged, // in der installierten App keine Entwicklerwerkzeuge (dort wären offene Finanzdaten lesbar)
      },
    });
    watchPage(win);
    loadPage();
    if (webTabs) webTabs.attach(win);
    win.once('ready-to-show', () => win.show());

    // Links öffnen im Browser, nie im App-Fenster.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // Auf dem Mac schließt das rote X nur das Fenster; Claude arbeitet weiter.
    win.on('close', (e) => {
      if (isMac && !quitting) { e.preventDefault(); win.hide(); }
    });
    win.on('closed', () => { win = null; finLock(); });
    // Fenster weg oder minimiert: privater Bereich sofort zu.
    win.on('hide', () => finLock());
    win.on('blur', () => { clearTimeout(finBlurTimer); if (finUntil) finBlurTimer = setTimeout(finLock, FIN_BLUR_MS); });
    win.on('focus', () => clearTimeout(finBlurTimer));
    win.on('minimize', () => finLock());
  }

  ipcMain.handle('get-state', () => { sentProjectsRev = projectsRev; return snapshot(); });

  ipcMain.handle('open-session', async (_e, args) => {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null;
    const session = sessionId && findSession(sessionId);
    if (!session) return { error: 'Dieses Gespräch wurde nicht gefunden.' };
    await claudeReady;
    if (!claude.bin) return { error: 'Claude Code wurde nicht gefunden.' };
    // Fortsetzen geht nur im Ordner, in dem das Gespräch entstanden ist.
    if (!isDir(session.cwd)) return { error: 'Der Projektordner dieses Gesprächs existiert nicht mehr.' };
    let history = [];
    try { history = readMessages(session.file, 400, { tools: true }); } catch {}
    if (chat && chat.sessionId === sessionId) return { chat: chatInfo(), history };
    const info = await openChat({ cwd: session.cwd, sessionId, title: session.title });
    return { chat: info, history };
  });

  ipcMain.handle('new-session', async (_e, args) => {
    // Ohne Ordner: im Benutzerordner (Claude fragt dort vor jeder Änderung).
    const cwd = args && args.cwd ? args.cwd : os.homedir();
    if (!isDir(cwd)) return { error: 'Dieser Ordner existiert nicht.' };
    await claudeReady;
    if (!claude.bin) return { error: 'Claude Code wurde nicht gefunden.' };
    return { chat: await openChat({ cwd }), history: [] };
  });

  ipcMain.handle('send-message', async (_e, text) => {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return { ok: false };
    await claudeReady;
    if (!claude.bin) return { ok: false, error: 'Claude Code wurde nicht gefunden.' };
    if (!chat) await openChat({ cwd: defaultCwd() });
    const c = chat;
    const gen = chatGen;
    if (!c) return { ok: false, error: 'Der Chat wurde geschlossen, bevor die Nachricht ankam. Bitte noch einmal senden.' };
    if (!c.title) { c.title = shortTitle(t); pushState(); }
    const ok = await c.send(t);
    if (c !== chat) return { ok: false, error: 'Der Chat wurde gewechselt, bevor die Nachricht ankam. Bitte noch einmal senden.' };
    return ok ? { ok: true, gen } : { ok: false, error: 'Claude konnte nicht gestartet werden.' };
  });

  ipcMain.handle('stop-chat', async () => {
    if (chat) await chat.stop({ interrupt: true });
    pushState();
  });

  ipcMain.handle('approval-respond', (_e, args) => {
    const id = args && typeof args.id === 'string' ? args.id : null;
    const decision = args && ['allow', 'always', 'deny'].includes(args.decision) ? args.decision : null;
    if (!id || !decision) return false;
    for (const c of [chat, ...taskChats.keys()]) if (c && c.respond(id, decision)) return true;
    return false;
  });

  ipcMain.handle('pick-folder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Projektordner wählen' });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('tasks-save', (_e, task) => {
    if (!task || typeof task !== 'object') return;
    scheduler.upsert({ ...task, cwd: isDir(task.cwd) ? task.cwd : null });
  });
  ipcMain.handle('tasks-toggle', (_e, id) => { if (typeof id === 'string') scheduler.toggle(id); });
  ipcMain.handle('tasks-remove', (_e, id) => { if (typeof id === 'string') scheduler.remove(id); });
  ipcMain.handle('tasks-run', (_e, id) => { if (typeof id === 'string') scheduler.run(id); });

  // Einstellungen ändern. Ausgeschaltete Verbindungen gelten sofort (Claude wird dafür neu gestartet,
  // auch wenn er gerade arbeitet); neu eingeschaltete gelten sofort, wenn Claude nicht arbeitet.
  ipcMain.handle('settings-update', async (_e, patch) => {
    const before = settings.get().connections;
    if (patch && typeof patch === 'object' && patch.backup && typeof patch.backup === 'object') patch = { ...patch, backup: { auto: patch.backup.auto } };
    const next = settings.update(patch);
    nativeTheme.themeSource = next.theme;
    // Rückfragen gerade ausgeschaltet: was noch auf eine Freigabe wartet, läuft sofort weiter.
    if (!next.askFirst) for (const c of [chat, ...taskChats.keys()]) if (c) c.allowPending();
    let applied = true;
    const changed = Object.keys(next.connections).some((k) => next.connections[k] !== before[k]);
    const turnedOff = Object.keys(next.connections).some((k) => before[k] && !next.connections[k]);
    if (changed && chat) {
      // Arbeitet Claude, startet der Chat vor der nächsten Nachricht neu und liest dann die neuen Verbindungen.
      if (chat.status === 'busy' && !turnedOff) { applied = false; chat.needsRestart = true; }
      else { const c = chat; await c.stop(); if (c === chat) c.start(); }
    }
    pushState();
    return { settings: next, applied, interrupted: turnedOff && applied };
  });

  ipcMain.handle('connections-list', async () => {
    await claudeReady;
    if (!claude.bin) return null;
    return listMcpServers({ bin: claude.bin, env: claude.env, cwd: os.homedir() });
  });

  // launch: true nur, wenn du selbst aktualisierst – sonst öffnen sich keine Apps ungefragt.
  ipcMain.handle('mac-today', async (_e, args) => {
    if (process.platform !== 'darwin' || !settings.get().connections.mac) return null;
    const part = args && typeof args.part === 'string' ? args.part : null;
    const launch = !!(args && args.launch === true);
    return part ? mac.todayPart(part, { launch }) : mac.today({ launch });
  });

  // Fragt die Mac-Rechte für Kalender und Erinnerungen einmal gezielt ab und schickt eine Probe-Mitteilung.
  ipcMain.handle('mac-test', async () => {
    if (process.platform !== 'darwin') return { error: 'Das geht nur auf dem Mac.' };
    // Erst den vollen Kalenderzugriff anfragen (schneller Weg), dann alles einmal ausprobieren.
    const access = await mac.requestCalendarAccess();
    const [calendar, reminders] = await Promise.all([mac.calendarEvents(1), mac.reminders()]);
    let notify = { ok: false, error: 'Mitteilungen sind ausgeschaltet. Erlaube sie unter Systemeinstellungen → Mitteilungen → Zentrale.' };
    if (Notification.isSupported()) {
      new Notification({ title: 'Zentrale', body: 'Die Verbindung zum Mac funktioniert.' }).show();
      notify = { ok: true };
    }
    return { calendar, reminders, notify, access };
  });

  // ---------- Themen und Löschen ----------

  ipcMain.handle('session-topic', (_e, args) => {
    const ids = Array.isArray(args && args.ids) ? args.ids.filter((x) => typeof x === 'string') : [];
    const topic = args && typeof args.topic === 'string' ? args.topic : null;
    if (!ids.length) return false;
    topicStore.set(ids, topic);
    refreshProjects();
    pushState();
    return true;
  });

  // Gespräche wandern in den Papierkorb (wiederherstellbar), samt Ordner für Unteragenten und Anhänge.
  ipcMain.handle('sessions-trash', async (_e, args) => {
    const ids = Array.isArray(args && args.ids) ? args.ids.filter((x) => typeof x === 'string') : [];
    const result = { trashed: 0, skipped: [] };
    const gone = [];
    for (const id of ids) {
      const s = findSession(id);
      if (!s) continue;
      const ours = !!chat && chat.sessionId === id;
      if (ours && chat.status === 'busy') { result.skipped.push({ title: s.title, reason: 'Claude arbeitet gerade daran.' }); continue; }
      if (!ours && Date.now() - s.updatedAt < IN_USE_MS) {
        result.skipped.push({ title: s.title, reason: 'Wird gerade in einem anderen Claude-Fenster benutzt.' });
        continue;
      }
      if (ours) await detachChat();
      try {
        await shell.trashItem(s.file);
        const extra = s.file.replace(/\.jsonl$/, '');
        if (isDir(extra)) await shell.trashItem(extra);
        result.trashed += 1;
        gone.push(id);
      } catch (e) {
        result.skipped.push({ title: s.title, reason: e.message });
      }
    }
    if (gone.length) topicStore.forget(gone);
    refreshProjects();
    pushState();
    return result;
  });

  // Den Ordner eines Projekts in den Papierkorb – nur echte Projektordner, nie Benutzer- oder Systemordner.
  ipcMain.handle('project-folder-trash', async (_e, dir) => {
    if (!isDir(dir)) return { ok: false, error: 'Diesen Ordner gibt es nicht.' };
    const p = path.resolve(dir);
    const known = projectsCache.some((x) => x.path && files.canonical(x.path) === files.canonical(p));
    if (!known || files.isProtected(p) || permissionModeFor(fs.realpathSync.native(p)) !== 'acceptEdits') {
      return { ok: false, error: 'Dieser Ordner ist geschützt und kann über die Zentrale nicht gelöscht werden.' };
    }
    if (chat && (chat.cwd === p || chat.cwd.startsWith(p + path.sep))) {
      if (chat.status === 'busy') return { ok: false, error: 'Claude arbeitet gerade in diesem Ordner.' };
      await detachChat();
    }
    try { await shell.trashItem(p); } catch (e) { return { ok: false, error: e.message }; }
    pushState();
    return { ok: true };
  });

  // ---------- Bibliothek: Skills, Befehle, Plugins, Agenten ----------

  // Skills, Agenten, Plugins: einmal lesen, 30 s halten; nach Änderungen mit force neu.
  const librarySource = dataLayer.source('bibliothek', () => library.library(), { ttl: 30000 });
  ipcMain.handle('library', (_e, force) => librarySource(force === true));

  ipcMain.handle('agent-toggle', (_e, args) => library.setAgentActive(args && args.id, !!(args && args.active)));

  // Agenten und Skills selbst anlegen, ändern, löschen (Löschen = Papierkorb).
  const safely = (fn) => { try { return fn(); } catch (e) { return { ok: false, error: e.message }; } };
  ipcMain.handle('agent-read', (_e, id) => safely(() => library.readAgent(id)));
  ipcMain.handle('agent-save', (_e, input) => safely(() => library.saveAgent(input)));
  ipcMain.handle('agent-trash', async (_e, id) => {
    const found = safely(() => library.readAgent(id));
    if (!found.ok) return found;
    try { await shell.trashItem(library.agentFile(id, found.data.active)); } catch (e) { return { ok: false, error: e.message }; }
    roles.remove(id);
    return { ok: true };
  });
  ipcMain.handle('agent-roles', () => roles.get());
  ipcMain.handle('agent-role-set', (_e, args) => roles.set(args && args.id, args && args.role));
  ipcMain.handle('skill-read', (_e, file) => safely(() => library.readSkill(file)));
  ipcMain.handle('skill-save', (_e, input) => safely(() => library.saveSkill(input)));
  ipcMain.handle('skill-trash', async (_e, file) => {
    const dir = library.ownSkillDir(file);
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Nur eigene Skills lassen sich hier löschen.' };
    try { await shell.trashItem(dir); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('marketplace', () => safely(() => library.listMarketplace()));

  const runningSource = dataLayer.source('laufende-arbeit', () => library.runningWork((id) => { const s = findSession(id); return s ? s.title : null; }), { ttl: 4000 });
  ipcMain.handle('running-work', async () => {
    const work = await runningSource();
    const ownId = chat && chat.sessionId;
    return { ...work, sessions: work.sessions.filter((x) => x.id !== ownId) };
  });

  // ---------- Mein Mac: Apps und Ordner ----------

  // Für Apps liefert nur die Vorschau-Funktion von macOS das echte Symbol; getFileIcon gibt dort ein Platzhalter-Bild.
  async function iconFor(p) {
    if (iconCache.has(p)) return iconCache.get(p);
    let url = null;
    if (process.platform === 'darwin') {
      try { url = (await nativeImage.createThumbnailFromPath(p, { width: 96, height: 96 })).toDataURL(); } catch {}
    }
    if (!url) try { url = (await app.getFileIcon(p, { size: 'normal' })).toDataURL(); } catch {}
    iconCache.set(p, url);
    return url;
  }

  // Ohne Symbole, damit die Liste sofort da ist; die holt die Oberfläche einzeln über fs-icon.
  ipcMain.handle('mac-apps', () => files.listApps().map((a) => (iconCache.has(a.path) ? { ...a, icon: iconCache.get(a.path) } : a)));

  ipcMain.handle('fs-favorites', () => {
    const temp = /^\/(private\/)?(tmp|var\/folders)\//;
    const projects = projectsCache.filter((p) => isDir(p.path) && p.path !== os.homedir() && !temp.test(`${p.path}/`)).slice(0, 8)
      .map((p) => ({ name: p.name, path: p.path }));
    return { places: files.favorites(), projects };
  });

  ipcMain.handle('fs-list', (_e, args) => files.listDir(args && args.path, { hidden: !!(args && args.hidden) }));

  ipcMain.handle('fs-icon', (_e, p) => (files.validPath(p) ? iconFor(p) : null));

  ipcMain.handle('fs-open', async (_e, p) => {
    if (!files.validPath(p) || !fs.existsSync(p)) return { ok: false, error: 'Nicht gefunden.' };
    // Skripte und fremde Programme starten etwas – erst fragen.
    if (files.needsRunConfirm(p)) {
      const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Abbrechen', 'Starten'], defaultId: 0, cancelId: 0,
        message: `„${path.basename(p)}“ starten?`, detail: 'Das ist ein Programm oder Skript – es läuft mit deinen Rechten. Starte es nur, wenn du weißt, woher es kommt.' });
      if (response !== 1) return { ok: false, cancelled: true };
    }
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('fs-reveal', (_e, p) => { if (files.validPath(p)) shell.showItemInFolder(p); });

  ipcMain.handle('fs-trash', async (_e, p) => {
    if (!files.validPath(p) || !fs.existsSync(p)) return { ok: false, error: 'Nicht gefunden.' };
    if (files.isProtected(p)) return { ok: false, error: 'Dieser Ordner ist geschützt.' };
    try { await shell.trashItem(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('fs-search', (_e, q) => (typeof q === 'string' ? mac.spotlight(q, 60) : { ok: false, error: 'Suchbegriff fehlt.' }));

  // ---------- Mac-Gesundheit und Kurzbefehle ----------

  ipcMain.handle('mac-health', () => health.snapshot());
  let bigFoldersCache = null;
  let bigFoldersRun = null; // läuft schon eine Messung, warten alle auf dieselbe
  ipcMain.handle('mac-big-folders', async (_e, refresh) => {
    if (bigFoldersCache && refresh !== true) return bigFoldersCache;
    if (!bigFoldersRun) bigFoldersRun = health.bigFolders().then((data) => { bigFoldersCache = { at: Date.now(), data }; return bigFoldersCache; }).finally(() => { bigFoldersRun = null; });
    return bigFoldersRun;
  });
  // Papierkorb leeren macht der Nutzer selbst per Klick (mit Rückfrage) – endgültig, darum mit eigenem Dialog.
  ipcMain.handle('mac-empty-trash', async () => {
    const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Abbrechen', 'Papierkorb leeren'], defaultId: 0, cancelId: 0,
      message: 'Papierkorb endgültig leeren?', detail: 'Alles im Papierkorb wird gelöscht und lässt sich danach nicht mehr zurückholen.' });
    if (response !== 1) return { ok: false, cancelled: true };
    const res = await mac.runScript('tell application "Finder" to empty trash', [], { language: 'AppleScript', app: 'Finder', timeout: 300000 });
    bigFoldersCache = null;
    return res.ok ? { ok: true } : res;
  });
  // Fehler-Meldungen: wichtige Server und fehlgeschlagene n8n-Workflows (jede Minute).
  let alerts = null;
  ipcMain.handle('alerts-recent', () => (alerts ? alerts.get() : []));
  const startAlerts = () => {
    alerts = new AlertWatch({
      listServers: () => currentServers(false),
      listExecutions: () => (n8nConfig.key ? n8nClient().listExecutions(30) : null),
      listWorkflows: () => n8nClient().listWorkflows(),
      notify: (title, body, view) => { notify(title, body, view); send('alerts', alerts.get()); },
    });
    alerts.start(60000);
  };

  // Bildschirm-Helfer: du wählst einen Bereich oder ein Fenster (Leertaste), Esc bricht ab.
  // Das Bild bleibt auf dem Mac, bis du es im Chat abschickst; alte Bilder werden nach einem Tag gelöscht.
  const SCREEN_SHORTCUT = 'CommandOrControl+Shift+Space';
  const SHOT_MAX_AGE_MS = 24 * 3600 * 1000;
  let capturing = false;
  function cleanScreenshots() {
    const dir = path.join(app.getPath('userData'), 'bildschirm');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > SHOT_MAX_AGE_MS) fs.unlinkSync(p); } catch {}
    }
    return dir;
  }
  async function captureScreen() {
    if (process.platform !== 'darwin') return { ok: false, error: 'Das geht nur auf dem Mac.' };
    if (capturing || appLocked) return { ok: false, cancelled: true };
    capturing = true;
    finLock(); // der private Bereich kommt nie aufs Bildschirmfoto
    try {
      const dir = cleanScreenshots();
      const file = path.join(dir, `bildschirm-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      // Die Zentrale selbst soll nicht im Bild sein.
      if (win && win.isVisible() && win.isFocused()) { win.hide(); await new Promise((r) => setTimeout(r, 250)); }
      await new Promise((resolve) => execFile('/usr/sbin/screencapture', ['-i', '-x', file], { timeout: 180000 }, () => resolve()));
      if (!win) createWindow();
      win.show();
      win.focus();
      if (!fs.existsSync(file)) return { ok: false, cancelled: true };
      return { ok: true, path: file };
    } finally { capturing = false; }
  }
  ipcMain.handle('screen-capture', () => captureScreen());
  ipcMain.handle('screen-shortcut', () => ({ shortcut: 'Cmd+Shift+Leertaste', registered: globalShortcut.isRegistered(SCREEN_SHORTCUT) }));
  const registerScreenShortcut = () => {
    try {
      globalShortcut.register(SCREEN_SHORTCUT, async () => { const r = await captureScreen(); if (r.ok) send('screen-shot', r.path); });
    } catch {}
  };

  // ---------- Privat: Finanzen ----------
  // Nur dieses Fenster darf fragen, nur nach Touch ID, nach 5 Minuten ohne Nutzung wieder zu.
  // Keine Verbindung zu Claude, seinen Werkzeugen oder dem Netz; Bildschirmfotos sind gesperrt, solange offen.
  const FIN_IDLE_MS = 5 * 60000;
  let finUntil = 0;
  const finStore = () => new FinanceStore(path.join(app.getPath('userData'), 'privat', 'finanzen.bin'), {
    encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) });
  const fromWindow = (e) => !!win && e.sender === win.webContents;
  // Höchstens 30 Minuten am Stück offen, auch wenn ständig etwas getan wird.
  const FIN_MAX_MS = 30 * 60000;
  const FIN_BLUR_MS = 60000;
  let finOpenedAt = 0;
  let finBlurTimer = null;
  const finIsOpen = () => Date.now() < finUntil && Date.now() - finOpenedAt < FIN_MAX_MS;
  function finLock() {
    const was = finUntil > 0;
    finUntil = 0;
    clearTimeout(finBlurTimer);
    if (win && !win.isDestroyed()) win.setContentProtection(false);
    if (was) send('fin-locked');
  }
  const finGuard = (e) => {
    if (!fromWindow(e)) return { ok: false, error: 'Nicht erlaubt.' };
    if (!finIsOpen()) { finLock(); return { ok: false, locked: true, error: 'Der private Bereich ist gesperrt.' }; }
    finUntil = Date.now() + FIN_IDLE_MS;
    return null;
  };
  const finData = () => { const d = finStore().load(); return { ok: true, data: d, summary: financeSummary(d) }; };
  // Entschlüsseln kann scheitern (z. B. Schlüsselbund geändert) – dann eine klare Meldung statt eines stillen Fehlers.
  const finSafe = (fn) => { try { return fn(); } catch { return { ok: false, error: 'Die Finanzdaten ließen sich nicht lesen oder speichern (Schlüsselbund?).' }; } };
  ipcMain.handle('fin-unlock', async (e) => {
    if (!fromWindow(e)) return { ok: false, error: 'Nicht erlaubt.' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Der Schlüsselbund ist nicht verfügbar – ohne ihn speichert die Zentrale keine Finanzdaten.' };
    // Ohne Touch ID kein Zugang – ein bloßer Bestätigungs-Klick wäre keine Sperre.
    if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) {
      return { ok: false, error: 'Touch ID ist gerade nicht verfügbar (z. B. bei zugeklapptem Mac). Klapp den Mac auf oder richte Touch ID ein – ohne Fingerabdruck öffnet sich der Bereich nicht.' };
    }
    try { await systemPreferences.promptTouchID('deinen privaten Finanzbereich zu öffnen'); } catch { return { ok: false, cancelled: true }; }
    // Inzwischen weggeklickt oder versteckt: nicht öffnen.
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return { ok: false, cancelled: true };
    win.setContentProtection(true);
    finUntil = Date.now() + FIN_IDLE_MS;
    finOpenedAt = Date.now();
    try { return finData(); } catch { finLock(); return { ok: false, error: 'Die Finanzdaten ließen sich nicht entschlüsseln.' }; }
  });
  ipcMain.handle('fin-lock', (e) => { if (fromWindow(e)) finLock(); });
  ipcMain.handle('fin-get', (e) => finGuard(e) || finSafe(finData));
  ipcMain.handle('fin-save', (e, a) => finGuard(e) || finSafe(() => { const r = finStore().upsert(a && a.kind, a && a.item); return r.ok ? finData() : r; }));
  ipcMain.handle('fin-remove', (e, a) => finGuard(e) || finSafe(() => { finStore().remove(a && a.kind, a && a.id); return finData(); }));
  // Was wäre wenn: nur rechnen, nichts speichern.
  ipcMain.handle('fin-simulate', (e, scenario) => finGuard(e) || finSafe(() => ({ ok: true, data: financeSimulate(finStore().load(), scenario && typeof scenario === 'object' ? scenario : {}) })));
  ipcMain.handle('fin-clear-moves', (e) => finGuard(e) || finSafe(() => { finStore().clearMoves(); return finData(); }));
  ipcMain.handle('fin-import', async (e, accountId) => {
    const g = finGuard(e);
    if (g) return g;
    const res = await dialog.showOpenDialog(win, { title: 'Kontoauszug (CSV) wählen', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }] });
    if (res.canceled) return { ok: false, cancelled: true };
    let buf;
    try { buf = fs.readFileSync(res.filePaths[0]); } catch (err) { return { ok: false, error: err.message }; }
    // Viele Banken exportieren noch in Windows-1252 statt UTF-8.
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(buf);
    const parsed = importCsv(text, typeof accountId === 'string' ? accountId.slice(0, 64) : '');
    if (!parsed.ok) return parsed;
    const r = finSafe(() => finStore().addMoves(parsed.moves));
    if (!r.ok) return r;
    // Die CSV liegt sonst unverschlüsselt im Download-Ordner.
    let trashed = false;
    const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Behalten', 'In den Papierkorb'], defaultId: 1, cancelId: 0,
      message: `${r.added} Buchungen übernommen.`, detail: 'Die CSV-Datei liegt noch unverschlüsselt auf dem Mac. In den Papierkorb legen?' });
    if (response === 1) { try { await shell.trashItem(res.filePaths[0]); trashed = true; } catch {} }
    return { ...finSafe(finData), imported: r.added, duplicates: r.skipped, unreadable: parsed.skipped, trashed };
  });
  const finTimer = setInterval(() => { if (finUntil && !finIsOpen()) finLock(); }, 15000);
  powerMonitor.on('lock-screen', finLock);
  powerMonitor.on('suspend', finLock);
  powerMonitor.on('resume', () => { if (scheduler) scheduler.pause(60000); });

  // Website-Werkstatt
  let studioObj = null;
  function studio() { return studioObj || (studioObj = new WebsiteStudio(path.join(app.getPath('userData'), 'websites.json'))); }
  ipcMain.handle('studio-list', () => studio().list());
  ipcMain.handle('studio-suggest', (_e, avoid) => studio().suggest(typeof avoid === 'string' ? avoid : null));
  ipcMain.handle('studio-forget', (_e, id) => { if (typeof id === 'string') studio().forget(id); return studio().list(); });
  ipcMain.handle('studio-create', async (_e, brief) => {
    // Erst prüfen, ob Claude da ist – sonst bliebe ein halb angelegter Ordner zurück.
    await claudeReady;
    if (!claude.bin) return { ok: false, error: 'Claude Code wurde nicht gefunden.' };
    const res = studio().create(brief);
    if (!res.ok) return res;
    const info = await openChat({ cwd: res.dir });
    return { ok: true, chat: info, prompt: res.prompt, dir: res.dir };
  });

  // Social-Media-Planer
  let planner = null;
  const plannerStore = () => planner || (planner = new PlanStore(path.join(app.getPath('userData'), 'planer.json')));
  const plannerTabs = () => (webTabs ? webTabs.info().portals.map((p) => ({ id: p.id, name: p.name, url: p.url, title: p.title })) : []);
  ipcMain.handle('planner-list', () => ({ posts: plannerStore().list(), tabs: plannerTabs() }));
  ipcMain.handle('planner-save', (_e, post) => plannerStore().upsert(post));
  ipcMain.handle('planner-remove', (_e, id) => { if (typeof id === 'string') plannerStore().remove(id); return { ok: true }; });
  ipcMain.handle('planner-status', (_e, a) => plannerStore().setStatus(a && a.id, a && a.status));
  // YouTube über die offizielle Schnittstelle (Verbindungen → YouTube). Der Zugang liegt verschlüsselt im Schlüsselbund.
  let youtube = null;
  const yt = () => youtube || (youtube = new YouTube({ file: path.join(app.getPath('userData'), 'youtube.json'),
    encrypt: (t) => safeStorage.encryptString(t).toString('base64'), decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
    openExternal: (url) => shell.openExternal(url) }));
  let lastClientFile = null; // nur diese Datei darf „In den Papierkorb“ (sie enthält das Client-Geheimnis)
  ipcMain.handle('yt-status', () => yt().status());
  ipcMain.handle('yt-client-file', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Google-Anmeldedaten wählen (client_secret_….json)',
      defaultPath: path.join(os.homedir(), 'Downloads'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, cancelled: true };
    let text;
    try { if (fs.statSync(res.filePaths[0]).size > 64 * 1024) return { ok: false, error: 'Die Datei ist zu groß für Google-Anmeldedaten.' }; text = fs.readFileSync(res.filePaths[0], 'utf8'); }
    catch (e) { return { ok: false, error: e.message }; }
    const r = yt().setClient(text);
    if (r.ok) lastClientFile = res.filePaths[0];
    return r.ok ? { ok: true, file: res.filePaths[0] } : r;
  });
  ipcMain.handle('yt-trash-file', async (_e, file) => {
    // Nur die eben gewählte Google-Datei – sonst nichts.
    if (typeof file !== 'string' || file !== lastClientFile) return { ok: false };
    lastClientFile = null;
    try { await shell.trashItem(file); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('yt-connect', () => yt().connect());
  ipcMain.handle('yt-disconnect', () => yt().disconnect());
  ipcMain.handle('yt-upload', async (_e, a) => {
    const post = plannerStore().list().find((p) => p.id === (a && a.id));
    if (!post || !post.targets.some((t) => t.tabId === YT_API_TARGET)) return { ok: false, error: 'Beitrag nicht gefunden.' };
    const r = await yt().upload(post, { onProgress: (progress) => send('yt-progress', { id: post.id, progress }) });
    if (r.ok) {
      const others = post.targets.filter((t) => t.tabId !== YT_API_TARGET);
      if (!others.length) plannerStore().setStatus(post.id, 'hochgeladen');
      send('planner-changed');
    }
    return r;
  });
  ipcMain.handle('planner-upload', (_e, a) => {
    const post = plannerStore().list().find((p) => p.id === (a && a.id));
    const target = post && post.targets.find((t) => t.tabId === (a && a.tabId));
    if (!target) return { ok: false, error: 'Beitrag oder Tab nicht gefunden.' };
    if (!fs.existsSync(post.video)) return { ok: false, error: `Das Video liegt nicht mehr hier: ${post.video}` };
    return uploadPrompt(post, target, plannerTabs());
  });
  // Dateien für den Chat wählen (nur der Pfad geht ins Eingabefeld, die Datei bleibt, wo sie ist).
  ipcMain.handle('pick-files', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Dateien für Claude wählen' });
    return res.canceled ? [] : res.filePaths.slice(0, 10);
  });
  ipcMain.handle('pick-video', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Video wählen', defaultPath: path.join(os.homedir(), 'Movies'),
      filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm'] }] });
    return res.canceled ? null : res.filePaths[0];
  });
  const checkPlanner = () => {
    const due = plannerStore().takeDue();
    if (due.length) send('planner-changed');
    for (const p of due) {
      notify('Beitrag ist fällig', `„${p.title}“ für ${p.targets.map((t) => t.tabName).join(', ')} – in der Zentrale auf „Hochladen“ tippen.`, 'planner');
    }
  };

  // Morgen-Cockpit: Lage für „Heute“ und einmal täglich als Mitteilung.
  // Erst beim ersten Gebrauch anlegen – „store“ steht weiter unten.
  const morningStore = () => store('morning.json', { lastSent: null });
  async function cockpitNow() {
    const w = folderWatcher ? folderWatcher.get() : { log: [], unsorted: [] };
    return morning.cockpit({ portals: webTabs ? webTabs.info().portals : [], alerts: alerts ? alerts.get() : [],
      watcherLog: w.log, unsorted: w.unsorted, servers: await currentServers(false).catch(() => []) });
  }
  ipcMain.handle('cockpit', () => cockpitNow());
  let morningTimer = null;
  const startMorning = () => {
    let sending = false;
    morningTimer = setInterval(async () => {
      try { checkPlanner(); } catch {}
      dailyLearning().catch(() => {});
      if (!appLocked) dailyBackup().catch(() => {});
      const m = settings.get().morning;
      const now = new Date();
      if (sending || !m.enabled || !morning.isDue(now, m.time, morningStore().get().lastSent)) return;
      sending = true;
      try {
        let events = null;
        if (process.platform === 'darwin' && settings.get().connections.mac) {
          const r = await mac.todayPart('events', { launch: false }).catch(() => null);
          if (r && r.ok && Array.isArray(r.data)) events = r.data;
        }
        notify('Guten Morgen', morning.summaryText(await cockpitNow(), events), 'overview');
        morningStore().set({ lastSent: morning.dayKey(now) });
      } catch {} finally { sending = false; }
    }, 30000);
  };

  // Ordner-Wächter
  let folderWatcher = null;
  ipcMain.handle('watch-state', () => folderWatcher.get());
  ipcMain.handle('watch-save', (_e, rule) => folderWatcher.saveRule(rule));
  ipcMain.handle('watch-remove', (_e, id) => { if (typeof id === 'string') folderWatcher.removeRule(id); return folderWatcher.get(); });
  ipcMain.handle('watch-undo', (_e, id) => folderWatcher.undo(id));
  ipcMain.handle('watch-dismiss', (_e, file) => { folderWatcher.dismiss(file); return folderWatcher.get(); });
  const startFolderWatcher = () => {
    folderWatcher = new FolderWatcher(path.join(app.getPath('userData'), 'watcher.json'));
    folderWatcher.on('change', () => send('watch-state', folderWatcher.get()));
    folderWatcher.on('moved', (m) => notify('Einsortiert', `${path.basename(m.to)} → ${path.basename(path.dirname(m.to))}`));
    folderWatcher.on('failed', (f) => notify('Einsortieren ging nicht', `${path.basename(f.path)}: ${f.error}`));
    folderWatcher.start();
  };

  ipcMain.handle('shortcuts-list', () => (process.platform === 'darwin' ? mac.listShortcuts() : { ok: true, data: [] }));
  ipcMain.handle('shortcuts-run', (_e, name) => (typeof name === 'string' ? mac.runShortcut(name) : { ok: false, error: 'Name fehlt.' }));

  // ---------- Projekte & Server ----------

  // Kleine JSON-Speicher in userData (von der Zentrale gestartete Server, selbst hinzugefügte/ausgeblendete Projekte).
  const store = (name, fallback) => ({
    file: () => path.join(app.getPath('userData'), name),
    get() { try { const v = JSON.parse(fs.readFileSync(this.file(), 'utf8')); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; } },
    set(v) { try { fs.writeFileSync(`${this.file()}.tmp`, JSON.stringify(v, null, 2)); fs.renameSync(`${this.file()}.tmp`, this.file()); return true; } catch { return false; } },
  });
  const startedStore = store('servers.json', []);
  const projectStore = store('projects.json', { added: [], hidden: [] });
  const isTemp = (p) => /^\/(private\/)?(tmp|var\/folders)\//.test(`${p}/`);

  function scanServers(all) {
    // Nur noch laufende, von der Zentrale gestartete Server merken.
    const started = startedStore.get().filter((s) => { try { process.kill(s.pid, 0); return true; } catch { return false; } });
    startedStore.set(started);
    return servers.listServers({ all, selfPids: [process.pid], started });
  }
  // lsof/ps sind teuer: 3 s zwischenspeichern; mehrere Seiten gleichzeitig teilen sich einen Lauf.
  const serverSource = { false: dataLayer.source('server', () => scanServers(false), { ttl: 3000 }),
    true: dataLayer.source('server-alle', () => scanServers(true), { ttl: 3000 }) };
  const serversChanged = () => { serverSource.false.invalidate(); serverSource.true.invalidate(); };
  function currentServers(all = false) { return serverSource[!!all](); }

  ipcMain.handle('servers-list', async (_e, args) => {
    const list = await currentServers(!!(args && args.all));
    const started = new Map(startedStore.get().map((s) => [s.pid, s]));
    return list.map((s) => ({ ...s, started: started.get(s.pid) ? { id: started.get(s.pid).id, command: started.get(s.pid).command } : null }));
  });

  // Gestoppt wird nur, was gerade wirklich auf diesem Port mit dieser Prozess-ID lauscht.
  ipcMain.handle('servers-stop', async (_e, args) => {
    const pid = Number(args && args.pid);
    const port = Number(args && args.port);
    const match = (await currentServers(true)).find((s) => s.pid === pid && s.port === port);
    if (!match) return { ok: false, error: 'Dieser Server läuft nicht mehr.' };
    const res = await servers.stopServer(match, { force: !!(args && args.force), selfPids: [process.pid] });
    if (res.ok) { startedStore.set(startedStore.get().filter((s) => s.pid !== pid)); if (alerts) alerts.expectStop(port); serversChanged(); }
    return res;
  });

  ipcMain.handle('servers-suggest', (_e, dir) => (isDir(dir) ? servers.suggestCommands(dir) : []));

  ipcMain.handle('servers-start', (_e, args) => {
    const res = servers.startServer({ dir: args && args.dir, command: args && args.command, port: args && args.port,
      env: claude.env, logDir: path.join(app.getPath('userData'), 'server-logs') });
    if (res.ok) { startedStore.set([...startedStore.get(), res.data]); serversChanged(); }
    return res.ok ? { ok: true, data: { pid: res.data.pid, id: res.data.id } } : res;
  });

  ipcMain.handle('servers-log', (_e, id) => {
    const s = startedStore.get().find((x) => x.id === id);
    return s ? servers.readLog(s.log) : { ok: false, error: 'Für diesen Server gibt es kein Log (er wurde nicht von der Zentrale gestartet).' };
  });

  // Projekte = Ordner aus den Gesprächen + selbst hinzugefügte, ohne ausgeblendete; mit laufenden Servern.
  ipcMain.handle('projects-list', async () => {
    const { added, hidden } = projectStore.get();
    const byPath = new Map();
    for (const p of projectsCache) {
      if (!p.path || !isDir(p.path) || p.path === os.homedir() || isTemp(p.path)) continue;
      byPath.set(p.path, { path: p.path, name: p.name, sessions: p.sessions.length, added: false, updatedAt: p.updatedAt });
    }
    for (const dir of added) if (isDir(dir) && !byPath.has(dir)) byPath.set(dir, { path: dir, name: path.basename(dir), sessions: 0, added: true, updatedAt: 0 });
    for (const dir of added) if (byPath.has(dir)) byPath.get(dir).added = true;
    let running = [];
    try { running = await currentServers(false); } catch {}
    // Ordner mit laufendem Server sind auch Projekte, selbst wenn es dazu kein Gespräch gibt.
    for (const sv of running) {
      const dir = sv.projectDir;
      if (dir && isDir(dir) && dir !== os.homedir() && !isTemp(dir) && !byPath.has(dir)) {
        byPath.set(dir, { path: dir, name: path.basename(dir), sessions: 0, added: false, fromServer: true, updatedAt: 0 });
      }
    }
    return [...byPath.values()].filter((p) => !hidden.includes(p.path)).map((p) => ({
      ...p, servers: running.filter((s) => s.projectDir && (s.projectDir === p.path || s.projectDir.startsWith(p.path + path.sep)))
        .map((s) => ({ port: s.port, url: s.url, title: s.title })) }))
      .sort((a, b) => (b.servers.length - a.servers.length) || (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name, 'de'));
  });
  ipcMain.handle('projects-add', (_e, dir) => {
    if (!isDir(dir) || dir === os.homedir() || files.isProtected(dir)) return { ok: false, error: 'Diesen Ordner kann man nicht als Projekt hinzufügen.' };
    const { added, hidden } = projectStore.get();
    projectStore.set({ added: [...new Set([...added, dir])], hidden: hidden.filter((x) => x !== dir) });
    return { ok: true };
  });
  // Entfernt nur aus der Liste – der Ordner selbst bleibt unangetastet.
  ipcMain.handle('projects-remove', (_e, dir) => {
    if (typeof dir !== 'string') return { ok: false };
    const { added, hidden } = projectStore.get();
    projectStore.set({ added: added.filter((x) => x !== dir), hidden: [...new Set([...hidden, dir])] });
    return { ok: true };
  });
  ipcMain.handle('open-in-tab', (_e, url) => {
    let u;
    try { u = new URL(String(url)); } catch { return { ok: false, error: 'Ungültige Adresse.' }; }
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) return { ok: false, error: 'Nur lokale Adressen.' };
    let portal = webTabs.store.get().portals.find((p) => new URL(p.url).origin === u.origin);
    if (!portal) { const r = webTabs.store.add(`localhost:${u.port}`, u.origin); if (!r.ok) return r; portal = r.portal; }
    webTabs.show(portal.id);
    return { ok: true };
  });

  // ---------- Gehirn (Obsidian) ----------

  function currentVault() {
    try { return vault.findVaults()[0] || null; } catch { return null; }
  }
  const withVault = (fn) => {
    const v = currentVault();
    if (!v) return { ok: false, error: 'Kein Obsidian-Vault gefunden. Öffne Obsidian einmal mit deinem Vault.' };
    try { return fn(v.path); } catch (e) { return { ok: false, error: e.message }; }
  };
  // ---------- Kommentare unter Bits Videos (Stichwort + Antwort je Video aus bitvideos.aktionen) ----------
  ipcMain.handle('kommentare-get', () => {
    const d = kommentare.load(kommentareFile());
    const task = scheduler && scheduler.list().find((t) => t.name === KOMMENTARE_TASK);
    return { ok: true, data: { ...d, nochFrei: kommentare.nochFrei(d.eintraege), aktionen: bitvideos.aktionen(),
      automatik: task ? { an: !!task.enabled, zeit: task.time, laeuft: !!task.running, zuletzt: task.lastStatus || null } : null } };
  });
  ipcMain.handle('kommentare-status', (_e, a) => kommentare.status(kommentareFile(), a && a.id, a && a.status));
  ipcMain.handle('kommentare-remove', (_e, id) => kommentare.entfernen(kommentareFile(), id));
  ipcMain.handle('kommentare-auftrag', (_e, a) => {
    const d = kommentare.load(kommentareFile());
    return a && a.art === 'einsammeln' ? kommentare.auftragEinsammeln(d, bitvideos.aktionen())
      : kommentare.auftragVorbereiten(d, a && a.id, bitvideos.aktionen());
  });
  // Tägliches Einsammeln = eine normale Aufgabe (Seite „Aufgaben“), die sich ihren Auftrag selbst holt.
  ipcMain.handle('kommentare-automatik', (_e, an) => {
    const task = scheduler.list().find((t) => t.name === KOMMENTARE_TASK);
    if (an && !task) scheduler.upsert({ name: KOMMENTARE_TASK, time: KOMMENTARE_ZEIT, prompt: KOMMENTARE_PROMPT });
    else if (an && !task.enabled) scheduler.toggle(task.id);
    else if (!an && task) scheduler.remove(task.id);
    pushState();
    return { ok: true };
  });
  ipcMain.handle('kommentare-settings', (_e, patch) => kommentare.einstellen(kommentareFile(), patch || {}));

  // ---------- Bit-Videos (Video-Automatik im Studio-Ordner) ----------
  ipcMain.handle('bit-get', () => bitvideos.uebersicht());
  ipcMain.handle('bit-pause', (_e, bis) => bitvideos.pauseSetzen(bis));
  ipcMain.handle('bit-settings', (_e, patch) => bitvideos.einstellen(patch));
  ipcMain.handle('bit-wunsch-add', (_e, a) => bitvideos.wunschHinzu(a && a.thema, a && a.link));
  ipcMain.handle('bit-wunsch-remove', (_e, id) => bitvideos.wunschEntfernen(id));
  ipcMain.handle('bit-wunsch-vor', (_e, id) => bitvideos.wunschVor(id));
  ipcMain.handle('bit-aktion', (_e, a) => bitvideos.aktionSetzen(a && a.video, a && a.patch));
  ipcMain.handle('bit-sperren', (_e, a) => bitvideos.sperren(a && a.thema, !!(a && a.an)));

  ipcMain.handle('vault-info', () => ({ vault: currentVault() }));
  const vaultCache = new Map(); // Suchwort → { at, res }
  ipcMain.handle('vault-search', (_e, q) => {
    const query = typeof q === 'string' ? q.slice(0, 200) : '';
    const hit = vaultCache.get(query);
    if (hit && Date.now() - hit.at < 15000) return hit.res;
    const t = Date.now();
    const res = withVault((dir) => vault.search(dir, query));
    dataLayer.measure('daten:gehirn-suche', Date.now() - t, !(res && res.ok === false));
    if (vaultCache.size > 50) vaultCache.clear();
    vaultCache.set(query, { at: Date.now(), res });
    return res;
  });
  ipcMain.handle('vault-read', (_e, rel) => withVault((dir) => vault.readNote(dir, rel)));
  ipcMain.handle('vault-add', (_e, args) => withVault((dir) => vault.addNote(dir, args && args.title, args && args.text)));
  ipcMain.handle('vault-open', (_e, rel) => withVault((dir) => {
    const found = vault.readNote(dir, rel);
    if (!found.ok) return found;
    shell.openExternal(vault.obsidianUrl(dir, rel));
    return { ok: true };
  }));

  // ---------- Musik ----------

  const musicAllowed = () => process.platform === 'darwin' && settings.get().connections.mac;
  ipcMain.handle('music-now', () => (musicAllowed() ? music.nowPlaying() : null));
  // Titelwechsel, Play und Pause kommen sofort an (statt erst bei der nächsten Abfrage).
  const musicWatch = new MusicWatch();
  let musicSeq = 0;
  musicWatch.on('change', async () => {
    if (!musicAllowed() || !win) return;
    const seq = ++musicSeq; // beim schnellen Weiterschalten nur das neueste Ergebnis zeigen
    const res = await music.nowPlaying().catch(() => null);
    if (seq === musicSeq && res && res.ok) send('music-now', res.data);
  });
  ipcMain.handle('music-control', (_e, args) => (musicAllowed() && args
    ? music.control(String(args.app || ''), String(args.action || '')) : { ok: false, error: 'Die Verbindung „Mein Mac“ ist aus.' }));

  // ---------- Automatisierungen (n8n) ----------

  ipcMain.handle('n8n-status', async () => {
    const health = await n8nClient().health();
    return { url: n8nConfig.url, running: health.ok, hasKey: !!n8nConfig.key };
  });
  // Prüft Adresse und Schlüssel an n8n und speichert erst dann (verschlüsselt). Der Schlüssel geht nie zurück an die Oberfläche.
  async function connectN8n(rawUrl, rawKey) {
    const url = normalizeBase(rawUrl);
    if (!url) return { ok: false, error: 'Das ist keine gültige Adresse (z. B. http://localhost:5678).' };
    if (url.startsWith('http:') && !isLoopback(url)) return { ok: false, error: 'Für ein n8n außerhalb deines Macs bitte eine https-Adresse – sonst ginge der Schlüssel unverschlüsselt durchs Netz.' };
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > 4000) return { ok: false, error: 'Bitte den API-Schlüssel aus n8n einfügen.' };
    const test = await new N8n({ baseUrl: url, apiKey: key }).listWorkflows();
    if (!test.ok) return test;
    if (!saveN8n({ url, key })) return { ok: false, error: 'Der Schlüssel konnte nicht sicher gespeichert werden (Schlüsselbund nicht verfügbar).' };
    return { ok: true, count: test.data.length };
  }

  // „Aus Zwischenablage verbinden“: Die Zentrale liest den kopierten Schlüssel selbst und leert danach die Zwischenablage.
  ipcMain.handle('n8n-connect-clipboard', async (_e, args) => {
    // Seit Electron 44 liefert readText ein Promise.
    const read = async () => String((await clipboard.readText()) || '').trim();
    const text = await read();
    if (!text || /\s/.test(text) || text.length < 20) return { ok: false, error: 'In der Zwischenablage ist kein API-Schlüssel. Kopiere ihn in n8n mit „Copy“ und versuch es noch einmal.' };
    const res = await connectN8n(args && args.url, text);
    if (res.ok && (await read()) === text) await clipboard.clear();
    return res;
  });

  // „Automatisch verbinden“: Im angemeldeten n8n-Tab legt die Zentrale selbst einen Schlüssel an –
  // er geht direkt in den Schlüsselbund, niemand bekommt ihn zu sehen.
  ipcMain.handle('n8n-auto-connect', async (_e, args) => {
    const url = normalizeBase(args && args.url) || n8nConfig.url;
    if (url.startsWith('http:') && !isLoopback(url)) return { ok: false, error: 'Automatisch verbinden geht nur mit https oder dem n8n auf deinem Mac.' };
    let portal = webTabs.store.get().portals.find((p) => new URL(p.url).origin === url);
    if (!portal) { const r = webTabs.store.add('n8n', `${url}/`); if (!r.ok) return r; portal = r.portal; }
    const entry = webTabs.ensure(portal.id);
    if (!entry) return { ok: false, error: 'Der n8n-Tab ließ sich nicht öffnen.' };
    const wc = entry.view.webContents;
    if (wc.isLoading()) await new Promise((r) => { const t = setTimeout(r, 15000); wc.once('did-stop-loading', () => { clearTimeout(t); r(); }); });
    if (new URL(wc.getURL() || portal.url).origin !== url) return { ok: false, needLogin: true, id: portal.id, error: 'Bitte melde dich zuerst im n8n-Tab an.' };
    let res;
    try { res = await wc.executeJavaScriptInIsolatedWorld(N8N_WORLD, [{ code: N8N_CREATE_KEY }]); } catch (e) { res = { error: 'script', message: e.message }; }
    if (!res || res.error === 'login') return { ok: false, needLogin: true, id: portal.id, error: 'Bitte melde dich zuerst im n8n-Tab an – danach noch einmal „Automatisch verbinden“.' };
    if (res.error) return { ok: false, error: `n8n hat keinen Schlüssel erstellt${res.status ? ` (Fehler ${res.status})` : ''}${res.message ? `: ${res.message}` : ''}. Nimm dann den Weg über „Aus Zwischenablage verbinden“.` };
    return connectN8n(url, res.key);
  });

  ipcMain.handle('n8n-connect', async (_e, args) => connectN8n(args && args.url, args && args.key));

  // Schlüssel, den die Bit-Automatik schon auf dem Mac hat (~/.config/bitai, nur für dich lesbar):
  // die Zentrale liest ihn selbst und legt ihn in den Schlüsselbund – angezeigt wird er nie.
  const BIT_N8N_KEY = path.join(os.homedir(), '.config', 'bitai', 'n8n_api_key');
  const bitKeyUsable = () => { try { const st = fs.statSync(BIT_N8N_KEY); return st.isFile() && (st.mode & 0o077) === 0 && st.size < 4000; } catch { return false; } };
  ipcMain.handle('n8n-file-available', () => bitKeyUsable());
  ipcMain.handle('n8n-connect-file', async (_e, args) => {
    if (!bitKeyUsable()) return { ok: false, error: 'Kein passender n8n-Schlüssel auf dem Mac gefunden.' };
    const url = normalizeBase((args && args.url) || n8nConfig.url);
    if (!url || (!isLoopback(url) && url !== n8nConfig.url)) return { ok: false, error: 'Den Schlüssel der Bit-Automatik gibt die Zentrale nur an das n8n auf diesem Mac.' };
    return connectN8n(url, fs.readFileSync(BIT_N8N_KEY, 'utf8'));
  });

  // Bewusst getrennt: dann verbindet die Zentrale auch beim Start nicht von selbst wieder.
  ipcMain.handle('n8n-disconnect', () => saveN8n({ url: n8nConfig.url, key: null, off: true }));
  ipcMain.handle('n8n-workflows', () => n8nClient().listWorkflows());
  ipcMain.handle('n8n-executions', () => n8nClient().listExecutions(50));
  ipcMain.handle('n8n-set-active', (_e, args) => (args && typeof args.id === 'string'
    ? n8nClient().setActive(args.id, args.active === true) : { ok: false, error: 'Workflow fehlt.' }));
  // Öffnet den n8n-Editor als Tab im Bereich Web (die Anmeldung bei n8n bleibt dort gespeichert).
  ipcMain.handle('n8n-open-editor', (_e, id) => {
    const target = n8nClient().editorUrl(typeof id === 'string' ? id : null);
    const origin = new URL(target).origin;
    let portal = webTabs.store.get().portals.find((p) => new URL(p.url).origin === origin);
    if (!portal) {
      const res = webTabs.store.add('n8n', `${origin}/`);
      if (!res.ok) return res;
      portal = res.portal;
    }
    webTabs.show(portal.id);
    webTabs.openUrl(portal.id, target);
    return { ok: true, id: portal.id };
  });

  // ---------- Web: Seiten mit dauerhaftem Login ----------

  const webState = () => ({ ...webTabs.info(), presets: PRESETS, profiles: webTabs.store.profiles(), nextProfile: webTabs.store.nextProfile() });
  ipcMain.handle('web-state', () => webState());
  ipcMain.handle('web-add', (_e, args) => {
    const res = webTabs.store.add(args && args.name, args && args.url, args && args.profile);
    if (res.ok) webTabs.show(res.portal.id);
    return res.ok ? { ok: true, id: res.portal.id } : res;
  });
  // „BIT AI News einrichten“: die drei Kanal-Tabs im eigenen Bit-Konto anlegen (Anmelden machst du).
  ipcMain.handle('web-setup-bit', () => {
    const have = webTabs.store.get().portals.filter((p) => p.profile === BIT_PROFILE).map((p) => p.url);
    let first = null;
    for (const t of BIT_TABS.filter((x) => !have.includes(x.url))) {
      const r = webTabs.store.add(t.name, t.url, BIT_PROFILE);
      if (!r.ok) return r;
      first = first || r.portal.id;
    }
    if (first) webTabs.show(first);
    return { ok: true, added: !!first };
  });
  ipcMain.handle('web-show', (_e, id) => typeof id === 'string' && webTabs.show(id));
  ipcMain.handle('web-close', (_e, id) => { if (typeof id === 'string') webTabs.close(id); });
  ipcMain.handle('web-rename', (_e, args) => {
    const ok = !!args && typeof args.id === 'string' && webTabs.store.rename(args.id, args.name);
    webTabs.emit('change');
    return ok;
  });
  ipcMain.handle('web-nav', (_e, args) => {
    if (args && typeof args.id === 'string' && ['back', 'forward', 'reload', 'home'].includes(args.action)) webTabs.navigate(args.id, args.action);
  });
  ipcMain.handle('web-bounds', (_e, rect) => webTabs.setBounds(rect));
  ipcMain.handle('web-visible', (_e, on) => webTabs.setVisible(on === true));
  // „Video analysieren“: Auftrag für Claude zum Video im Tab. Braucht die Seite eine Anmeldung, kommt eine
  // Cookie-Datei nur für diese Seite dazu (nur für dich lesbar, nach 15 Minuten und beim Beenden gelöscht).
  const COOKIE_TTL_MS = 15 * 60000;
  const cookieDir = () => path.join(app.getPath('userData'), 'video-anmeldung');
  const clearCookieFiles = (all) => {
    try {
      for (const f of fs.readdirSync(cookieDir())) {
        const p = path.join(cookieDir(), f);
        if (all || Date.now() - fs.statSync(p).mtimeMs > COOKIE_TTL_MS) fs.unlinkSync(p);
      }
    } catch {}
  };
  ipcMain.handle('web-analyze-video', async (_e, id) => {
    const p = webTabs && webTabs.info().portals.find((x) => x.id === id);
    if (!p) return { ok: false, error: 'Tab nicht gefunden.' };
    const site = videoSite(p.current);
    if (!site) return { ok: false, error: 'Öffne zuerst ein einzelnes Video in diesem Tab.' };
    clearCookieFiles(true);
    if (!site.login) return { ok: true, data: analyzePrompt(p.current, site), site: site.name };
    // Seiten mit Anmeldung: die Zentrale lädt das Video selbst herunter. Die Anmeldung (Cookies) bekommt Claude
    // nie zu sehen – die Datei existiert nur während des Downloads und wird sofort danach gelöscht.
    const ytdlp = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp'].find((x) => fs.existsSync(x));
    if (!ytdlp) return { ok: false, error: 'yt-dlp fehlt (brew install yt-dlp).' };
    const cookies = await portalSession(partitionFor(p.profile)).cookies.get({}).catch(() => []);
    const { count, text } = cookieFileText(cookies, site.domain);
    if (!count) return { ok: false, error: `Bitte melde dich zuerst im Tab bei ${site.name} an.` };
    fs.mkdirSync(cookieDir(), { recursive: true, mode: 0o700 });
    const cookieFile = path.join(cookieDir(), `${site.domain}-${Date.now()}.txt`);
    fs.writeFileSync(cookieFile, text, { mode: 0o600 });
    const outDir = path.join(os.homedir(), 'video-analyse', '.downloads');
    fs.mkdirSync(outDir, { recursive: true });
    let out = '';
    try {
      out = await new Promise((resolve, reject) => execFile(ytdlp, ['--no-playlist', '--no-progress', '--cookies', cookieFile,
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '--restrict-filenames',
        '-o', path.join(outDir, '%(title).60s-%(id)s.%(ext)s'), '--print', 'after_move:filepath', '--no-simulate', p.current],
      { timeout: 300000, maxBuffer: 4 * 1024 * 1024, env: claude.env || process.env }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));
    } catch (err) {
      return { ok: false, error: `Das Video ließ sich nicht laden: ${String(err.message || err).split('\n').slice(-2).join(' ').slice(0, 200)}` };
    } finally { clearCookieFiles(true); }
    const file = out.trim().split('\n').filter((l) => l.startsWith('/')).pop();
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'Das Video ließ sich nicht laden.' };
    return { ok: true, data: analyzePrompt(p.current, site, file), site: site.name };
  });

  ipcMain.handle('web-open-browser', (_e, id) => {
    const url = typeof id === 'string' && webTabs.currentUrl(id);
    if (url && /^https?:\/\//.test(url)) shell.openExternal(browserTarget(url)).catch(() => {});
  });
  ipcMain.handle('web-clear-logins', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Abbrechen', 'Überall abmelden'], defaultId: 0, cancelId: 0,
      message: 'Bei allen Web-Seiten der Zentrale abmelden?',
      detail: 'Das löscht die gespeicherten Anmeldungen und Seitendaten aller Tabs. Die Tabs selbst bleiben.',
    });
    if (response !== 1) return false;
    await webTabs.clearLogins();
    return true;
  });

  // ---------- App-Sperre ----------
  function lockApp() {
    if (appLocked || !settings || !settings.get().appLock.enabled) return;
    appLocked = true;
    finLock();
    if (webTabs) webTabs.setVisible(false);
    loadPage();
  }
  async function verifyUser(method) {
    if (process.platform !== 'darwin') return { ok: true };
    if (method === 'touchid') {
      if (!systemPreferences.canPromptTouchID()) return { ok: false, error: 'Touch ID ist gerade nicht verfügbar – nimm das Mac-Passwort.' };
      try { await systemPreferences.promptTouchID('die Zentrale zu entsperren'); return { ok: true }; } catch { return { ok: false, cancelled: true }; }
    }
    // Mac-Passwort: macOS fragt selbst (die Zentrale sieht das Passwort nie).
    const ok = await new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', 'do shell script "/usr/bin/true" with prompt "Die Zentrale möchte entsperrt werden." with administrator privileges'],
      { timeout: 120000 }, (err) => resolve(!err)));
    return ok ? { ok: true } : { ok: false, cancelled: true };
  }
  ipcMain.handle('app-unlock', async (e, method) => {
    if (!win || e.sender !== win.webContents) return { ok: false, error: 'Nicht erlaubt.' };
    if (!appLocked) return { ok: true };
    const r = await verifyUser(method === 'password' ? 'password' : 'touchid');
    if (!r.ok) return r;
    appLocked = false;
    loadPage();
    return { ok: true };
  });
  ipcMain.handle('app-lock', () => { lockApp(); return { ok: true }; });
  const lockTimer = setInterval(() => {
    const l = settings && settings.get().appLock;
    if (l && l.enabled && !appLocked && powerMonitor.getSystemIdleTime() >= l.minutes * 60) lockApp();
  }, 20000);
  powerMonitor.on('lock-screen', lockApp);
  powerMonitor.on('suspend', lockApp);

  // Nach dem Entsperren (Seite neu geladen) den Verlauf des offenen Gesprächs wieder zeigen.
  ipcMain.handle('chat-history', () => {
    const s = chat && findSession(chat.sessionId);
    if (!s) return [];
    try { return readMessages(s.file, 400, { tools: true }); } catch { return []; }
  });

  // ---------- Kontrollraum: blinde Flecken, Tempo, Fehler, Schutz ----------
  const LOGIN_COOKIES = [[/instagram\.com$/, 'instagram.com', ['sessionid']], [/tiktok\.com$/, 'tiktok.com', ['sessionid', 'sid_tt']],
    [/(youtube|google)\.com$/, 'google.com', ['SID', '__Secure-3PSID']], [/facebook\.com$/, 'facebook.com', ['c_user']]];
  async function loginFacts() {
    const out = [];
    for (const p of (webTabs ? webTabs.info().portals : [])) {
      let host = '';
      try { host = new URL(p.url).hostname; } catch { continue; }
      const rule = LOGIN_COOKIES.find(([re]) => re.test(host));
      if (!rule || p.profile !== 'bit') continue; // geprüft werden die Kanäle von Bit
      const cookies = await portalSession(partitionFor(p.profile)).cookies.get({ domain: rule[1] }).catch(() => []);
      out.push({ id: p.id, name: p.name, loggedIn: cookies.some((c) => rule[2].includes(c.name)) });
    }
    return out;
  }
  function fuseFacts() {
    try { return require('../package.json').build.electronFuses || {}; } catch { return {}; }
  }
  async function securityFacts() {
    const sockets = [n8nSocketPath(app.getPath('userData')), n8nSocketPath(app.getPath('userData'), 'browser')];
    return security.check({ pids: app.getAppMetrics().map((m) => m.pid), userData: app.getPath('userData'), sockets,
      packaged: app.isPackaged, appLock: settings.get().appLock, touchId: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      safeStorage: safeStorage.isEncryptionAvailable(), nodeForTools: !!NODE_BIN, fuses: fuseFacts(),
      backup: { dir: settings.get().backup.dir, lastAt: backupStore.get().lastAt } });
  }
  ipcMain.handle('kontrolle-report', async () => {
    const [n8nHealth, disk, logins, sec] = await Promise.all([n8nClient().health().catch(() => ({ ok: false })), health.disk(), loginFacts(), securityFacts()]);
    const data = dataLayer.report();
    const w = folderWatcher ? folderWatcher.get() : { unsorted: [] };
    const spots = blindSpots({ claudeFound: !!claude.bin, online: net.isOnline(), claudeAuthProblem: !!claudeAuthProblemAt, n8n: { running: !!n8nHealth.ok, hasKey: !!n8nConfig.key }, connections: settings.get().connections,
      logins, tasks: scheduler ? scheduler.list() : [], alerts: alerts ? alerts.get() : [], disk, unsorted: w.unsorted.length, data, security: sec });
    return { ok: true, spots, data, security: sec };
  });
  // ---------- Backup & Firewall ----------
  const backupStore = store('backup.json', { lastDay: null, lastAt: null, lastDir: null, lastError: null });
  async function backupState() {
    const cfg = settings.get().backup;
    const target = cfg.dir ? backup.checkTarget(cfg.dir, { userData: app.getPath('userData') }) : null;
    const [tm, fw, exposed] = await Promise.all([backup.timeMachine(), backup.firewall(), backup.exposedApps()]);
    return { ok: true, cfg, target, last: backupStore.get(), list: target && target.ok ? backup.listBackups(target.dir).slice(0, backup.KEEP) : [], tm, fw, exposed };
  }
  async function doBackup(auto) {
    const cfg = settings.get().backup;
    if (!cfg.dir) return { ok: false, error: 'Erst einen Sicherungs-Ordner wählen.' };
    const r = await backup.runBackup({ userData: app.getPath('userData'), target: cfg.dir, trash: (p) => shell.trashItem(p) });
    const last = backupStore.get();
    if (r.ok) backupStore.set({ lastDay: backup.localDay(), lastAt: Date.now(), lastDir: r.dir, lastError: null });
    else if (!(auto && r.missing)) backupStore.set({ ...last, lastError: r.error }); // abgesteckte Platte beim Automatik-Lauf ist kein Fehler
    return r;
  }
  ipcMain.handle('schutz-state', () => backupState());
  ipcMain.handle('backup-choose', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Ordner für die Sicherung wählen (am besten auf einer externen Platte)' });
    if (res.canceled || !res.filePaths[0]) return { ok: false, cancelled: true };
    const t = backup.checkTarget(res.filePaths[0], { userData: app.getPath('userData') });
    if (!t.ok) return t;
    settings.update({ backup: { dir: t.dir } });
    pushState();
    return { ok: true, ...t };
  });
  ipcMain.handle('backup-run', () => doBackup(false));
  ipcMain.handle('backup-show', () => { const d = settings.get().backup.dir; if (d && fs.existsSync(d)) shell.openPath(d); return { ok: true }; });
  ipcMain.handle('tm-start', () => backup.startTimeMachine());
  ipcMain.handle('tm-open', () => { shell.openExternal(backup.TM_SETTINGS); return { ok: true }; });
  ipcMain.handle('fw-open', () => { shell.openExternal(backup.FW_SETTINGS); return { ok: true }; });
  ipcMain.handle('fw-enable', async (_e, opts) => {
    const stealth = !!(opts && opts.stealth === true);
    const ok = await dialog.showMessageBox(win, { type: 'question', buttons: ['Einschalten', 'Abbrechen'], defaultId: 0, cancelId: 1,
      message: stealth ? 'Mac-Firewall und Tarnmodus einschalten?' : 'Mac-Firewall einschalten?',
      detail: 'macOS fragt gleich nach deinem Mac-Passwort – die Zentrale sieht es nicht. Programme, die aus dem Netz erreichbar sein sollen, fragt macOS danach einmal, ob sie dürfen. Ausschalten geht jederzeit in Systemeinstellungen → Netzwerk → Firewall.' });
    if (ok.response !== 0) return { ok: false, cancelled: true, error: 'Abgebrochen – nichts geändert.' };
    return backup.enableFirewall({ stealth });
  });
  async function dailyBackup() {
    const cfg = settings.get().backup;
    if (!backup.isDue(cfg, backupStore.get().lastDay)) return;
    const r = await doBackup(true);
    if (r.ok) notify('Gesichert', `Die Daten der Zentrale liegen jetzt auch in ${path.basename(path.dirname(path.dirname(r.dir)))}.`, 'kontrolle');
    else if (!r.missing) notify('Sicherung ging nicht', r.error, 'kontrolle');
  }

  // ---------- Lernen & Training ----------
  let learnObj = null;
  function learnStore() {
    if (learnObj) return learnObj;
    const v = currentVault();
    const dir = v ? path.join(v.path, 'Lernen') : path.join(app.getPath('userData'), 'lernen-protokolle');
    learnObj = new learning.LearningStore(path.join(app.getPath('userData'), 'lernen.json'), dir);
    return learnObj;
  }
  let trainObj = null;
  const trainStore = () => trainObj || (trainObj = new training.TrainingStore(path.join(app.getPath('userData'), 'training.json')));
  const restartForLearning = () => { if (chat) chat.needsRestart = true; }; // neues Lernthema gilt ab der nächsten Nachricht
  ipcMain.handle('learn-list', () => learnStore().refresh());
  ipcMain.handle('learn-add', (_e, raw) => { const r = learnStore().add(raw); if (r.ok) restartForLearning(); return r; });
  ipcMain.handle('learn-remove', (_e, id) => { learnStore().remove(id); restartForLearning(); return learnStore().list(); });
  ipcMain.handle('learn-activate', (_e, id) => { learnStore().setActive(typeof id === 'string' ? id : null); restartForLearning(); return learnStore().list(); });
  ipcMain.handle('learn-prompt', (_e, a) => {
    const st = learnStore();
    const l = st.lessons.find((x) => x.id === (a && a.id));
    if (!l) return { ok: false, error: 'Thema nicht gefunden.' };
    fs.mkdirSync(st.protocolDir, { recursive: true });
    const file = st.protocolPath(l);
    return { ok: true, prompt: a.review ? learning.reviewPrompt(l, file) : learning.learnPrompt(l, file) };
  });
  ipcMain.handle('learn-open', (_e, id) => { const st = learnStore(); const l = st.lessons.find((x) => x.id === id); if (l && fs.existsSync(st.protocolPath(l))) shell.openPath(st.protocolPath(l)); });
  ipcMain.handle('learn-open-lessons', () => { if (fs.existsSync(learning.LESSONS_FILE)) shell.openPath(learning.LESSONS_FILE); else return { ok: false, error: 'Noch keine Lektionen – nach der ersten Lernrunde gibt es sie.' }; });

  // Ideen aus allen Projekten + aus dem Data Layer (langsame/kaputte Abläufe der Zentrale selbst).
  async function scanTraining() {
    const roots = new Set();
    const ideas = [];
    for (const p of projectsCache) {
      if (!p.path || !isDir(p.path) || p.path === os.homedir() || p.path.startsWith(training.ROOT())) continue;
      for (const i of await training.scanProject(p.path).catch(() => [])) {
        if (roots.has(i.key)) continue;
        roots.add(i.key);
        ideas.push(i);
      }
    }
    const extra = [];
    // Das Repo der Zentrale selbst (in der installierten App liegt der Code in app.asar, nicht im Repo).
    const repo = [path.join(os.homedir(), 'werkstatt-crm', 'zentrale'), path.resolve(__dirname, '..')].find((d) => fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(path.dirname(d), '.git')));
    const r = dataLayer.report();
    for (const x of (repo ? r.slowest : []).filter((y) => y.avgMs > 800 && y.count >= 3).slice(0, 1)) {
      extra.push({ key: `zentrale|langsam|${x.name}`, kind: 'tempo', target: x.name, project: 'zentrale', dir: repo,
        title: `Zentrale schneller machen: ${x.name}`, why: `im Schnitt ${x.avgMs} ms bei ${x.count} Aufrufen (Data Layer).` });
    }
    const added = trainStore().addIdeas(ideas.sort(() => Math.random() - 0.5), extra);
    return { ok: true, added, ...trainStore().list() };
  }
  ipcMain.handle('train-list', () => trainStore().list());
  ipcMain.handle('train-scan', () => scanTraining());
  ipcMain.handle('train-settings', (_e, s) => { trainStore().setSettings(s); return trainStore().list(); });
  ipcMain.handle('train-start', async (_e, id) => {
    const t = trainStore().tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'Aufgabe nicht gefunden.' };
    let task = t;
    if (!t.worktree || !fs.existsSync(t.worktree)) {
      const w = await training.createWorktree(t);
      if (!w.ok) return w;
      task = trainStore().update(id, { worktree: w.worktree, branch: w.branch, status: 'läuft', startedAt: Date.now() });
    }
    await claudeReady;
    if (!claude.bin) return { ok: false, error: 'Claude Code wurde nicht gefunden.' };
    const info = await openChat({ cwd: task.worktree });
    return { ok: true, chat: info, prompt: training.trainPrompt(task) };
  });
  ipcMain.handle('train-changes', async (_e, id) => {
    const t = trainStore().tasks.find((x) => x.id === id);
    return t ? training.changes(t) : { ok: false, error: 'Aufgabe nicht gefunden.' };
  });
  ipcMain.handle('train-done', (_e, id) => ({ ok: !!trainStore().update(id, { status: 'fertig', doneAt: Date.now() }) }));
  ipcMain.handle('train-adopt', async (_e, id) => {
    const t = trainStore().tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'Aufgabe nicht gefunden.' };
    const c = await training.changes(t);
    if (!c.ok) return c;
    const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Abbrechen', 'Übernehmen'], defaultId: 1, cancelId: 0,
      message: `„${t.title}“ ins Projekt ${t.project} übernehmen?`, detail: `${c.stat || 'Keine Änderungen.'}\n\nDas holt die Änderungen in den aktuellen Zweig von ${t.dir}.` });
    if (response !== 1) return { ok: false, cancelled: true };
    const r = await training.adopt(t);
    if (r.ok) { trainStore().update(id, { status: 'übernommen', adoptedAt: Date.now(), worktree: null }); trainStore().drop(id); }
    return r;
  });
  ipcMain.handle('train-discard', async (_e, id) => {
    const t = trainStore().tasks.find((x) => x.id === id);
    if (!t) return { ok: true };
    await training.discard(t);
    trainStore().drop(id);
    return { ok: true };
  });
  ipcMain.handle('train-reveal', (_e, id) => { const t = trainStore().tasks.find((x) => x.id === id); if (t && t.worktree && fs.existsSync(t.worktree)) shell.openPath(t.worktree); });

  // Täglich: Projekte durchsuchen und fällige Nachprüfungen melden (im Minuten-Takt des Morgen-Cockpits).
  let learnNotifiedDay = null;
  async function dailyLearning() {
    const ts = trainStore();
    if (ts.isDue()) {
      const r = await scanTraining().catch(() => null);
      if (r && r.added) notify('Neue Mini-Aufgaben', `${r.added} neue Trainings-Aufgaben aus deinen Projekten – isoliert, dein Code bleibt unberührt.`, 'lernen');
    }
    const due = learnStore().dueReviews();
    const today = training.localDay();
    if (due.length && learnNotifiedDay !== today) {
      learnNotifiedDay = today;
      notify('Nachprüfung fällig', `${due.map((l) => `„${l.topic}“`).join(', ')} – kurz testen, ob es sitzt.`, 'lernen');
    }
  }

  // ---------- Simulation ----------
  ipcMain.handle('sim-notfall', () => simulation.emergencyProbe());
  ipcMain.handle('sim-test-notify', () => { notify('Probe-Mitteilung', 'So sieht eine Warnung der Zentrale aus. Alles in Ordnung.', 'kontrolle'); return { ok: true }; });
  // Probelauf: 30 Minuten lang führen Claudes Web- und n8n-Werkzeuge nichts Echtes aus.
  const DRY_MS = 30 * 60000;
  ipcMain.handle('sim-dryrun-start', (_e, a) => {
    const kinds = ['upload', 'n8n', 'kommentare', 'frei'];
    const kind = a && kinds.includes(a.kind) ? a.kind : 'frei';
    dryRunUntil = Date.now() + DRY_MS;
    pushState();
    return { ok: true, prompt: simulation.dryRunPrompt(kind, a && typeof a.detail === 'string' ? a.detail.slice(0, 2000) : '') };
  });
  ipcMain.handle('sim-dryrun-stop', () => { dryRunUntil = 0; pushState(); return { ok: true }; });
  ipcMain.handle('sim-bit-preview', (_e, topic) => {
    dryRunUntil = Date.now() + DRY_MS; // auch hier: nichts Echtes in den Web-Tabs
    pushState();
    return { ok: true, prompt: simulation.bitPreviewPrompt(typeof topic === 'string' ? topic.slice(0, 300) : '') };
  });

  ipcMain.handle('kontrolle-view', (_e, v) => { dataLayer.trackView(v); });
  ipcMain.handle('kontrolle-error', (_e, a) => { dataLayer.trackRendererError(a && a.where, a && a.code); });
  ipcMain.handle('kontrolle-reset', () => { dataLayer.reset(); return { ok: true }; });

  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && EXTERNAL_LINKS.has(url)) shell.openExternal(url);
  });

  app.on('second-instance', () => {
    app.whenReady().then(() => { if (!win) createWindow(); win.show(); win.focus(); });
  });

  app.whenReady().then(async () => {
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    appLocked = settings.get().appLock.enabled; // beim Start gesperrt
    topicStore = new TopicStore(path.join(app.getPath('userData'), 'topics.json'));
    webTabs = new WebTabs(new PortalStore(path.join(app.getPath('userData'), 'portals.json')));
    webTabs.on('change', () => send('web-state', webState()));
    webTabs.on('shortcut', (name) => { if (name === 'switcher') send('switcher-toggle'); });
    // Google sperrt die Anmeldung in eingebauten Browsern – im normalen Browser geht sie ganz normal.
    webTabs.on('google-signin', ({ url }) => shell.openExternal(browserTarget(url)).catch(() => {}));
    // Claude bedient Web-Tabs nur über diese Vermittlung; was er gerade tut, sieht die Oberfläche live.
    browser = new BrowserControl(webTabs);
    browser.on('activity', (a) => send('web-activity', { ...a, name: (webTabs.store.get().portals.find((p) => p.id === a.id) || {}).name || '' }));
    browserProxy = startProxy(simulation.dryRunOps(makeBrowserOps(browser), simulation.DRY_BROWSER, dryRunActive, 'Web-Tab'), n8nSocketPath(app.getPath('userData'), 'browser'));
    nativeTheme.themeSource = settings.get().theme;
    loadN8n();
    // Noch nicht verbunden (und nicht bewusst getrennt): mit dem Schlüssel der Bit-Automatik verbinden.
    if (!n8nConfig.key && !n8nConfig.off && bitKeyUsable()) {
      connectN8n(n8nConfig.url, fs.readFileSync(BIT_N8N_KEY, 'utf8')).then((r) => { if (r.ok) pushState(); }).catch(() => {});
    }
    n8nProxy = startProxy(simulation.dryRunOps(makeOps(n8nClient), simulation.DRY_N8N, dryRunActive, 'n8n'), n8nSocketPath(app.getPath('userData')));
    startFolderWatcher();
    startAlerts();
    startMorning();
    registerScreenShortcut();
    cleanScreenshots();
    musicWatch.start();
    writeMacConfig();
    refreshProjects();
    createWindow();

    scheduler = new TaskScheduler(path.join(app.getPath('userData'), 'tasks.json'), (task) => {
      if (!claude.bin) return Promise.resolve({ ok: false, text: 'Claude Code wurde nicht gefunden.' });
      const cwd = isDir(task.cwd) ? task.cwd : os.homedir();
      return runTask({
        bin: claude.bin, env: claude.env, cwd, prompt: task.prompt, extraArgs, approvalInfo, allowAll,
        onApproval: (c) => {
          // Läuft die Aufgabe, merken wir uns ihren Chat, damit Freigaben zugeordnet werden können.
          if (!taskChats.has(c)) taskChats.set(c, task.name);
          onApprovalsChanged();
        },
      }).finally(() => {
        for (const c of [...taskChats.keys()]) if (c.disposed) taskChats.delete(c);
        pushState();
      });
    });
    scheduler.on('change', pushState);

    sessionWatcher = watchSessions(DEFAULT_ROOT);
    sessionWatcher.on('change', () => { refreshProjects(); pushState(); });

    // Claude suchen, ohne das Fenster zu blockieren; dann sofort im letzten Projekt starten.
    claude = { ...(await resolveClaude()), checking: false };
    markClaudeReady();
    pushState();
    scheduler.start();
    if (claude.bin) await openChat({ cwd: defaultCwd() });
  });

  app.on('activate', () => {
    if (win) win.show(); else createWindow();
  });

  // Beim Beenden warten, bis Claude und laufende Aufgaben wirklich gestoppt sind.
  app.on('before-quit', (e) => {
    quitting = true;
    if (cleanedUp) return;
    e.preventDefault();
    cleanedUp = true;
    if (scheduler) scheduler.stop();
    if (folderWatcher) folderWatcher.stop();
    if (alerts) alerts.stop();
    clearInterval(morningTimer);
    clearInterval(finTimer);
    clearInterval(lockTimer);
    dataLayer.stop();
    globalShortcut.unregisterAll();
    musicWatch.stop();
    clearCookieFiles(true);
    if (sessionWatcher) sessionWatcher.close();
    const jobs = [stopAllTasks()];
    if (webTabs) jobs.push(webTabs.saveLogins());
    if (n8nProxy) n8nProxy.close();
    if (browserProxy) browserProxy.close();
    if (chat) jobs.push(chat.dispose());
    Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 6000))]).then(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
