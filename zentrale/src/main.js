// Hauptprozess: öffnet das Fenster, startet Claude automatisch und hält alles synchron.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, nativeImage, safeStorage } = require('electron');
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
const { PortalStore, PRESETS } = require('./portals');
const { WebTabs } = require('./web-tabs');
const { READ_ONLY_TOOLS } = require('./mcp/mac-server');
const { READ_ONLY_TOOLS: N8N_READ_ONLY } = require('./mcp/n8n-server');
const { N8n, DEFAULT_URL: N8N_DEFAULT_URL, normalizeBase, isLoopback } = require('./n8n');
const { startProxy, makeOps, socketPath: n8nSocketPath } = require('./n8n-proxy');

// Links, die die Oberfläche öffnen darf.
const EXTERNAL_LINKS = new Set([
  'https://claude.ai/settings/connectors',
  'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
]);

// So frisch geschriebene Gespräche benutzt vermutlich gerade ein anderes Claude-Fenster.
const IN_USE_MS = 2 * 60 * 1000;

// Nur eine Zentrale gleichzeitig, sonst liefen tägliche Aufgaben doppelt.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  setup();
}

function setup() {
  let win = null;
  let claude = { bin: null, env: process.env, version: null, checking: true };
  let chat = null;
  let chatGen = 0;
  let scheduler = null;
  let settings = null;
  let topicStore = null;
  let webTabs = null;
  const iconCache = new Map();
  let sessionWatcher = null;
  let projectsCache = [];
  let quitting = false;
  let cleanedUp = false;
  let macConfigFile = null;
  let n8nConfigFile = null;
  let n8nProxy = null;
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
    return projectsCache;
  }

  function chatInfo() {
    if (!chat) return null;
    return { gen: chatGen, cwd: chat.cwd, name: path.basename(chat.cwd) || chat.cwd, sessionId: chat.sessionId, status: chat.status,
      title: chat.title, careful: chat.permissionMode !== 'acceptEdits' };
  }

  function approvals() {
    const list = [];
    if (chat) for (const a of chat.pendingApprovals()) list.push({ ...a, source: chat.title ? `Chat „${chat.title}“` : 'Chat' });
    for (const [c, name] of taskChats) for (const a of c.pendingApprovals()) list.push({ ...a, source: `Tägliche Aufgabe „${name}“` });
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  function snapshot() {
    return {
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
    send('state', snapshot());
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
    if (allowed.length) args.push(`--allowedTools=${allowed.join(',')}`);
    if (c.chrome) args.push('--chrome');
    return args;
  }


  // Die MCP-Server laufen mit der Node-Laufzeit, die in Electron steckt.
  function writeMcpConfig(name, script, env = {}) {
    const server = path.join(__dirname, 'mcp', script).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const file = path.join(app.getPath('userData'), `mcp-${name}.json`);
    const config = { mcpServers: { [name]: { type: 'stdio', command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1', ...env } } } };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      return file;
    } catch {
      return null;
    }
  }

  function writeMacConfig() {
    macConfigFile = writeMcpConfig('mac', 'mac-server.js');
    // Der n8n-Server bekommt nur den Weg zur Vermittlung in der Zentrale – keinen Schlüssel.
    n8nConfigFile = writeMcpConfig('n8n', 'n8n-server.js', { ZENTRALE_N8N_SOCKET: n8nSocketPath(app.getPath('userData')) });
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
    n8nConfig = { url: normalizeBase(raw.url) || N8N_DEFAULT_URL, key };
  }

  function saveN8n(next) {
    if (next.key && !safeStorage.isEncryptionAvailable()) return false;
    const data = { url: next.url, key: next.key ? safeStorage.encryptString(next.key).toString('base64') : null };
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
    const c = new ClaudeChat({ bin: claude.bin, env: claude.env, cwd, resume: sessionId, title, extraArgs });
    chat = c;
    c.on('event', (ev) => send('chat-event', { ...ev, gen }));
    c.on('status', () => pushState());
    c.on('approvals', onApprovalsChanged);
    if (old) await old.dispose();
    // Inzwischen ersetzt oder gelöscht: nicht mehr starten.
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
      },
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
    win.on('closed', () => { win = null; });
  }

  ipcMain.handle('get-state', () => snapshot());

  ipcMain.handle('open-session', async (_e, args) => {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null;
    const session = sessionId && findSession(sessionId);
    if (!session) return { error: 'Dieses Gespräch wurde nicht gefunden.' };
    await claudeReady;
    if (!claude.bin) return { error: 'Claude Code wurde nicht gefunden.' };
    // Fortsetzen geht nur im Ordner, in dem das Gespräch entstanden ist.
    if (!isDir(session.cwd)) return { error: 'Der Projektordner dieses Gesprächs existiert nicht mehr.' };
    let history = [];
    try { history = readMessages(session.file); } catch {}
    if (chat && chat.sessionId === sessionId) return { chat: chatInfo(), history };
    const info = await openChat({ cwd: session.cwd, sessionId, title: session.title });
    return { chat: info, history };
  });

  ipcMain.handle('new-session', async (_e, args) => {
    const cwd = args && args.cwd;
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
    const next = settings.update(patch);
    nativeTheme.themeSource = next.theme;
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

  ipcMain.handle('library', () => library.library());

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

  ipcMain.handle('running-work', () => {
    const work = library.runningWork((id) => { const s = findSession(id); return s ? s.title : null; });
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

  // ---------- Musik ----------

  const musicAllowed = () => process.platform === 'darwin' && settings.get().connections.mac;
  ipcMain.handle('music-now', () => (musicAllowed() ? music.nowPlaying() : null));
  ipcMain.handle('music-control', (_e, args) => (musicAllowed() && args
    ? music.control(String(args.app || ''), String(args.action || '')) : { ok: false, error: 'Die Verbindung „Mein Mac“ ist aus.' }));

  // ---------- Automatisierungen (n8n) ----------

  ipcMain.handle('n8n-status', async () => {
    const health = await n8nClient().health();
    return { url: n8nConfig.url, running: health.ok, hasKey: !!n8nConfig.key };
  });
  // Prüft den Schlüssel sofort an n8n, bevor er gespeichert wird.
  ipcMain.handle('n8n-connect', async (_e, args) => {
    const url = normalizeBase(args && args.url);
    if (!url) return { ok: false, error: 'Das ist keine gültige Adresse (z. B. http://localhost:5678).' };
    if (url.startsWith('http:') && !isLoopback(url)) return { ok: false, error: 'Für ein n8n außerhalb deines Macs bitte eine https-Adresse – sonst ginge der Schlüssel unverschlüsselt durchs Netz.' };
    const key = args && typeof args.key === 'string' ? args.key.trim() : '';
    if (!key || key.length > 4000) return { ok: false, error: 'Bitte den API-Schlüssel aus n8n einfügen.' };
    const test = await new N8n({ baseUrl: url, apiKey: key }).listWorkflows();
    if (!test.ok) return test;
    if (!saveN8n({ url, key })) return { ok: false, error: 'Der Schlüssel konnte nicht sicher gespeichert werden (Schlüsselbund nicht verfügbar).' };
    return { ok: true, count: test.data.length };
  });
  ipcMain.handle('n8n-disconnect', () => saveN8n({ url: n8nConfig.url, key: null }));
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

  const webState = () => ({ ...webTabs.info(), presets: PRESETS });
  ipcMain.handle('web-state', () => webState());
  ipcMain.handle('web-add', (_e, args) => {
    const res = webTabs.store.add(args && args.name, args && args.url);
    if (res.ok) webTabs.show(res.portal.id);
    return res.ok ? { ok: true, id: res.portal.id } : res;
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
  ipcMain.handle('web-open-browser', (_e, id) => {
    const url = typeof id === 'string' && webTabs.currentUrl(id);
    if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
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

  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && EXTERNAL_LINKS.has(url)) shell.openExternal(url);
  });

  app.on('second-instance', () => {
    if (!win) createWindow();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    topicStore = new TopicStore(path.join(app.getPath('userData'), 'topics.json'));
    webTabs = new WebTabs(new PortalStore(path.join(app.getPath('userData'), 'portals.json')));
    webTabs.on('change', () => send('web-state', webState()));
    nativeTheme.themeSource = settings.get().theme;
    loadN8n();
    n8nProxy = startProxy(makeOps(n8nClient), n8nSocketPath(app.getPath('userData')));
    writeMacConfig();
    refreshProjects();
    createWindow();

    scheduler = new TaskScheduler(path.join(app.getPath('userData'), 'tasks.json'), (task) => {
      if (!claude.bin) return Promise.resolve({ ok: false, text: 'Claude Code wurde nicht gefunden.' });
      const cwd = isDir(task.cwd) ? task.cwd : os.homedir();
      return runTask({
        bin: claude.bin, env: claude.env, cwd, prompt: task.prompt, extraArgs,
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
    if (sessionWatcher) sessionWatcher.close();
    const jobs = [stopAllTasks()];
    if (webTabs) jobs.push(webTabs.saveLogins());
    if (n8nProxy) n8nProxy.close();
    if (chat) jobs.push(chat.dispose());
    Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 6000))]).then(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
