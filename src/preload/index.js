'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Narrow bridge. The renderer never sees the API key, ipcRenderer, or Node.
contextBridge.exposeInMainWorld('urchin', {
  info: () => ipcRenderer.invoke('app:info'),
  ensureMicAccess: () => ipcRenderer.invoke('mic:ensure'),
  openMicSettings: () => ipcRenderer.invoke('mic:openSettings'),
  createSession: (sdp) => ipcRenderer.invoke('session:create', sdp),
  logSdp: (pair) => ipcRenderer.invoke('debug:logSdp', pair)
});
