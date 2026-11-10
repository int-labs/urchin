'use strict';

const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const {
  app, BrowserWindow, ipcMain, session, shell, systemPreferences
} = require('electron');

require('dotenv').config();

const INTERVIEWER_PROMPT = require('./interviewer-prompt');

const MODEL = process.env.URCHIN_MODEL || 'gpt-realtime-2.1';
const VOICE = process.env.URCHIN_VOICE || 'marin';

// Stands in for the backend. Forwards the renderer's SDP offer to OpenAI
// using the real key, so no credential ever reaches the renderer.
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

// Only macOS gates the microphone at OS level. Windows has no equivalent,
// so this returns early there and proves nothing about the macOS path.
async function ensureMicAccess () {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-applicable', platform: process.platform };
  }

  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return { ok: true, status, platform: 'darwin' };

  // macOS never re-prompts once denied, so the caller must open Settings.
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

  // Writes both SDP documents to logs/ so a session can be read afterwards.
  // logs/ is already covered by the *.log rule in .gitignore.
  ipcMain.handle('debug:logSdp', async (_event, pair) => {
    const dir = path.join(app.getAppPath(), 'logs');
    await mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `sdp-${stamp}.log`);

    // A null answer means the handshake was rejected. Keep the offer anyway.
    await writeFile(file, [
      '=== OFFER (this app) ===',
      pair.offer,
      '',
      '=== ANSWER (OpenAI) ===',
      pair.answer ?? '(none: handshake failed before an answer was returned)',
      ''
    ].join('\n'), 'utf8');

    return file;
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
