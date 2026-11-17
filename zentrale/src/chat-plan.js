// Aufgabenliste und „Nächster Schritt“ eines Chats – wie in der Claude-App: Claude setzt die Liste der Schritte
// (offen / läuft / erledigt), die Zentrale zeigt sie unter der letzten Antwort. Am Ende kommt eine kurze
// Zusammenfassung, bei Bedarf mit einer Frage und Knöpfen, die Eris mit einem Klick beantwortet.
const MAX_STEPS = 12;
const MAX_BUTTONS = 3;
const STATUS = { offen: 'offen', pending: 'offen', 'läuft': 'läuft', laeuft: 'läuft', in_progress: 'läuft', erledigt: 'erledigt', completed: 'erledigt', done: 'erledigt' };

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// → { schritte: [{ text, status }] } oder Fehler. Höchstens ein Schritt „läuft“.
function cleanPlan(input) {
  const raw = input && Array.isArray(input.schritte) ? input.schritte : null;
  if (!raw || !raw.length) return { ok: false, error: 'schritte fehlt: Liste mit { text, status } (offen / läuft / erledigt).' };
  const schritte = raw.slice(0, MAX_STEPS).map((s) => ({ text: clip(s && s.text, 120), status: STATUS[String(s && s.status).toLowerCase()] || 'offen' }))
    .filter((s) => s.text);
  if (!schritte.length) return { ok: false, error: 'Jeder Schritt braucht einen Text.' };
  let running = false;
  const fixed = schritte.map((s) => {
    if (s.status !== 'läuft') return s;
    if (running) return { ...s, status: 'offen' };
    running = true;
    return s;
  });
  return { ok: true, plan: { schritte: fixed } };
}

// → { zusammenfassung, frage?, knoepfe: [{ text, nachricht }] }. Knöpfe nur zusammen mit einer Frage.
function cleanAbschluss(input) {
  const zusammenfassung = clip(input && input.zusammenfassung, 600);
  if (!zusammenfassung) return { ok: false, error: 'zusammenfassung fehlt: 2–3 Sätze, was jetzt fertig ist und was noch offen ist.' };
  const frage = clip(input && input.frage, 140);
  const knoepfe = frage && Array.isArray(input.knoepfe)
    ? input.knoepfe.slice(0, MAX_BUTTONS).map((k) => ({ text: clip(k && k.text, 30), nachricht: clip((k && k.nachricht) || (k && k.text), 300) }))
      .filter((k) => k.text) : [];
  return { ok: true, abschluss: { zusammenfassung, frage: frage || null, knoepfe } };
}

module.exports = { cleanPlan, cleanAbschluss, MAX_STEPS };
