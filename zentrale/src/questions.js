// Auswahlfragen von Claude (Werkzeug AskUserQuestion) – wie in der Claude-App als Karte mit Knöpfen.
// Claude schickt bis zu 4 Fragen mit je 2–4 Möglichkeiten; die Antwort geht als
// updatedInput.answers zurück: { "Fragetext": "gewählte Möglichkeit(en), mit Komma getrennt" }.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_ANSWER = 2000;

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// Nur das, was die Karte braucht – alles andere aus der Anfrage bleibt draußen.
function cleanQuestions(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions : [];
  const seen = new Set();
  const list = [];
  for (const q of raw.slice(0, MAX_QUESTIONS)) {
    const question = clip(q && q.question, 1000);
    if (!question || seen.has(question)) continue;
    seen.add(question);
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS)
      .map((o) => ({ label: clip(o && o.label, 200), description: clip(o && o.description, 600) }))
      .filter((o) => o.label);
    list.push({ question, header: clip(q.header, 40), multiSelect: q.multiSelect === true, options });
  }
  return list;
}

// picks: pro Frage { labels: [...], other: 'freier Text' } – in derselben Reihenfolge wie die Fragen.
// Ergebnis: answers-Objekt oder null, wenn eine Frage unbeantwortet ist oder etwas nicht passt.
function answersFor(questions, picks) {
  if (!Array.isArray(questions) || !questions.length || !Array.isArray(picks) || picks.length !== questions.length) return null;
  const answers = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const p = picks[i] && typeof picks[i] === 'object' ? picks[i] : {};
    const valid = new Set(q.options.map((o) => o.label));
    const labels = [...new Set(Array.isArray(p.labels) ? p.labels.map(String) : [])];
    if (labels.some((l) => !valid.has(l))) return null;
    if (!q.multiSelect && labels.length > 1) return null;
    const other = clip(p.other, MAX_ANSWER);
    if (!q.multiSelect && labels.length && other) return null;
    const parts = q.options.map((o) => o.label).filter((l) => labels.includes(l));
    if (other) parts.push(other);
    if (!parts.length) return null;
    answers[q.question] = parts.join(', ').slice(0, MAX_ANSWER);
  }
  return answers;
}

module.exports = { cleanQuestions, answersFor, MAX_QUESTIONS };
