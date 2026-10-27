// Spricht mit deinem n8n (Standard: http://localhost:5678) über dessen öffentliche Schnittstelle.
// Wird vom Hauptprozess (Seite „Automatisierungen“) und vom MCP-Server für Claude benutzt.
// Neue Workflows legen wir immer ausgeschaltet an; Einschalten ist ein eigener, bewusster Schritt.

const DEFAULT_URL = 'http://localhost:5678';
const TIMEOUT_MS = 15000;

function normalizeBase(url) {
  let u;
  try { u = new URL(String(url || DEFAULT_URL).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.origin;
}

class N8n {
  constructor({ baseUrl = DEFAULT_URL, apiKey = null, fetchImpl = globalThis.fetch } = {}) {
    this.base = normalizeBase(baseUrl) || DEFAULT_URL;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    if (!this.apiKey) return { ok: false, error: 'Kein n8n-API-Schlüssel hinterlegt. Trag ihn in der Zentrale unter „Automatisierungen“ ein.' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(`${this.base}/api/v1${path}`, {
        method, signal: ctrl.signal,
        headers: { 'X-N8N-API-KEY': this.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'n8n lehnt den API-Schlüssel ab. Erstelle in n8n unter Einstellungen → n8n API einen neuen.' };
      if (!res.ok) return { ok: false, error: `n8n meldet Fehler ${res.status}: ${(data && data.message) || text.slice(0, 200)}` };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'n8n hat nicht rechtzeitig geantwortet.' : `n8n ist nicht erreichbar (${this.base}). Läuft n8n?` };
    } finally {
      clearTimeout(timer);
    }
  }

  // Läuft n8n überhaupt? Braucht keinen Schlüssel.
  async health() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await this.fetch(`${this.base}/healthz`, { signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  async listWorkflows() {
    const res = await this.request('GET', '/workflows?limit=250');
    if (!res.ok) return res;
    const list = (res.data && res.data.data) || [];
    return { ok: true, data: list.map((w) => ({ id: String(w.id), name: String(w.name || ''), active: !!w.active,
      updatedAt: w.updatedAt || null, nodes: Array.isArray(w.nodes) ? w.nodes.length : null,
      tags: Array.isArray(w.tags) ? w.tags.map((t) => t.name).filter(Boolean) : [] })) };
  }

  async getWorkflow(id) {
    if (!validId(id)) return { ok: false, error: 'Ungültige Workflow-ID.' };
    return this.request('GET', `/workflows/${encodeURIComponent(id)}`);
  }

  // Nur die Felder, die n8n beim Anlegen annimmt – und nie eingeschaltet.
  async createWorkflow(def) {
    const clean = cleanDefinition(def);
    if (!clean.ok) return clean;
    return this.request('POST', '/workflows', clean.data);
  }

  async updateWorkflow(id, def) {
    if (!validId(id)) return { ok: false, error: 'Ungültige Workflow-ID.' };
    const clean = cleanDefinition(def);
    if (!clean.ok) return clean;
    return this.request('PUT', `/workflows/${encodeURIComponent(id)}`, clean.data);
  }

  async setActive(id, active) {
    if (!validId(id)) return { ok: false, error: 'Ungültige Workflow-ID.' };
    return this.request('POST', `/workflows/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`);
  }

  async listExecutions(limit = 20) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const res = await this.request('GET', `/executions?limit=${n}`);
    if (!res.ok) return res;
    const list = (res.data && res.data.data) || [];
    return { ok: true, data: list.map((e) => ({ id: String(e.id), workflowId: String(e.workflowId || ''), status: e.status || (e.finished ? 'success' : 'unknown'),
      startedAt: e.startedAt || null, stoppedAt: e.stoppedAt || null, mode: e.mode || null })) };
  }

  editorUrl(id) {
    return id && validId(id) ? `${this.base}/workflow/${encodeURIComponent(id)}` : `${this.base}/home/workflows`;
  }
}

function validId(id) {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
}

function cleanDefinition(def) {
  if (!def || typeof def !== 'object') return { ok: false, error: 'Workflow-Definition fehlt.' };
  const name = String(def.name || '').trim();
  if (!name) return { ok: false, error: 'Der Workflow braucht einen Namen.' };
  if (!Array.isArray(def.nodes) || !def.nodes.length) return { ok: false, error: 'Der Workflow braucht mindestens einen Knoten (nodes).' };
  return { ok: true, data: { name: name.slice(0, 128), nodes: def.nodes, connections: def.connections && typeof def.connections === 'object' ? def.connections : {},
    settings: def.settings && typeof def.settings === 'object' ? def.settings : { executionOrder: 'v1' } } };
}

module.exports = { N8n, DEFAULT_URL, normalizeBase, cleanDefinition, validId };
