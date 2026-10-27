// Hauptprozess: öffnet das Fenster, startet Claude automatisch und hält alles synchron.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, nativeImage } = require('electron');
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
const { READ_ONLY_TOOLS } = require('./mcp/mac-server');

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
  const iconCache = new Map();
  let sessionWatcher = null;
  let projectsCache = [];
  let quitting = false;
  let cleanedUp = false;
  let macConfigFile = null;
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
    if (c.mac && macConfigFile) {
      args.push(`--mcp-config=${macConfigFile}`);
      args.push(`--allowedTools=${READ_ONLY_TOOLS.map((t) => `mcp__mac__${t}`).join(',')}`);
    }
    if (c.chrome) args.push('--chrome');
    return args;
  }

  // Der Mac-Server läuft mit der Node-Laufzeit, die in Electron steckt.
  function writeMacConfig() {
    const server = path.join(__dirname, 'mcp', 'mac-server.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    macConfigFile = path.join(app.getPath('userData'), 'mcp-mac.json');
    const config = { mcpServers: { mac: { type: 'stdio', command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
    try {
      fs.mkdirSync(path.dirname(macConfigFile), { recursive: true });
      fs.writeFileSync(macConfigFile, JSON.stringify(config, null, 2));
    } catch {
      macConfigFile = null;
    }
  }

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
    return mac.today({ launch: !!(args && args.launch === true) });
  });

  // Fragt die Mac-Rechte für Kalender und Erinnerungen einmal gezielt ab und schickt eine Probe-Mitteilung.
  ipcMain.handle('mac-test', async () => {
    if (process.platform !== 'darwin') return { error: 'Das geht nur auf dem Mac.' };
    const [calendar, reminders] = await Promise.all([mac.calendarEvents(1), mac.reminders()]);
    let notify = { ok: false, error: 'Mitteilungen sind ausgeschaltet. Erlaube sie unter Systemeinstellungen → Mitteilungen → Zentrale.' };
    if (Notification.isSupported()) {
      new Notification({ title: 'Zentrale', body: 'Die Verbindung zum Mac funktioniert.' }).show();
      notify = { ok: true };
    }
    return { calendar, reminders, notify };
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
    nativeTheme.themeSource = settings.get().theme;
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
    if (chat) jobs.push(chat.dispose());
    Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 6000))]).then(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
