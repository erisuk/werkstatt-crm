// Wie voll ein Gespräch ist: alles, was Claude bei einer Anfrage gelesen hat (neu + aus dem Zwischenspeicher).
// Gemeinsam für den laufenden Chat (claude.js) und gespeicherte Gespräche (sessions.js).
function contextTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const sum = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
  return sum > 0 ? sum : null;
}

module.exports = { contextTokens };
