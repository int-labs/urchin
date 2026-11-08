'use strict';

const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, session, shell, systemPreferences
} = require('electron');

require('dotenv').config();

const INTERVIEWER_PROMPT = require('./interviewer-prompt');

const MODEL = process.env.URCHIN_MODEL || 'gpt-realtime-2.1';
const VOICE = process.env.URCHIN_VOICE || 'marin';

// --------------------------------------------------------------------------
// Backend stand-in.
//
// The Realtime API's "unified interface" puts a trusted server in the
// handshake: the client sends its SDP offer, the server forwards it to OpenAI
// with the real API key, and returns the SDP answer. No credential ever
// reaches the renderer.
//
// Until the real backend exists, the Electron main process plays that role.
// When it does exist, replace the body of createSession() with a call to it.
// Nothing in the renderer changes.
// --------------------------------------------------------------------------
async function createSession (sdp) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.'
    );
  }

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify({
    type: 'realtime',
    model: MODEL,
    instructions: INTERVIEWER_PROMPT,
    audio: { output: { voice: VOICE } }
  }));

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
      // When real users exist, set OpenAI-Safety-Identifier here to a stable
      // hashed recruiter id. It must be set server-side, never by the client.
    },
    body: form
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}: ${body.slice(0, 400)}`);
  }
  return body; // raw SDP answer
}

// --------------------------------------------------------------------------
// macOS microphone permission.
//
// On Windows this is a no-op: there is no equivalent gate, which is also why
// a green run here proves nothing about the macOS path.
// --------------------------------------------------------------------------
async function ensureMicAccess () {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-applicable', platform: process.platform };
  }

  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return { ok: true, status, platform: 'darwin' };

  // macOS will not re-prompt once denied — the user has to be sent to Settings.
  if (status === 'denied' || status === 'restricted') {
    return { ok: false, status, platform: 'darwin' };
  }

  const granted = await systemPreferences.askForMediaAccess('microphone');
  return {
    ok: granted,
    status: granted ? 'granted' : 'denied',
    platform: 'darwin'
  };
}

function createWindow () {
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    backgroundColor: '#13151a',
    title: 'urchin',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Allow microphone capture from our own page only.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback) => callback(permission === 'media')
  );

  ipcMain.handle('mic:ensure', () => ensureMicAccess());

  ipcMain.handle('mic:openSettings', async () => {
    if (process.platform !== 'darwin') return false;
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    );
    return true;
  });

  ipcMain.handle('session:create', (_event, sdp) => {
    if (typeof sdp !== 'string' || !sdp.trim()) {
      throw new Error('An SDP offer is required');
    }
    return createSession(sdp);
  });

  ipcMain.handle('app:info', () => ({
    model: MODEL,
    voice: VOICE,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    platform: process.platform
  }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
