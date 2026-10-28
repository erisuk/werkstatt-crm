// Claude bedient die Web-Tabs der Zentrale: Seite lesen, Screenshot, scrollen (ohne Rückfrage),
// klicken, tippen, Tasten, Adresse öffnen (nur mit Freigabe – die prüft Claude Code vor jedem Aufruf).
// Passwort-, Karten- und Bankfelder werden hier technisch blockiert, egal was freigegeben wurde.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORLD = 1729; // eigene, isolierte Skriptwelt: Seiten-JavaScript sieht unsere Hilfen nicht
const MAX_TEXT = 15000;
const MAX_ELEMENTS = 200;
const KEYS = { enter: 'Enter', tab: 'Tab', escape: 'Escape', down: 'Down', up: 'Up', backspace: 'Backspace' };
// Kosten-, Veröffentlichungs- oder Löschknöpfe bekommen in der Freigabe eine Warnung.
const RISKY_LABEL = /(bezahl|kauf|bestell|zahlungspflichtig|veröffentlich|publish|post(en)?\b|live schalten|budget|abonn|subscribe|pay|checkout|confirm|bestätig|senden|send|löschen|delete|entfern|kampagne starten|anzeige schalten|boost|bewerben)/i;

// Läuft in der Seite (isolierte Welt). Markiert Bedienelemente mit data-zref und liefert eine Übersicht.
const READ_SCRIPT = `(() => {
  const SENSITIVE = /(pass|pwd|kennwort|cc-|card|karte|cvc|cvv|iban|bic|kontonummer|security.?code|sicherheitscode|pin\\b|tan\\b|otp|one-time)/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value && el.type === 'submit' && el.value
    || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  document.querySelectorAll('[data-zref]').forEach((el) => el.removeAttribute('data-zref'));
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=option],[contenteditable=""],[contenteditable=true]';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= ${MAX_ELEMENTS}) break;
    // Upload-Felder sind oft unsichtbar (eigener Knopf darüber) – die brauchen wir trotzdem.
    const fileInput = el.tagName === 'INPUT' && el.type === 'file';
    if (!fileInput && !visible(el)) continue;
    n += 1;
    el.setAttribute('data-zref', String(n));
    const kind = el.tagName.toLowerCase() === 'input' ? 'input:' + (el.type || 'text') : (el.getAttribute('role') || el.tagName.toLowerCase());
    const hint = [el.type, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
    out.push({ ref: n, kind, label: label(el), sensitive: el.type === 'password' || SENSITIVE.test(hint),
      value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password' ? String(el.value || '').slice(0, 80) : undefined });
  }
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT}), elements: out,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight } };
})()`;

// Sucht das Element, holt es in den sichtbaren Bereich und prüft frisch, ob es ein heikles Feld ist.
const elementScript = (ref) => `(() => {
  const el = document.querySelector('[data-zref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const hint = [el.type, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
  const sensitive = el.type === 'password' || /(pass|pwd|kennwort|cc-|card|karte|cvc|cvv|iban|bic|kontonummer|security.?code|sicherheitscode|pin\\b|tan\\b|otp|one-time)/i.test(hint);
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sensitive };
})()`;

// Direkt auf der Seite klicken/tippen – funktioniert auch, wenn der Tab gerade nicht angezeigt wird.
// Der Wert wird über den eingebauten Setter gesetzt und mit input/change gemeldet, damit auch
// React-Seiten (z. B. Meta) die Eingabe übernehmen.
const domClickScript = (ref) => `(() => {
  const el = document.querySelector('[data-zref="${ref}"]');
  if (!el) return false;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  el.click();
  return true;
})()`;

const domTypeScript = (ref, text, submit) => `(() => {
  const el = document.querySelector('[data-zref="${ref}"]');
  if (!el) return false;
  el.focus();
  const value = ${JSON.stringify(String(text || '').slice(0, 5000))};
  if (el.isContentEditable) {
    document.getSelection().selectAllChildren(el);
    document.execCommand('insertText', false, value);
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (${submit ? 'true' : 'false'}) {
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
  }
  return true;
})()`;

const domKeyScript = (key) => `(() => {
  const el = document.activeElement || document.body;
  for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  return true;
})()`;

class BrowserControl extends EventEmitter {
  constructor(webTabs) {
    super();
    this.tabs = webTabs;
    this.lastRead = new Map(); // Tab-ID → Elemente der letzten Übersicht (für die Freigabe-Texte)
  }

  // Ohne Angabe: der gerade angezeigte Tab.
  resolve(id) {
    const { portals, active } = this.tabs.store.get();
    const tabId = typeof id === 'string' && id ? id : active;
    if (!portals.some((p) => p.id === tabId)) return null;
    const entry = this.tabs.ensure(tabId);
    return entry ? { id: tabId, wc: entry.view.webContents } : null;
  }

  // Der gesteuerte Tab wird angezeigt, damit du mitsiehst.
  focus(id, action) {
    this.tabs.show(id);
    this.emit('activity', { id, action, at: Date.now() });
  }

  // Echte Maus/Tastatur nur, wenn der Tab wirklich zu sehen ist – sonst kämen die Ereignisse nicht an.
  shown(id) {
    const entry = this.tabs.views.get(id);
    return !!entry && this.tabs.visible && this.tabs.store.get().active === id && !!this.tabs.bounds && this.tabs.bounds.width > 0;
  }

  listTabs() {
    const { portals, active } = this.tabs.info();
    return { ok: true, data: portals.map((p) => ({ id: p.id, name: p.name, url: p.current, title: p.title, active: p.id === active })) };
  }

  async read(id) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht. Liste die Tabs mit zentrale_web_tabs.' };
    await waitForLoad(t.wc);
    const data = await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: READ_SCRIPT }]).catch((e) => ({ error: e.message }));
    if (!data || data.error) return { ok: false, error: `Die Seite ließ sich nicht lesen${data && data.error ? `: ${data.error}` : ''}.` };
    this.lastRead.set(t.id, data.elements);
    this.focus(t.id, 'liest');
    return { ok: true, data: { tab: t.id, ...data } };
  }

  async screenshot(id) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht.' };
    this.focus(t.id, 'schaut');
    await waitForLoad(t.wc);
    const img = await t.wc.capturePage();
    const small = img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img;
    return { ok: true, data: { tab: t.id, url: t.wc.getURL() }, image: small.toPNG().toString('base64') };
  }

  async scroll(id, direction) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht.' };
    const dy = direction === 'up' ? -0.8 : 0.8;
    await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `scrollBy(0, innerHeight * ${dy})` }]).catch(() => {});
    this.focus(t.id, 'scrollt');
    return { ok: true, data: 'gescrollt – lies die Seite neu, um die neuen Elemente zu sehen' };
  }

  element(id, ref) {
    return (this.lastRead.get(id) || []).find((e) => e.ref === Number(ref)) || null;
  }

  async click(id, ref) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht.' };
    const pos = await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: elementScript(Number(ref)) }]).catch(() => null);
    if (!pos) return { ok: false, error: 'Dieses Element gibt es nicht (mehr). Lies die Seite neu.' };
    this.focus(t.id, 'klickt');
    if (this.shown(t.id)) {
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) t.wc.sendInputEvent({ type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    } else {
      await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: domClickScript(Number(ref)) }]).catch(() => false);
    }
    await sleep(600);
    return { ok: true, data: `geklickt: ${describeElement(this.element(t.id, ref))} – lies die Seite neu, um das Ergebnis zu sehen` };
  }

  async type(id, ref, text, submit) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht.' };
    const el = this.element(t.id, ref);
    // Fest eingebaut: in solche Felder tippt Claude nie – auch nicht nach einer Freigabe.
    if (!el) return { ok: false, error: 'Dieses Feld kenne ich nicht. Lies die Seite zuerst mit zentrale_web_read.' };
    if (el.sensitive) return { ok: false, error: 'Das ist ein Passwort-, Karten- oder Bankfeld. Das füllt die Zentrale nie aus – das macht der Nutzer selbst.' };
    const pos = await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: elementScript(Number(ref)) }]).catch(() => null);
    if (!pos) return { ok: false, error: 'Dieses Feld gibt es nicht (mehr). Lies die Seite neu.' };
    if (pos.sensitive) return { ok: false, error: 'Das ist ein Passwort-, Karten- oder Bankfeld. Das füllt die Zentrale nie aus – das macht der Nutzer selbst.' };
    this.focus(t.id, 'tippt');
    if (this.shown(t.id)) {
      for (const type of ['mouseDown', 'mouseUp']) t.wc.sendInputEvent({ type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(150);
      // Vorhandenen Inhalt ersetzen statt anhängen
      await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => { const el = document.querySelector('[data-zref="${Number(ref)}"]'); if (el && el.select) el.select(); })()` }]).catch(() => {});
      await t.wc.insertText(String(text || '').slice(0, 5000));
      if (submit) pressKey(t.wc, 'Enter');
    } else {
      await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: domTypeScript(Number(ref), text, submit) }]).catch(() => false);
    }
    await sleep(300);
    return { ok: true, data: `eingegeben in ${describeElement(el)}${submit ? ' und mit Enter bestätigt' : ''}` };
  }

  async key(id, key) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht.' };
    const code = KEYS[String(key || '').toLowerCase()];
    if (!code) return { ok: false, error: `Erlaubt sind: ${Object.keys(KEYS).join(', ')}.` };
    this.focus(t.id, 'drückt eine Taste');
    if (this.shown(t.id)) pressKey(t.wc, code);
    else await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: domKeyScript(code === 'Down' ? 'ArrowDown' : code === 'Up' ? 'ArrowUp' : code) }]).catch(() => false);
    await sleep(300);
    return { ok: true, data: `Taste ${key} gedrückt` };
  }

  // Legt Dateien in ein Upload-Feld (z. B. Video bei YouTube Studio oder Instagram) – über die Entwicklerschnittstelle
  // des Tabs, so wie der Dateiauswahl-Dialog es tun würde.
  async upload(id, ref, list) {
    const t = this.resolve(id);
    if (!t) return { ok: false, error: 'Diesen Tab gibt es nicht.' };
    const el = this.element(t.id, ref);
    if (!el || el.kind !== 'input:file') return { ok: false, error: 'Das ist kein Upload-Feld. Lies die Seite mit zentrale_web_read und nimm ein Element vom Typ input:file.' };
    const check = checkUploadFiles(list);
    if (!check.ok) return check;
    this.focus(t.id, 'lädt hoch');
    const dbg = t.wc.debugger;
    const attachedHere = !dbg.isAttached();
    try {
      if (attachedHere) dbg.attach('1.3');
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-zref="${Number(ref)}"]` });
      if (!nodeId) return { ok: false, error: 'Das Upload-Feld gibt es nicht mehr. Lies die Seite neu.' };
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: check.files });
    } catch (e) {
      return { ok: false, error: `Hochladen ging nicht: ${e.message}` };
    } finally {
      if (attachedHere) try { dbg.detach(); } catch {}
    }
    await sleep(800);
    return { ok: true, data: `${check.files.length} Datei(en) ins Upload-Feld gelegt – lies die Seite neu, um den Fortschritt zu sehen.` };
  }

  // Öffnet eine Adresse: im Tab derselben Website, sonst in einem eigenen Tab „Claude“.
  async open(url) {
    let u;
    try { u = new URL(String(url || '')); } catch { return { ok: false, error: 'Das ist keine gültige Webadresse.' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Nur Webadressen (https) sind erlaubt.' };
    const { portals } = this.tabs.store.get();
    let portal = portals.find((p) => new URL(p.url).origin === u.origin);
    if (!portal) {
      const res = this.tabs.store.add(u.hostname.replace(/^www\./, ''), u.origin);
      if (!res.ok) return res;
      portal = res.portal;
    }
    this.focus(portal.id, 'öffnet');
    this.tabs.openUrl(portal.id, u.href);
    const entry = this.tabs.ensure(portal.id);
    if (entry) await waitForLoad(entry.view.webContents);
    return { ok: true, data: { tab: portal.id, url: u.href } };
  }

  // Für die Freigabe: welcher Knopf, welches Feld, auf welcher Seite – und ob es heikel ist.
  approvalInfo(toolName, input) {
    const i = input || {};
    if (!/^mcp__web__zentrale_web_(click|type|key|upload)$/.test(toolName)) return null;
    const t = this.resolve(i.tab);
    const page = t ? t.wc.getURL() : '(unbekannter Tab)';
    const el = i.ref != null && t ? this.element(t.id, i.ref) : null;
    const lines = [`Seite: ${page}`];
    if (i.ref != null) lines.push(`Element: ${describeElement(el)}`);
    if (el && el.sensitive) lines.push('⛔ Passwort-, Karten- oder Bankfeld – wird von der Zentrale blockiert.');
    if (el && RISKY_LABEL.test(el.label)) lines.push('⚠ Achtung: Dieser Knopf kann Geld kosten, etwas veröffentlichen, senden oder löschen.');
    return lines.join('\n');
  }
}

const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

// Nur echte Dateien aus dem Benutzerordner – nie aus versteckten Ordnern (.ssh, .claude …) oder Library.
function checkUploadFiles(list) {
  const home = os.homedir();
  if (!Array.isArray(list) || !list.length) return { ok: false, error: 'Keine Dateien angegeben.' };
  if (list.length > MAX_UPLOAD_FILES) return { ok: false, error: `Höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal.` };
  const out = [];
  for (const raw of list) {
    const given = String(raw || '').replace(/^~(?=\/)/, home);
    let real;
    try { real = fs.realpathSync.native(path.resolve(given)); } catch { return { ok: false, error: `Datei nicht gefunden: ${raw}` }; }
    const rel = path.relative(home, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: `Nur Dateien aus deinem Benutzerordner: ${raw}` };
    if (rel.split(path.sep).some((part) => part.startsWith('.')) || rel.split(path.sep)[0] === 'Library') return { ok: false, error: `Aus diesem Ordner lädt die Zentrale nichts hoch: ${raw}` };
    const st = fs.statSync(real);
    if (!st.isFile()) return { ok: false, error: `Das ist keine Datei: ${raw}` };
    if (st.size > MAX_UPLOAD_BYTES) return { ok: false, error: `Zu groß: ${raw}` };
    out.push(real);
  }
  return { ok: true, files: out };
}

function describeElement(el) {
  if (!el) return 'unbekanntes Element (Seite neu lesen)';
  return `${el.label ? `„${el.label}“` : '(ohne Beschriftung)'} [${el.kind}]`;
}

function pressKey(wc, keyCode) {
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}

function waitForLoad(wc, ms = 15000) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); wc.removeListener('did-stop-loading', done); resolve(); };
    const timer = setTimeout(done, ms);
    wc.once('did-stop-loading', done);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBrowserOps(control) {
  return {
    listTabs: () => control.listTabs(),
    read: (a) => control.read(a && a.tab),
    screenshot: (a) => control.screenshot(a && a.tab),
    scroll: (a) => control.scroll(a && a.tab, a && a.direction),
    click: (a) => control.click(a && a.tab, a && a.ref),
    type: (a) => control.type(a && a.tab, a && a.ref, a && a.text, !!(a && a.submit)),
    key: (a) => control.key(a && a.tab, a && a.key),
    upload: (a) => control.upload(a && a.tab, a && a.ref, a && a.files),
    open: (a) => control.open(a && a.url),
  };
}

module.exports = { BrowserControl, makeBrowserOps, RISKY_LABEL, describeElement, READ_SCRIPT, checkUploadFiles };
