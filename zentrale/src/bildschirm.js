// Bildschirmsteuerung für Mac-Apps (wie „Computer use“ in der Claude-App): Bildschirmfoto, Klicken, Tippen,
// Tasten, Scrollen. Läuft im Hauptprozess der Zentrale; Claude erreicht sie über den MCP-Server „bildschirm“.
// Schutzregeln, bevor irgendein Klick oder Tastendruck rausgeht:
//  1. Nur Apps, die laufen – und nie gesperrte (Zentrale, Claude, Terminal, Einstellungen, Passwörter, Trading, Browser).
//  2. Jede App braucht einmal Eris' Freigabe (Rückfrage der Zentrale), gültig bis zum Neustart der Zentrale.
//  3. Die App wird nach vorn geholt und es wird geprüft, dass sie wirklich vorne ist – sonst passiert nichts.
//     So landen Tastendrücke nie in einem anderen Fenster (am 15.11. landeten sie im Chat der Zentrale).
//  4. In Passwortfelder wird nie getippt.
const { execFile } = require('child_process');

// Gesperrt: Bundle-ID (genau oder Anfang) → Grund. Browser: dafür gibt es Web-Tabs und die Chrome-Erweiterung.
const GESPERRT = [
  ['de.werkstatt.zentrale', 'Die Zentrale selbst wird nie ferngesteuert.'],
  ['com.github.Electron', 'Die Zentrale selbst wird nie ferngesteuert.'],
  ['com.anthropic.', 'Claude selbst wird nie ferngesteuert.'],
  ['com.apple.Terminal', 'Terminals werden nicht ferngesteuert – Befehle laufen über Bash.'],
  ['com.googlecode.iterm2', 'Terminals werden nicht ferngesteuert – Befehle laufen über Bash.'],
  ['dev.warp.', 'Terminals werden nicht ferngesteuert – Befehle laufen über Bash.'],
  ['com.apple.systempreferences', 'Systemeinstellungen ändert nur Eris selbst.'],
  ['com.apple.SecurityAgent', 'Sicherheitsabfragen beantwortet nur Eris selbst.'],
  ['com.apple.keychainaccess', 'Schlüsselbund und Passwörter fasst nur Eris an.'],
  ['com.apple.Passwords', 'Schlüsselbund und Passwörter fasst nur Eris an.'],
  ['com.1password.', 'Passwort-Manager fasst nur Eris an.'],
  ['com.agilebits.', 'Passwort-Manager fasst nur Eris an.'],
  ['net.metaquotes.', 'Trading-Programme werden nie ferngesteuert.'],
  ['com.google.Chrome', 'Browser: Webseiten bitte mit der Chrome-Erweiterung oder den Web-Tabs bedienen (genauer und schneller).'],
  ['com.apple.Safari', 'Browser: Webseiten bitte mit der Chrome-Erweiterung oder den Web-Tabs bedienen.'],
  ['org.mozilla.firefox', 'Browser: Webseiten bitte mit der Chrome-Erweiterung oder den Web-Tabs bedienen.'],
  ['com.microsoft.edgemac', 'Browser: Webseiten bitte mit der Chrome-Erweiterung oder den Web-Tabs bedienen.'],
  ['company.thebrowser.', 'Browser: Webseiten bitte mit der Chrome-Erweiterung oder den Web-Tabs bedienen.'],
];

// macOS-Tastencodes (unabhängig vom Tastaturlayout).
const TASTEN = { enter: 36, return: 36, tab: 48, leertaste: 49, space: 49, escape: 53, esc: 53, backspace: 51, loeschen: 117, delete: 117,
  links: 123, rechts: 124, runter: 125, hoch: 126, left: 123, right: 124, down: 125, up: 126, pos1: 115, ende: 119, bildhoch: 116, bildrunter: 121 };
const MIT = { cmd: 'command down', command: 'command down', shift: 'shift down', alt: 'option down', option: 'option down', ctrl: 'control down', control: 'control down' };
const MAX_TEXT = 2000;

function gesperrt(bundleId) {
  const hit = GESPERRT.find(([pre]) => bundleId === pre || (pre.endsWith('.') && String(bundleId).startsWith(pre)));
  return hit ? hit[1] : null;
}

// JXA-Skript mit Argumenten ausführen (Argumente als argv – nie in den Skripttext eingesetzt).
function jxa(script, args = [], timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args.map(String)], { timeout }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim().slice(0, 300)));
      else resolve(String(out).trim());
    });
  });
}

const S = {
  apps: `function run(){const se=Application("System Events");const ps=se.processes.whose({backgroundOnly:false});
    const n=ps.name(),id=ps.bundleIdentifier(),f=ps.frontmost();return JSON.stringify(n.map((x,i)=>({name:x,id:id[i]||"",vorne:f[i]})));}`,
  vorne: `function run(){const p=Application("System Events").processes.whose({frontmost:true})[0];return JSON.stringify({name:p.name(),id:p.bundleIdentifier()||""});}`,
  aktivieren: 'function run(a){Application(a[0]).activate();return "ok";}',
  klick: `ObjC.import("CoreGraphics");function run(a){const x=+a[0],y=+a[1],rechts=a[2]==="rechts",n=+a[3]||1;const p=$.CGPointMake(x,y);
    const dn=rechts?$.kCGEventRightMouseDown:$.kCGEventLeftMouseDown,up=rechts?$.kCGEventRightMouseUp:$.kCGEventLeftMouseUp,b=rechts?$.kCGMouseButtonRight:$.kCGMouseButtonLeft;
    $.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),$.kCGEventMouseMoved,p,b));delay(0.05);
    for(let i=1;i<=n;i++){const d=$.CGEventCreateMouseEvent($(),dn,p,b),u=$.CGEventCreateMouseEvent($(),up,p,b);
      $.CGEventSetIntegerValueField(d,$.kCGMouseEventClickState,i);$.CGEventSetIntegerValueField(u,$.kCGMouseEventClickState,i);
      $.CGEventPost($.kCGHIDEventTap,d);delay(0.03);$.CGEventPost($.kCGHIDEventTap,u);delay(0.06);}return "ok";}`,
  scrollen: `ObjC.import("CoreGraphics");function run(a){const p=$.CGPointMake(+a[0],+a[1]);
    $.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),$.kCGEventMouseMoved,p,$.kCGMouseButtonLeft));delay(0.05);
    const n=Math.max(1,Math.min(20,+a[3]||5)),dy=a[2]==="hoch"?1:-1;
    for(let i=0;i<n;i++){$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateScrollWheelEvent($(),$.kCGScrollEventUnitLine,1,dy*3));delay(0.02);}return "ok";}`,
  tippen: 'function run(a){Application("System Events").keystroke(a[0]);return "ok";}',
  taste: 'function run(a){const m=a.slice(1).filter(Boolean);Application("System Events").keyCode(+a[0],m.length?{using:m}:{});return "ok";}',
  passwortfeld: `function run(){try{const p=Application("System Events").processes.whose({frontmost:true})[0];
    const f=p.attributes.byName("AXFocusedUIElement").value();return String(f.subrole());}catch(e){return "";}}`,
  bildschirm: 'ObjC.import("AppKit");function run(){const f=$.NSScreen.mainScreen.frame.size;return JSON.stringify({breite:f.width,hoehe:f.height});}',
};

const zahl = (v, max) => Number.isFinite(+v) && +v >= 0 && +v <= max ? Math.round(+v) : null;

// fragen(app): Rückfrage an Eris → true/false. foto(): { png (Buffer), breite, hoehe } in Bildschirmpunkten.
class Bildschirm {
  constructor({ fragen, foto, run = jxa, warte = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.fragen = fragen;
    this.fotoMachen = foto;
    this.run = run;
    this.warte = warte;
    this.erlaubt = new Set(); // Bundle-IDs, die Eris freigegeben hat (bis zum Neustart)
  }

  async apps() {
    const list = JSON.parse(await this.run(S.apps));
    return { ok: true, data: list.map((a) => ({ ...a, gesperrt: gesperrt(a.id) || undefined, freigegeben: this.erlaubt.has(a.id) || undefined })) };
  }

  async foto() {
    const f = await this.fotoMachen();
    if (!f) return { ok: false, error: 'Das Bildschirmfoto ging nicht – fehlt der Zentrale die Bildschirmaufnahme-Freigabe (Systemeinstellungen → Datenschutz)?' };
    const vorne = JSON.parse(await this.run(S.vorne));
    return { ok: true, data: { breite: f.breite, hoehe: f.hoehe, vorne: vorne.name,
      hinweis: 'Koordinaten für klick/scrollen in genau diesen Bildpunkten (0,0 = oben links).' }, image: f.png.toString('base64') };
  }

  // App finden, Sperre prüfen, Freigabe holen, nach vorn holen und prüfen, dass sie vorne ist.
  async bereit(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return { ok: false, error: 'Welche App? (app: Name wie in bildschirm_apps)' };
    const list = JSON.parse(await this.run(S.apps));
    const app = list.find((a) => a.name.toLowerCase() === n || a.id.toLowerCase() === n);
    if (!app) return { ok: false, error: `„${name}“ läuft nicht. Starte sie zuerst (z. B. mit open -a) und schau mit bildschirm_apps nach dem genauen Namen.` };
    const grund = gesperrt(app.id);
    if (grund) return { ok: false, error: grund };
    if (!this.erlaubt.has(app.id)) {
      if (!(await this.fragen(app))) return { ok: false, error: `Eris hat nicht erlaubt, „${app.name}“ zu bedienen. Frag im Chat nach, statt es erneut zu versuchen.` };
      this.erlaubt.add(app.id);
    }
    await this.run(S.aktivieren, [app.id]).catch(() => {});
    for (let i = 0; i < 5; i++) {
      await this.warte(150);
      const vorne = JSON.parse(await this.run(S.vorne));
      if (vorne.id === app.id) return { ok: true, app };
    }
    return { ok: false, error: `„${app.name}“ ließ sich nicht nach vorn holen – es wurde nichts geklickt oder getippt.` };
  }

  async klick({ app, x, y, taste = 'links', doppelt = false }) {
    const px = zahl(x, 20000);
    const py = zahl(y, 20000);
    if (px === null || py === null) return { ok: false, error: 'x und y müssen Bildpunkte aus bildschirm_foto sein.' };
    const r = await this.bereit(app);
    if (!r.ok) return r;
    await this.run(S.klick, [px, py, taste === 'rechts' ? 'rechts' : 'links', doppelt ? 2 : 1]);
    return { ok: true, data: `Geklickt in „${r.app.name}“ bei ${px}, ${py}. Prüf das Ergebnis mit bildschirm_foto.` };
  }

  async tippen({ app, text }) {
    const t = String(text == null ? '' : text);
    if (!t || t.length > MAX_TEXT) return { ok: false, error: `Text fehlt oder ist länger als ${MAX_TEXT} Zeichen.` };
    const r = await this.bereit(app);
    if (!r.ok) return r;
    if ((await this.run(S.passwortfeld).catch(() => '')) === 'AXSecureTextField') {
      return { ok: false, error: 'Das ist ein Passwortfeld – Passwörter gibt nur Eris selbst ein.' };
    }
    await this.run(S.tippen, [t], 60000);
    return { ok: true, data: `Getippt in „${r.app.name}“ (${t.length} Zeichen, ohne Enter). Prüf das Ergebnis mit bildschirm_foto.` };
  }

  async taste({ app, taste, mit = [] }) {
    const code = TASTEN[String(taste || '').toLowerCase()];
    const einzeln = /^[a-z0-9]$/i.test(String(taste || ''));
    if (code === undefined && !einzeln) return { ok: false, error: `Unbekannte Taste. Erlaubt: ${Object.keys(TASTEN).join(', ')} oder ein Buchstabe/eine Ziffer mit „mit“ (z. B. cmd).` };
    const mods = (Array.isArray(mit) ? mit : [mit]).map((m) => MIT[String(m).toLowerCase()]).filter(Boolean);
    if (einzeln && !mods.length) return { ok: false, error: 'Einzelne Buchstaben bitte mit bildschirm_tippen; hier nur mit cmd/ctrl/alt/shift.' };
    const r = await this.bereit(app);
    if (!r.ok) return r;
    if (einzeln) await this.run('function run(a){Application("System Events").keystroke(a[0],{using:a.slice(1)});return "ok";}', [String(taste).toLowerCase(), ...mods]);
    else await this.run(S.taste, [code, ...mods]);
    return { ok: true, data: `Taste ${[...(Array.isArray(mit) ? mit : [mit]).filter(Boolean), taste].join('+')} in „${r.app.name}“ gedrückt.` };
  }

  async scrollen({ app, x, y, richtung = 'runter', menge = 5 }) {
    const px = zahl(x, 20000);
    const py = zahl(y, 20000);
    if (px === null || py === null) return { ok: false, error: 'x und y müssen Bildpunkte aus bildschirm_foto sein.' };
    const r = await this.bereit(app);
    if (!r.ok) return r;
    await this.run(S.scrollen, [px, py, richtung === 'hoch' ? 'hoch' : 'runter', menge]);
    return { ok: true, data: `In „${r.app.name}“ ${richtung === 'hoch' ? 'hoch' : 'runter'} gescrollt.` };
  }
}

// Für den Proxy: Aktionen mit verständlichen Fehlern statt Abstürzen.
function makeOps(b) {
  const sicher = (fn) => async (a) => { try { return await fn(a || {}); } catch (e) { return { ok: false, error: `Ging nicht: ${e.message}` }; } };
  return { apps: sicher(() => b.apps()), foto: sicher(() => b.foto()), klick: sicher((a) => b.klick(a)),
    tippen: sicher((a) => b.tippen(a)), taste: sicher((a) => b.taste(a)), scrollen: sicher((a) => b.scrollen(a)) };
}

module.exports = { Bildschirm, makeOps, gesperrt, jxa, SKRIPTE: S, TASTEN };
