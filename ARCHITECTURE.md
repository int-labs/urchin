# urchin — AI Interview App

A Zoom-shaped desktop app where the interviewer is an LLM. Runs on the
recruiter's Mac. Records locally, uploads the result afterward.

## Settled decisions

| Question | Decision | Why |
|---|---|---|
| Desktop or web? | **Desktop** | Daily repeat user, so install cost amortizes; GB of local audio; reliable continuous disk writes; audio device control; no browser-tab fragility mid-session |
| Electron or Tauri? | **Electron** | Bundles Chromium, so WebRTC and `getUserMedia` behave identically everywhere. Tauri's WKWebView path needs fighting, and non-technical users can't absorb that risk |
| Offline capable? | **No** | Adaptive interviewing requires the Realtime API, which needs a live connection throughout. Zoom has the same constraint |
| Who operates it? | **The recruiter**, on macOS | Candidate is present; recruiter's machine hosts the session |
| Recording location | **Local disk, then upload** | Matches Zoom's local-recording model |
| OpenAI key | **Never on the client** | Backend mints per-session credentials |
| Atlas credentials | **Never on the client** | Backend is the only thing that talks to Atlas |

Electron's costs — ~100 MB installer, heavier memory — are irrelevant for a
daily-use professional tool on a workstation. Its benefit attacks the
project's largest technical risk directly.

## Shape

```
Recruiter's Mac (Electron)
  |
  |-- (1) auth + start session --> your API --> OpenAI (mint session)
  |-- (2) WebRTC audio -------------------------> OpenAI Realtime
  |-- (3) record to local disk (audio + transcript, continuous)
  |
  '-- (4) on completion / reconnect --> your API --> Atlas + object storage
```

Audio flows **directly** between the app and OpenAI. Only the handshake
touches your backend, so you pay no latency or bandwidth for the media.

## Why capture stays in the renderer

Chromium's WebRTC stack provides echo cancellation, noise suppression and
jitter buffering through `getUserMedia` constraints. This is not optional:
the recruiter will sometimes run on speakers, and without AEC the mic picks
up the LLM's own voice and the model interrupts itself. Do not move capture
into a native module to "do it properly" — you would inherit AEC, and that
is real DSP work nobody needs on this critical path.

## macOS microphone permission

Three things are required, and **all three** must be present or the prompt
never appears:

1. Entitlement `com.apple.security.device.audio-input` in the entitlements
   plist. Without it the OS suppresses the prompt entirely ("Policy
   disallows prompt") under hardened runtime
2. `NSMicrophoneUsageDescription` in `Info.plist`, via electron-builder's
   `extendInfo`. Without it the prompt shows Electron's generic placeholder
3. `systemPreferences.askForMediaAccess('microphone')` called from the
   **main process**. Renderer `getUserMedia` alone has been reported to fail
   silently — returning a stream with no audio track

Check state with `systemPreferences.getMediaAccessStatus('microphone')`
before starting a session.

### Entitlements file — the expensive footgun

**A custom entitlements plist replaces electron-builder's defaults, it does
not merge with them.** Write a file containing only `audio-input` and you
drop `com.apple.security.cs.allow-jit`, and the app fails to launch after
signing. Keep the defaults and add to them.

- Point **both** `entitlements` and `entitlementsInherit` at plists. Helper
  processes don't inherit automatically; the renderer runs in a helper, so
  `audio-input` is needed in the inherit file too
- Do **not** add `com.apple.security.cs.allow-unsigned-executable-memory`.
  Modern Electron doesn't need it and it weakens the hardened runtime

### TCC is keyed to the code signature

macOS ties a permission grant to bundle identifier + signature, which
produces several confusing failures:

- **Bundle ID mismatch** — if packaging renames the bundle and rewrites
  `CFBundleIdentifier` without re-signing, TCC never prompts and the app
  never appears in the Privacy list. Re-sign *after* packaging
- **Any bundle edit invalidates the signature**, after which TCC silently
  denies everything. Re-sign after edits
- **Ad-hoc rebuilds lose grants** — the CDHash changes, macOS treats it as a
  different app, and the previous grant stops matching. Expect permission to
  appear to reset at random while iterating
- **Dev mode is unreliable for this.** Apps launched from a terminal, or dev
  launchers that edit Electron's `Info.plist` without re-signing, can't
  request TCC permissions at all. Verify on a properly signed build only
- Stale denial cached: `tccutil reset Microphone <bundle-id>`
- Sign consistently (same Developer ID, same bundle ID) so grants survive
  app updates

Verify with `codesign -d -vv` that the signed identifier matches
`CFBundleIdentifier`.

**Denial is a dead end.** macOS will not re-prompt once denied. The app must
detect this and deep-link to System Settings:
`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`.
Given the user base, write this path carefully — it is the single most
likely support ticket.

## Signing and notarization — not optional

Unsigned apps are blocked by Gatekeeper. Your users will not know to
right-click then Open, and should not be asked to.

- Apple Developer Program membership ($99/yr) — **enroll first**, approval
  has lead time and blocks everything else
- Developer ID Application certificate
- Hardened runtime + entitlements above
- Notarize with `notarytool`, then staple
- Ship a universal binary (arm64 + x64) unless you know the fleet
- Auto-update via electron-updater, which also requires signing

### Build-machine problem

Development here is on Windows 11. Most of the client is testable there and
transfers unchanged — the renderer is Chromium on both platforms, so
`getUserMedia`, WebRTC, `MediaRecorder`, echo cancellation and the whole
session flow behave the same. Build all of it on Windows.

What does **not** transfer is the macOS permission gate, because Windows has
no equivalent to test against:

| Piece | Where it lives | Testable on Windows? |
|---|---|---|
| `getUserMedia` / WebRTC / AEC | Renderer (Chromium) | Yes — identical |
| `NSMicrophoneUsageDescription` | `Info.plist`, build time | No — no such file |
| `com.apple.security.device.audio-input` | Codesign entitlement, sign time | No — no hardened runtime |
| `askForMediaAccess()` | Electron main, macOS-only API | No — no-op off macOS |
| Notarization | Apple's service, inspects signed binary | No |

These are build-pipeline and signing artifacts, not runtime options. A green
run on Windows exercises none of them.

The practical path, which needs no Mac purchase:

1. Build and iterate on Windows
2. GitHub Actions `macos-*` runners build, sign and notarize — this verifies
   the pipeline (entitlements present, notarization accepted)
3. Put the notarized build on **the recruiter's own Mac** for the one thing
   CI cannot do: confirm audio actually captures, and that the permission
   prompt is comprehensible. This doubles as usability testing on the real
   target hardware

Needed once, early — not a dev machine. If borrowing isn't possible, an
hourly cloud Mac covers it.

## Components

### Client (Electron)

- Renderer: UI + WebRTC session with the Realtime API + `MediaRecorder`
- Main: local recording to disk, SQLite, outbox queue, keychain, permissions
- Writes audio and transcript **incrementally** during the session, so a
  mid-interview network failure costs the remainder, not the whole thing
- Set `contextIsolation: true`, `nodeIntegration: false`; expose main-process
  capability through a narrow preload bridge

### Backend (small — roughly four endpoints)

- `POST /auth` — recruiter sign-in
- `POST /sessions` — accept the client's SDP offer, forward it to
  `/v1/realtime/calls` with the API key, return the SDP answer
- `POST /sessions/:id/artifacts` — accept recording + transcript
- `POST /sessions/:id/report` — generate report, write to Atlas

Holds the real OpenAI key and the Atlas connection string. Nothing else does.

### Local storage

- Audio files on disk, not in the database
- SQLite for session metadata, transcript, and the outbox table
  (`status`, `attempts`, `last_error`)
- Encrypt at rest — these are identifiable recordings of real people
- Use `safeStorage` / Keychain for the recruiter's session token

## Credentials

| Secret | Lives in |
|---|---|
| OpenAI API key | Backend only |
| Atlas connection string | Backend only |
| Recruiter session token | macOS Keychain on the client |

### Handshake: unified interface, not ephemeral tokens

The Realtime API offers two browser connection mechanisms. We use the
**unified interface**, which OpenAI recommends for "simpler setup and faster
connections":

1. Client creates an SDP offer and posts it to our trusted server
2. Server POSTs multipart (`sdp` + `session` JSON) to
   `https://api.openai.com/v1/realtime/calls` with the standard API key
3. Server returns the SDP answer; client applies it as remote description

The client never holds an OpenAI credential — not even a short-lived one.
This is strictly better than the ephemeral-token flow
(`/v1/realtime/client_secrets`), which hands the browser a real, if
short-lived, key.

Set `OpenAI-Safety-Identifier` on the server-side request, as a stable hashed
recruiter id. It must be set by the trusted server, never by the client.

Model: `gpt-realtime-2.1`. Data channel label: `oai-events`, created *before*
the offer. Note that the older `/v1/realtime?model=...` path with an
`OpenAI-Beta` header is pre-GA and will not connect.

**Consequence for sequencing:** a trusted server is required in the handshake
even for a bare WebRTC spike. During development the Electron main process
plays that role (`createSession()` in `src/main/index.js`), so no HTTP
backend is needed yet. Swapping in the real backend is one function body.

## Failure modes to design for

1. **Network dies mid-interview** — the real one. Local recording continues;
   the LLM side stops. Decide: resume the session, or end and salvage?
2. **Microphone permission denied** — cannot re-prompt; guide to Settings
3. **Upload fails** — outbox retries with backoff on reconnect
4. **App crashes mid-session** — incremental writes mean the session is
   recoverable; buffering in memory means it isn't
5. **Ephemeral credential expires before connect** — mint late, retry once

## Prep checklist, in order

1. **Enroll in the Apple Developer Program.** Lead time, blocks release
2. **Spike capture on Windows**: bare Electron app, `getUserMedia`, record
   and play back, AEC on speakers. Proves the renderer half
3. **Verify the permission gate on a Mac once**, on a signed,
   notarized build via CI — entitlement + usage string +
   `askForMediaAccess`. An unsigned build will not reproduce the real
   behaviour, and the failure mode is silent: `getUserMedia` resolves with a
   stream that has no audio track
4. Backend: auth + `POST /sessions`. Prove a token mint end to end
5. Client: connect WebRTC to Realtime, hold a conversation
6. Local recording — mix the local mic track and the remote LLM track via
   Web Audio so the recording captures both sides
7. SQLite schema + outbox
8. Report generation (server-side) and the Atlas write
9. Notarization + auto-update

Do not add encryption or the outbox before step 5 works.

## Compliance

AI in hiring is regulated in both the EU and several US jurisdictions.
Design in from the start, not afterward:

- Consent capture at session start
- Retention policy and automated expiry
- Deletion that reaches the local copy, object storage, and the Atlas record
- An audit trail of what the model was asked and what it returned
