'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  env: $('env'),
  micTest: $('mic-test'),
  micStop: $('mic-stop'),
  micSettings: $('mic-settings'),
  micOut: $('mic-settings-out'),
  meter: $('meter-fill'),
  start: $('start'),
  stop: $('stop'),
  status: $('status'),
  transcript: $('transcript'),
  clear: $('clear'),
  netlost: $('netlost'),
  netlostSub: $('netlost-sub'),
  netlostEnd: $('netlost-end')
};

// --------------------------------------------------------------------------
// Microphone capture
//
// These constraints are the whole point of keeping capture in the renderer.
// Chromium's WebRTC stack implements echo cancellation, noise suppression and
// auto gain. Asking for them is not the same as getting them, which is why we
// read the settings back and show what was actually applied.
// --------------------------------------------------------------------------
const AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

let micStream = null;
let meterStop = null;

async function openMic () {
  const access = await window.urchin.ensureMicAccess();
  if (!access.ok) {
    el.micSettings.hidden = access.platform !== 'darwin';
    throw new Error(
      `Microphone access ${access.status}. macOS will not ask again — ` +
      'grant it in System Settings, then try again.'
    );
  }
  return navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
}

function describeTrack (track) {
  const s = track.getSettings();
  const flag = (name) => {
    const v = s[name];
    if (v === undefined) return `  ${name}: (not reported by this platform)`;
    const cls = v ? 'ok' : 'no';
    return `  <span class="${cls}">${v ? '✓' : '✗'} ${name}: ${v}</span>`;
  };

  return [
    `device: ${track.label || '(unnamed)'}`,
    '',
    'processing:',
    flag('echoCancellation'),
    flag('noiseSuppression'),
    flag('autoGainControl'),
    '',
    'format:',
    `  sampleRate: ${s.sampleRate ?? '—'}`,
    `  channelCount: ${s.channelCount ?? '—'}`,
    `  latency: ${s.latency ?? '—'}`,
    '',
    s.echoCancellation
      ? '<span class="ok">AEC is on. Speakers are safe.</span>'
      : '<span class="no">AEC is OFF — use headphones or the model will interrupt itself.</span>'
  ].join('\n');
}

function startMeter (stream) {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf;

  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    el.meter.style.width = Math.min(100, (peak / 128) * 140).toFixed(1) + '%';
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    src.disconnect();
    ctx.close();
    el.meter.style.width = '0%';
  };
}

function closeMic () {
  meterStop?.();
  meterStop = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
}

el.micTest.addEventListener('click', async () => {
  el.micTest.disabled = true;
  el.micOut.textContent = 'Requesting…';
  try {
    micStream = await openMic();
    const track = micStream.getAudioTracks()[0];
    el.micOut.innerHTML = describeTrack(track);
    meterStop = startMeter(micStream);
    el.micStop.disabled = false;
  } catch (err) {
    el.micOut.innerHTML = `<span class="no">${err.message}</span>`;
    el.micTest.disabled = false;
  }
});

el.micStop.addEventListener('click', () => {
  closeMic();
  el.micStop.disabled = true;
  el.micTest.disabled = false;
});

el.micSettings.addEventListener('click', () => window.urchin.openMicSettings());

// --------------------------------------------------------------------------
// Realtime session
// --------------------------------------------------------------------------
let pc = null;
let dc = null;
let sessionStream = null;
let audioEl = null;

function setStatus (text, kind) {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

// How long 'disconnected' may spin before we stop implying recovery.
// WebRTC can re-establish from 'disconnected'; it cannot from 'failed'.
const RECONNECT_GRACE_MS = 20000;

let stallTimer = null;

function showNetworkOverlay (terminal) {
  clearTimeout(stallTimer);
  stallTimer = null;

  el.netlost.hidden = false;
  el.netlost.classList.toggle('stalled', Boolean(terminal));

  if (terminal) {
    el.netlostSub.textContent =
      'The session could not be recovered. Everything up to this point is kept.';
    el.netlostEnd.hidden = false;
    return;
  }

  el.netlostSub.textContent = 'Reconnecting…';
  el.netlostEnd.hidden = true;
  // Do not spin forever — a spinner that never resolves is worse than an error.
  stallTimer = setTimeout(() => showNetworkOverlay(true), RECONNECT_GRACE_MS);
}

function hideNetworkOverlay () {
  clearTimeout(stallTimer);
  stallTimer = null;
  el.netlost.hidden = true;
  el.netlost.classList.remove('stalled');
  el.netlostEnd.hidden = true;
}

const turns = new Map();

function writeTurn (id, who, text, append) {
  if (el.transcript.querySelector('em')) el.transcript.innerHTML = '';

  let node = turns.get(id);
  if (!node) {
    node = document.createElement('div');
    node.className = 'turn ' + who;
    node.innerHTML = `<span class="who">${who}</span><span class="body"></span>`;
    el.transcript.appendChild(node);
    turns.set(id, node);
  }
  const body = node.querySelector('.body');
  body.textContent = append ? body.textContent + text : text;
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function handleEvent (event) {
  const t = event.type || '';

  // Assistant speech, streamed as it is spoken.
  if (t.endsWith('output_audio_transcript.delta')) {
    writeTurn(event.item_id || event.response_id, 'assistant', event.delta || '', true);
    return;
  }

  // Candidate speech, once the transcription settles.
  if (t.includes('input_audio_transcription')) {
    const text = event.transcript ?? event.delta ?? '';
    if (text) writeTurn(event.item_id || 'user-' + Date.now(), 'user', text, t.endsWith('delta'));
    return;
  }

  if (t === 'error') {
    setStatus('Session error: ' + (event.error?.message || 'unknown'), 'err');
    console.error('Realtime error', event);
    return;
  }

  console.debug('[realtime]', t, event);
}

async function startSession () {
  el.start.disabled = true;
  setStatus('Requesting microphone…');

  try {
    sessionStream = await openMic();

    setStatus('Negotiating…');
    pc = new RTCPeerConnection();

    // Remote audio — the interviewer's voice.
    audioEl = new Audio();
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    for (const track of sessionStream.getAudioTracks()) {
      pc.addTrack(track, sessionStream);
    }

    // The data channel must exist before the offer is created.
    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => setStatus('Connected — interview running.', 'live'));
    dc.addEventListener('message', (e) => {
      try { handleEvent(JSON.parse(e.data)); } catch { /* non-JSON frame */ }
    });
    dc.addEventListener('close', () => setStatus('Session closed.'));

    pc.addEventListener('connectionstatechange', () => {
      if (!pc) return;
      switch (pc.connectionState) {
        case 'connected':
          hideNetworkOverlay();
          setStatus('Connected — interview running.', 'live');
          break;

        // ICE lost the path but may re-establish on its own. This is the
        // state the spinner is honest about.
        case 'disconnected':
          showNetworkOverlay(false);
          setStatus('Connection interrupted.', 'err');
          break;

        // Not recoverable without a fresh handshake. Keep the overlay but
        // stop pretending it is reconnecting.
        case 'failed':
          showNetworkOverlay(true);
          setStatus('Connection failed.', 'err');
          break;
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Handshake goes through the main process, which holds the API key.
    const answerSdp = await window.urchin.createSession(offer.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    el.stop.disabled = false;
  } catch (err) {
    setStatus(String(err.message || err), 'err');
    stopSession();
  }
}

function stopSession () {
  hideNetworkOverlay();
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
  sessionStream?.getTracks().forEach((t) => t.stop());
  sessionStream = null;
  if (audioEl) { audioEl.srcObject = null; audioEl = null; }
  el.start.disabled = false;
  el.stop.disabled = true;
}

el.start.addEventListener('click', startSession);
el.stop.addEventListener('click', () => {
  stopSession();
  setStatus('Interview ended.');
});

el.netlostEnd.addEventListener('click', () => {
  stopSession();
  setStatus('Interview ended after connection loss.', 'err');
});

el.clear.addEventListener('click', () => {
  turns.clear();
  el.transcript.innerHTML = '<em>Nothing yet.</em>';
});

// --------------------------------------------------------------------------
window.urchin.info().then((info) => {
  el.env.textContent =
    `${info.platform} · ${info.model} · ${info.hasKey ? 'key loaded' : 'no API key'}`;
  if (!info.hasKey) {
    el.start.disabled = true;
    setStatus('Set OPENAI_API_KEY in .env to run a live session. Mic test works without it.');
  }
});
