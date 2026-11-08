# urchin

Electron shell for an AI-conducted job interview. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the decisions behind it.

## Status

Step 1 of the build: the client shell, a WebRTC session against the OpenAI
Realtime API, and a microphone/AEC diagnostic panel.

Not built yet — these wait on HR's requirements:

- Local recording to disk
- SQLite + outbox
- Report generation and the Atlas write
- The real backend (see *Backend stand-in* below)
- The scoring rubric — placeholder lives in
  [`src/main/interviewer-prompt.js`](src/main/interviewer-prompt.js)

## Running it

```bash
npm install
cp .env.example .env     # then paste your OpenAI API key into .env
npm start
```

**The microphone panel works without an API key.** Use it to confirm echo
cancellation is active before worrying about anything else.

## Backend stand-in

The Realtime API's *unified interface* requires a trusted server in the
handshake: the client posts its SDP offer, the server forwards it to OpenAI
with the real API key, and returns the SDP answer. The browser never holds an
OpenAI credential — not even a short-lived one.

Until the real backend exists, the Electron **main process** plays that role.
`createSession()` in [`src/main/index.js`](src/main/index.js) is the only
place that touches the key.

When the backend exists, replace the body of that one function with a call to
it. The renderer does not change.

## Why capture lives in the renderer

Chromium's WebRTC stack provides echo cancellation, noise suppression and
auto gain through `getUserMedia` constraints. AEC is not optional: the
recruiter will sometimes run on speakers, and without it the model hears its
own voice and interrupts itself.

The diagnostic panel reads the constraints back with `track.getSettings()`,
because asking for AEC and getting it are different things.

## macOS

Everything except the permission gate is testable on Windows. The gate is not —
Windows has no equivalent, so a green run here is no evidence either way.
`ARCHITECTURE.md` has the full checklist; the short version:

- `build/entitlements.mac.plist` **replaces** electron-builder's defaults
  rather than merging. Removing `com.apple.security.cs.allow-jit` makes the
  signed app crash on launch
- Both `entitlements` and `entitlementsInherit` are needed — the renderer
  runs in a helper process
- TCC ties grants to the code signature; verify on a **signed** build only.
  Dev-mode launches cannot request permissions reliably

## Layout

```
src/main/index.js              window, mic permission, backend stand-in
src/main/interviewer-prompt.js HR's rubric goes here
src/preload/index.js           the only renderer/main bridge
src/renderer/                  UI, mic diagnostics, WebRTC session
build/entitlements.*.plist     macOS signing
electron-builder.yml           packaging
```
