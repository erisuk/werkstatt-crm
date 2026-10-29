// Zeigt die Webseiten-Tabs als eingebettete Browser-Ansichten im Fenster der Zentrale.
// Alle Tabs teilen sich einen dauerhaft gespeicherten Browser-Speicher: einmal anmelden, angemeldet bleiben.
// Die Seiten laufen abgeschottet (Sandbox, kein Zugriff auf Node, den Mac oder Claude).
const { EventEmitter } = require('events');
const { WebContentsView, session, shell } = require('electron');
const { chromeUserAgent, isGoogleSignIn, isGoogleApp, unreadFromTitle, partitionFor } = require('./portals');

const PARTITION = 'persist:portale';
// Was Webseiten ohne Rückfrage dürfen. Kamera, Mikrofon, Standort usw. bleiben gesperrt.
const ALLOWED_PERMISSIONS = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write']);

const SESSION_COOKIE_DAYS = 30;
const SAVE_EVERY_MS = 5 * 60 * 1000;

const webPrefs = (partition = PARTITION) => ({ partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true });
const WEB_PREFS = webPrefs();

// Jede Partition (= jedes Konto) wird einmal eingerichtet: Browser-Kennung, Rechte.
const readyPartitions = new Set();
let sessionReady = false;

function portalSession(partition = PARTITION) {
  const ses = session.fromPartition(partition);
  if (readyPartitions.has(partition)) return ses;
  readyPartitions.add(partition);
  sessionReady = true;
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  return ses;
}

const isWeb = (url) => /^https?:\/\//i.test(String(url || ''));

class WebTabs extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.win = null;
    this.views = new Map(); // id → { view, title, unread, loading, error }
    this.bounds = null;
    this.visible = false;
    // Auch bei einem Absturz soll höchstens ein paar Minuten Anmeldung verloren gehen.
    this.saveTimer = setInterval(() => this.saveLogins(), SAVE_EVERY_MS);
    this.saveTimer.unref();
  }

  attach(win) {
    this.win = win;
    for (const { view } of this.views.values()) win.contentView.addChildView(view);
    win.on('closed', () => { if (this.win === win) this.win = null; });
    this.layout();
  }

  // Erst beim ersten Anzeigen anlegen; danach bleibt der Tab im Hintergrund geöffnet.
  ensure(id) {
    if (this.views.has(id)) return this.views.get(id);
    const portal = this.store.get().portals.find((p) => p.id === id);
    if (!portal || !this.win) return null;
    if (isGoogleApp(portal.url)) return null; // öffnet im normalen Browser, siehe isGoogleApp
    const partition = partitionFor(portal.profile);
    portalSession(partition);
    const prefs = webPrefs(partition);
    const view = new WebContentsView({ webPreferences: prefs });
    const entry = { view, title: '', unread: 0, loading: true, error: null };
    this.views.set(id, entry);
    const wc = view.webContents;
    const changed = () => this.emit('change');
    // Cmd+K (Schnellsprung) auch dann, wenn gerade die Webseite den Fokus hat.
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && (input.meta || input.control) && !input.shift && !input.alt && String(input.key).toLowerCase() === 'k') {
        e.preventDefault();
        this.emit('shortcut', 'switcher');
      }
    });

    wc.on('page-title-updated', (_e, title) => { entry.title = title; entry.unread = unreadFromTitle(title); changed(); });
    wc.on('did-start-loading', () => { entry.loading = true; entry.error = null; changed(); });
    wc.on('did-stop-loading', () => { entry.loading = false; changed(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3 = abgebrochen (z. B. Weiterleitung)
      entry.error = code === -106 ? 'Keine Internetverbindung.' : `Die Seite ließ sich nicht laden (${desc}).`;
      changed();
    });
    const remember = (_e, url) => {
      this.store.remember(id, url);
      // Google-Anmeldung: einmal pro Tab und Start an den normalen Browser übergeben (sonst bei jedem Neuladen).
      entry.googleSignIn = isGoogleSignIn(url);
      if (entry.googleSignIn && !entry.handedOff) { entry.handedOff = true; this.emit('google-signin', { id, url }); }
      changed();
    };
    wc.on('did-navigate', remember);
    wc.on('did-navigate-in-page', remember);
    // Nur Webseiten innerhalb des Tabs; alles andere (file:, Programme-Links) wird blockiert.
    wc.on('will-navigate', (e, url) => { if (!isWeb(url)) e.preventDefault(); });
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (/^mailto:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
      if (!isWeb(url)) return { action: 'deny' };
      // Anmelde-Fenster (window.open mit Größe) bleiben in der Zentrale, damit das Login hier gespeichert wird.
      if (disposition === 'new-window' || features) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: prefs } };
      }
      // Normale Links „in neuem Tab“ öffnen im Standardbrowser.
      shell.openExternal(url);
      return { action: 'deny' };
    });
    // Anmelde-Fenster dürfen selbst nichts weiter öffnen und nur Webseiten laden.
    wc.on('did-create-window', (child) => {
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', (e, url) => { if (!isWeb(url)) e.preventDefault(); });
    });

    view.setVisible(false);
    view.setBorderRadius && view.setBorderRadius(12);
    this.win.contentView.addChildView(view);
    wc.loadURL(portal.lastUrl || portal.url).catch(() => {});
    return entry;
  }

  // Die Oberfläche meldet, wo der Platz für die Seite ist (in Fensterpunkten).
  setBounds(rect) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    this.bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
    this.layout();
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (this.visible && this.store.get().active) this.ensure(this.store.get().active);
    this.layout();
  }

  show(id) {
    if (!this.store.setActive(id)) return false;
    this.ensure(id);
    this.layout();
    this.emit('change');
    return true;
  }

  layout() {
    const active = this.store.get().active;
    for (const [id, { view }] of this.views) {
      const on = this.visible && id === active && !!this.bounds && this.bounds.width > 0;
      if (on) view.setBounds(this.bounds);
      view.setVisible(on);
    }
  }

  navigate(id, action) {
    const entry = this.views.get(id);
    if (!entry) return;
    const wc = entry.view.webContents;
    const history = wc.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'home') {
      const portal = this.store.get().portals.find((p) => p.id === id);
      if (portal) wc.loadURL(portal.url).catch(() => {});
    }
  }

  // Lädt eine Adresse derselben Website im Tab (z. B. einen bestimmten n8n-Workflow).
  openUrl(id, url) {
    const portal = this.store.get().portals.find((p) => p.id === id);
    const entry = this.ensure(id);
    if (!portal || !entry || !/^https?:\/\//.test(url) || new URL(url).origin !== new URL(portal.url).origin) return false;
    entry.view.webContents.loadURL(url).catch(() => {});
    return true;
  }

  currentUrl(id) {
    const entry = this.views.get(id);
    if (entry) return entry.view.webContents.getURL();
    const portal = this.store.get().portals.find((p) => p.id === id);
    return portal ? portal.lastUrl || portal.url : null;
  }

  close(id) {
    const entry = this.views.get(id);
    if (entry) {
      if (this.win) this.win.contentView.removeChildView(entry.view);
      entry.view.webContents.close();
      this.views.delete(id);
    }
    this.store.remove(id);
    this.layout();
    this.emit('change');
  }

  // Viele Seiten setzen ihr Login nur „für diese Sitzung“ – das ginge beim Beenden verloren.
  // Wie Chrome bei „Dort weitermachen, wo ich aufgehört habe“ halten wir solche Cookies 30 Tage
  // und schreiben alles sofort auf die Platte.
  async saveLogins() {
    if (!sessionReady) return;
    for (const pr of this.store.profiles()) await this.saveLoginsFor(partitionFor(pr));
  }

  async saveLoginsFor(partition) {
    const ses = portalSession(partition);
    const until = Math.floor(Date.now() / 1000) + SESSION_COOKIE_DAYS * 86400;
    let cookies = [];
    try { cookies = await ses.cookies.get({}); } catch { return; }
    for (const c of cookies.filter((x) => x.session)) {
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const cookie = { url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: until };
      if (!c.hostOnly) cookie.domain = c.domain;
      try { await ses.cookies.set(cookie); } catch {}
    }
    try { await ses.cookies.flushStore(); } catch {}
  }

  // Meldet überall ab: löscht Cookies und gespeicherte Seitendaten aller Tabs.
  async clearLogins() {
    for (const pr of this.store.profiles()) {
      const ses = portalSession(partitionFor(pr));
      await ses.clearStorageData();
      await ses.clearCache();
    }
    for (const { view } of this.views.values()) view.webContents.reload();
  }

  info() {
    const { portals, active } = this.store.get();
    return {
      active,
      portals: portals.map((p) => {
        const e = this.views.get(p.id);
        const wc = e && e.view.webContents;
        return { id: p.id, name: p.name, url: p.url, profile: p.profile, open: !!e, googleApp: isGoogleApp(p.url), title: e ? e.title : '', unread: e ? e.unread : 0,
          loading: e ? e.loading : false, error: e ? e.error : null, googleSignIn: !!(e && e.googleSignIn), current: wc ? wc.getURL() : (p.lastUrl || p.url),
          canGoBack: wc ? wc.navigationHistory.canGoBack() : false, canGoForward: wc ? wc.navigationHistory.canGoForward() : false };
      }),
    };
  }
}

module.exports = { WebTabs, PARTITION, portalSession };
