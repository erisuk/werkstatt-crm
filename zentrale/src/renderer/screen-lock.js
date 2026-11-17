// Eingabesperre, solange ein Chat Maus oder Tastatur des Macs steuert (osascript keystroke, cliclick, Bildschirmsteuerung).
// Dessen Tastendrücke landen im Fenster, das gerade vorne ist – oft die Zentrale. Ohne Sperre würde getippter Text
// samt Enter als Nachricht an Claude rausgehen (so geschehen am 15.11.). „Trotzdem schreiben“ hebt die Sperre auf.
// Nutzt die Helfer aus app.js (h, ui, $ …).
const LOCKED_INPUTS = new Set(['chat-input', 'quick-input']);

function screenLock() {
  const sc = ui.state && ui.state.screenControl;
  if (!sc || Date.now() >= sc.until) return null;
  if (ui.typeAnywayUntil && ui.typeAnywayUntil >= sc.until) return null;
  return sc;
}

function renderScreenLock() {
  const sc = screenLock();
  for (const id of ['chat-screen-lock', 'quick-screen-lock']) {
    const box = $(`#${id}`);
    if (!box) continue;
    box.hidden = !sc;
    if (!sc) continue;
    const text = `„${sc.title}“ steuert gerade Maus und Tastatur – das Eingabefeld ist gesperrt, damit nichts versehentlich hier landet.`;
    if (box.dataset.text === text) continue;
    box.dataset.text = text;
    fill(box, h('span', { text }),
      h('button', { class: 'link', 'data-focus': `${id}-anyway`, onClick: () => { ui.typeAnywayUntil = sc.until; renderScreenLock(); } }, 'Trotzdem schreiben'));
  }
  // Läuft die Sperre ab, ohne dass neuer Stand kommt: dann selbst wieder freigeben.
  clearTimeout(ui.screenLockTimer);
  if (sc) ui.screenLockTimer = setTimeout(renderScreenLock, Math.max(500, sc.until - Date.now() + 50));
}

// Tasten, Einfügen und Absenden in den Eingabefeldern abfangen (Capture: vor allen anderen Handlern).
function blockWhileLocked(e) {
  if (!screenLock() || !e.target || !LOCKED_INPUTS.has(e.target.id)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  renderScreenLock();
}
for (const type of ['keydown', 'beforeinput', 'paste', 'drop']) document.addEventListener(type, blockWhileLocked, true);
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (screenLock() && form && form.querySelector && [...LOCKED_INPUTS].some((id) => form.querySelector(`#${id}`))) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

if (typeof module !== 'undefined') module.exports = { LOCKED_INPUTS };
