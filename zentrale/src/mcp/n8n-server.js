// MCP-Server "n8n": Claude liest Workflows und baut neue – angelegt wird immer ausgeschaltet.
// Adresse und Schlüssel kommen aus der Umgebung (ZENTRALE_N8N_URL, ZENTRALE_N8N_KEY), nie aus einer Datei.
const { serve } = require('./core');
const { N8n } = require('../n8n');

const client = () => new N8n({ baseUrl: process.env.ZENTRALE_N8N_URL, apiKey: process.env.ZENTRALE_N8N_KEY || null });
const id = { type: 'string', description: 'Workflow-ID aus n8n_list_workflows' };
const definition = {
  type: 'object', description: 'n8n-Workflow im JSON-Format von n8n: { name, nodes: [...], connections: {...}, settings? }',
  properties: { name: { type: 'string' }, nodes: { type: 'array', items: { type: 'object' } }, connections: { type: 'object' }, settings: { type: 'object' } },
  required: ['name', 'nodes'],
};

const TOOLS = [
  { name: 'n8n_list_workflows', readOnly: true,
    description: 'Listet alle Workflows im n8n der Zentrale (ID, Name, an/aus, Anzahl Knoten, Tags).',
    inputSchema: { type: 'object', properties: {} },
    run: () => client().listWorkflows() },
  { name: 'n8n_get_workflow', readOnly: true,
    description: 'Liest einen Workflow vollständig (Knoten, Verbindungen, Einstellungen) – als Vorlage oder zum Ändern.',
    inputSchema: { type: 'object', required: ['id'], properties: { id } },
    run: (a) => client().getWorkflow(a.id) },
  { name: 'n8n_list_executions', readOnly: true,
    description: 'Die letzten Ausführungen aller Workflows mit Status (success, error, running …).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '1 bis 100, Standard 20' } } },
    run: (a) => client().listExecutions(a.limit) },
  { name: 'n8n_create_workflow', readOnly: false,
    description: 'Legt einen neuen Workflow an. Er ist immer ausgeschaltet und ohne Zugangsdaten; die verbindet der Nutzer selbst in n8n.',
    inputSchema: { type: 'object', required: ['workflow'], properties: { workflow: definition } },
    run: async (a) => {
      const res = await client().createWorkflow(a.workflow);
      return res.ok ? { ok: true, data: { id: res.data && res.data.id, name: res.data && res.data.name, active: false,
        link: client().editorUrl(res.data && String(res.data.id)) } } : res;
    } },
  { name: 'n8n_update_workflow', readOnly: false,
    description: 'Ersetzt einen bestehenden Workflow vollständig (vorher mit n8n_get_workflow lesen).',
    inputSchema: { type: 'object', required: ['id', 'workflow'], properties: { id, workflow: definition } },
    run: (a) => client().updateWorkflow(a.id, a.workflow) },
  { name: 'n8n_set_active', readOnly: false,
    description: 'Schaltet einen Workflow ein (er läuft dann automatisch nach seinem Auslöser) oder aus.',
    inputSchema: { type: 'object', required: ['id', 'active'], properties: { id, active: { type: 'boolean' } } },
    run: (a) => client().setActive(a.id, a.active === true) },
];

const READ_ONLY_TOOLS = TOOLS.filter((t) => t.readOnly).map((t) => t.name);

if (require.main === module) serve(TOOLS, 'zentrale-n8n');

module.exports = { TOOLS, READ_ONLY_TOOLS };
