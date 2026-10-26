// Hauptprozess: öffnet das Fenster, startet Claude automatisch und hält alles synchron.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { resolveClaude, ClaudeChat, runOnce, stopAllTasks } = require('./claude');
const { listProjects, readMessages, watchSessions, shortTitle, DEFAULT_ROOT } = require('./sessions');
const { TaskScheduler } = require('./tasks');

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
  let sessionWatcher = null;
  let projectsCache = [];
  let quitting = false;
  let cleanedUp = false;
  // Anfragen aus der Oberfläche warten, bis die Suche nach Claude abgeschlossen ist.
  let markClaudeReady;
  const claudeReady = new Promise((r) => { markClaudeReady = r; });

  // Das Design ist hell; dunkle Systemfarben würden die Schrift unlesbar machen.
  nativeTheme.themeSource = 'light';

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function refreshProjects() {
    try { projectsCache = listProjects(); } catch { projectsCache = []; }
    return projectsCache;
  }

  function chatInfo() {
    if (!chat) return null;
    return { gen: chatGen, cwd: chat.cwd, name: path.basename(chat.cwd), sessionId: chat.sessionId, status: chat.status, title: chat.title };
  }

  function snapshot() {
    return {
      claude: { found: !!claude.bin, checking: claude.checking, version: claude.version },
      projects: projectsCache,
      chat: chatInfo(),
      tasks: scheduler ? scheduler.list() : [],
    };
  }

  function pushState() {
    send('state', snapshot());
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
    chat = new ClaudeChat({ bin: claude.bin, env: claude.env, cwd, resume: sessionId, title });
    chat.on('event', (ev) => send('chat-event', { ...ev, gen }));
    chat.on('status', () => pushState());
    if (old) await old.dispose();
    if (gen !== chatGen) return chatInfo();
    chat.start();
    pushState();
    return chatInfo();
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
    if (!session) return { error: 'Diese Sitzung wurde nicht gefunden.' };
    await claudeReady;
    if (!claude.bin) return { error: 'Claude Code wurde nicht gefunden.' };
    // Fortsetzen geht nur im Ordner, in dem die Sitzung entstanden ist.
    if (!isDir(session.cwd)) return { error: 'Der Projektordner dieser Sitzung existiert nicht mehr.' };
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
    if (!c.title) { c.title = shortTitle(t); pushState(); }
    const ok = await c.send(t);
    if (c !== chat) return { ok: false, error: 'Der Chat wurde gewechselt, bevor die Nachricht ankam. Bitte noch einmal senden.' };
    return ok ? { ok: true, gen } : { ok: false, error: 'Claude konnte nicht gestartet werden.' };
  });

  ipcMain.handle('stop-chat', async () => {
    if (chat) await chat.stop({ interrupt: true });
    pushState();
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

  app.on('second-instance', () => {
    if (!win) createWindow();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    refreshProjects();
    createWindow();

    scheduler = new TaskScheduler(path.join(app.getPath('userData'), 'tasks.json'), (task) => {
      if (!claude.bin) return Promise.resolve({ ok: false, text: 'Claude Code wurde nicht gefunden.' });
      const cwd = isDir(task.cwd) ? task.cwd : os.homedir();
      return runOnce({ bin: claude.bin, env: claude.env, cwd, prompt: task.prompt });
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
