// Hauptprozess: öffnet das Fenster, startet Claude automatisch und hält alles synchron.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { resolveClaude, ClaudeChat, runOnce } = require('./claude');
const { listProjects, readMessages, watchSessions, DEFAULT_ROOT } = require('./sessions');
const { TaskScheduler } = require('./tasks');

let win = null;
let claude = { bin: null, env: process.env, version: null };
let chat = null;
let scheduler = null;
let sessionWatcher = null;
let projectsCache = [];
let quitting = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function refreshProjects() {
  try { projectsCache = listProjects(); } catch { projectsCache = []; }
  return projectsCache;
}

function chatInfo() {
  if (!chat) return null;
  return { cwd: chat.cwd, name: path.basename(chat.cwd), sessionId: chat.sessionId, status: chat.status, title: chat.title };
}

function snapshot() {
  return {
    claude: { found: !!claude.bin, version: claude.version },
    projects: projectsCache,
    chat: chatInfo(),
    tasks: scheduler ? scheduler.list() : [],
    home: os.homedir(),
  };
}

function pushState() {
  send('state', snapshot());
}

// Eine Sitzung gilt als bekannt, sobald sie in der Liste auftaucht.
function knownSession(id) {
  return projectsCache.some((p) => p.sessions.some((s) => s.id === id));
}

function sessionFile(id) {
  for (const p of projectsCache) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return s.file;
  }
  return null;
}

function openChat({ cwd, sessionId = null, title = null }) {
  if (!claude.bin) return null;
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  if (chat) { chat.removeAllListeners(); chat.stop(); }
  chat = new ClaudeChat({ bin: claude.bin, env: claude.env, cwd, resume: sessionId, title });
  chat.on('event', (ev) => send('chat-event', ev));
  chat.on('status', () => pushState());
  chat.start();
  pushState();
  return chatInfo();
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
}

ipcMain.handle('get-state', () => snapshot());

ipcMain.handle('open-session', (_e, { sessionId, cwd, title }) => {
  if (sessionId && !knownSession(sessionId)) return { error: 'Sitzung nicht gefunden' };
  const info = openChat({ cwd, sessionId, title });
  const file = sessionId ? sessionFile(sessionId) : null;
  let history = [];
  try { if (file) history = readMessages(file); } catch {}
  return { chat: info, history };
});

ipcMain.handle('new-session', (_e, { cwd }) => ({ chat: openChat({ cwd, title: null }), history: [] }));

ipcMain.handle('send-message', (_e, text) => {
  const t = String(text || '').trim();
  if (!t) return { ok: false };
  if (!chat) openChat({ cwd: projectsCache[0] ? projectsCache[0].path : os.homedir() });
  if (!chat) return { ok: false, error: 'Claude Code wurde nicht gefunden' };
  if (!chat.title) chat.title = t.split('\n')[0].slice(0, 80);
  chat.send(t);
  return { ok: true };
});

ipcMain.handle('stop-chat', () => { if (chat) chat.stop(); pushState(); });

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Projektordner wählen' });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('tasks-save', (_e, task) => { scheduler.upsert(task); });
ipcMain.handle('tasks-toggle', (_e, id) => { scheduler.toggle(id); });
ipcMain.handle('tasks-remove', (_e, id) => { scheduler.remove(id); });
ipcMain.handle('tasks-run', (_e, id) => { scheduler.run(id); });

app.whenReady().then(() => {
  claude = resolveClaude();
  refreshProjects();

  scheduler = new TaskScheduler(path.join(app.getPath('userData'), 'tasks.json'), (task) => {
    if (!claude.bin) return Promise.resolve({ ok: false, text: 'Claude Code wurde nicht gefunden' });
    const cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : os.homedir();
    return runOnce({ bin: claude.bin, env: claude.env, cwd, prompt: task.prompt });
  });
  scheduler.on('change', pushState);
  scheduler.start();

  sessionWatcher = watchSessions(DEFAULT_ROOT);
  sessionWatcher.on('change', () => { refreshProjects(); pushState(); });

  createWindow();

  // Claude startet sofort mit, im zuletzt benutzten Projekt.
  if (claude.bin) openChat({ cwd: projectsCache[0] ? projectsCache[0].path : os.homedir() });
});

app.on('activate', () => {
  if (win) win.show(); else createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  if (chat) chat.stop();
  if (scheduler) scheduler.stop();
  if (sessionWatcher) sessionWatcher.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
