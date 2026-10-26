// Schmale, sichere Brücke zwischen Oberfläche und Hauptprozess.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zentrale', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('get-state'),
  openSession: (args) => ipcRenderer.invoke('open-session', args),
  newSession: (args) => ipcRenderer.invoke('new-session', args),
  send: (text) => ipcRenderer.invoke('send-message', text),
  stopChat: () => ipcRenderer.invoke('stop-chat'),
  respondApproval: (id, decision) => ipcRenderer.invoke('approval-respond', { id, decision }),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  saveTask: (task) => ipcRenderer.invoke('tasks-save', task),
  toggleTask: (id) => ipcRenderer.invoke('tasks-toggle', id),
  removeTask: (id) => ipcRenderer.invoke('tasks-remove', id),
  runTask: (id) => ipcRenderer.invoke('tasks-run', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings-update', patch),
  listConnections: () => ipcRenderer.invoke('connections-list'),
  macToday: () => ipcRenderer.invoke('mac-today'),
  macTest: () => ipcRenderer.invoke('mac-test'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onChatEvent: (fn) => ipcRenderer.on('chat-event', (_e, ev) => fn(ev)),
});
