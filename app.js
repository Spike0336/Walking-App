/* app.js -- Web Bluetooth control + history tracking for the mobile PWA.
   Mirrors walkingpad_app.py's BleWorker, but runs entirely in-browser:
   there's no filesystem, so activity history lives in localStorage
   instead of activity_history.json. */

const P = window.FitshowProtocol;
const HISTORY_KEY = 'wp_activity_history';
const VIDEO_KEY = 'wp_last_video';
const SERVICES_KEY = 'wp_service_uuids';
const POLL_INTERVAL_MS = 450;

// ---- Screen wake lock (matters more on a phone than a laptop --
// without it Android will lock the screen mid-walk). ----------------

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      log('Screen keep-awake active.');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (err) {
    log('WakeLock error: ' + err.name + ', ' + err.message);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

// Best-guess service UUIDs for the ffe1 (write) / fff1 (notify) characteristics.
// Web Bluetooth -- unlike bleak on desktop -- requires the service UUID to be
// named up front in `optionalServices`; it can't enumerate every service on
// the device for privacy reasons. These are the common 128-bit expansions of
// the short UUIDs the desktop app found (ffe0 commonly holds ffe1, fff0
// commonly holds fff1 on this family of BLE fitness modules). If your pad
// doesn't connect, use a BLE scanner app (e.g. "nRF Connect" from the Play
// Store) to read its actual service UUIDs and paste them into the field
// below the Connect button.
const DEFAULT_SERVICE_GUESSES = [
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffb0-0000-1000-8000-00805f9b34fb',
];

const $ = (id) => document.getElementById(id);

const state = {
  device: null,
  server: null,
  writeChar: null,
  notifyChar: null,
  connected: false,
  userInitiatedDisconnect: false,
  pollTimer: null,
  running: false,
  sessionActive: false,
  sessionDate: null,
  programme: null,      // currently running programme object, or null
  programmeIdx: -1,
  segmentIndex: -1,
  segmentRemaining: 0,
  programmeTimer: null,
  isPaused: false,
  prePauseSpeed: 3.0,
  targetSpeed: null,
  listening: false,
  voiceRestartTimer: null,
  lastDistanceM: 0,
  lastCalories: 0,
  lastTimeS: 0,
};

// ---- History (localStorage stand-in for activity_history.json) --------

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : { sessions: [] };
  } catch (e) {
    return { sessions: [] };
  }
}

function saveHistorySession(dateStr, distanceM, calories, durationS, avgSpeedKmh) {
  const data = loadHistory();
  data.sessions.push({
    date: dateStr,
    distance_m: Math.round(distanceM * 10) / 10,
    calories: Math.round(calories * 10) / 10,
    duration_s: durationS,
    avg_speed_kmh: Math.round(avgSpeedKmh * 100) / 100,
    ended_at: new Date().toISOString(),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(data));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function log(msg) {
  const el = $('logBox');
  const line = document.createElement('div');
  line.textContent = msg;
  el.prepend(line);
  while (el.children.length > 40) el.removeChild(el.lastChild);
}

// ---- Bluetooth ----------------------------------------------------------

function getServiceGuesses() {
  const stored = localStorage.getItem(SERVICES_KEY);
  const field = $('serviceUuidInput').value.trim();
  const list = field ? field.split(',').map(s => s.trim()).filter(Boolean) : (stored ? JSON.parse(stored) : DEFAULT_SERVICE_GUESSES);
  return list;
}

async function connect() {
  if (!navigator.bluetooth) {
    log('This browser has no Web Bluetooth support. Use Chrome or Samsung Internet on Android.');
    setStatus('Web Bluetooth unavailable', false);
    return;
  }
  requestWakeLock(); // best done inside a user gesture (this click) for reliability
  const services = getServiceGuesses();
  localStorage.setItem(SERVICES_KEY, JSON.stringify(services));
  state.userInitiatedDisconnect = false;

  try {
    log('Opening device picker...');
    state.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: services,
    });
    state.device.addEventListener('gattserverdisconnected', onDisconnected);
    await bindToDevice();
  } catch (e) {
    log('Connect failed: ' + e);
    setStatus('Connect failed', false);
  }
}

/** Connects GATT (if needed) and (re)discovers characteristics + notifications.
 *  Used both for the first connect and for silent auto-reconnects. */
async function bindToDevice() {
  log(`Connecting to ${state.device.name || state.device.id}...`);
  state.server = await state.device.gatt.connect();

  let writeChar = null, notifyChar = null;
  const primaryServices = await state.server.getPrimaryServices();
  for (const service of primaryServices) {
    const chars = await service.getCharacteristics();
    for (const ch of chars) {
      const uuid = ch.uuid.toLowerCase();
      if (uuid.includes('ffe1') && !writeChar) writeChar = ch;
      if (uuid.includes('fff1') && !notifyChar) notifyChar = ch;
    }
  }
  if (!writeChar || !notifyChar) {
    // Generic fallback, same idea as the desktop app: take whatever looks writable/notifiable.
    for (const service of primaryServices) {
      const chars = await service.getCharacteristics();
      for (const ch of chars) {
        if (!writeChar && (ch.properties.write || ch.properties.writeWithoutResponse)) writeChar = ch;
        if (!notifyChar && ch.properties.notify) notifyChar = ch;
      }
    }
  }
  if (!writeChar || !notifyChar) {
    log('Could not find write/notify characteristics under the service UUIDs tried. ' +
        'Find the real service UUID with a BLE scanner app and paste it into the field below.');
    setStatus('Connect failed', false);
    return false;
  }

  state.writeChar = writeChar;
  state.notifyChar = notifyChar;
  log(`Using write=${writeChar.uuid} notify=${notifyChar.uuid}`);

  await notifyChar.startNotifications();
  notifyChar.addEventListener('characteristicvaluechanged', onNotify);
  log('Subscribed to notifications OK');

  await send(P.cmdQueryInfo());
  await send(P.cmdQueryStatus());

  state.connected = true;
  setStatus(state.device.name || 'Connected', true);

  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { send(P.cmdPoll()).catch(e => log('Poll error: ' + e)); }, POLL_INTERVAL_MS);
  return true;
}

async function onDisconnected() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  state.connected = false;
  state.writeChar = null;
  state.notifyChar = null;
  setStatus('Disconnected', false);

  if (state.userInitiatedDisconnect) {
    log('Disconnected.');
    if (state.sessionActive) finalizeSession();
    if (state.programme) cancelProgramme(false);
    return;
  }

  // Not asked for -- the pad dropped the link on its own. Try to get straight
  // back to where we were rather than losing a run in progress.
  log('Connection dropped unexpectedly -- attempting to reconnect...');
  if (state.programme) { if (state.programmeTimer) clearInterval(state.programmeTimer); }
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(1000 * attempt);
    try {
      log(`Reconnect attempt ${attempt}/4...`);
      const ok = await bindToDevice();
      if (ok) {
        log('Reconnected.');
        // Resume exactly where the programme was (same segment, same speed);
        // don't re-run advanceSegment so the countdown/step index isn't reset.
        if (state.programme) {
          const seg = state.programme.segments[state.segmentIndex];
          if (seg) { setSpeedAssured(seg.speed_kmh); updateProgrammeUI(seg); }
          state.programmeTimer = setInterval(programmeTick, 1000);
        }
        return;
      }
    } catch (e) {
      log(`Reconnect attempt ${attempt} failed: ${e}`);
    }
  }
  log('Could not reconnect after 4 attempts. Giving up -- press Connect to try again.');
  if (state.sessionActive) finalizeSession();
  if (state.programme) cancelProgramme(false);
}

async function disconnect() {
  state.userInitiatedDisconnect = true;
  if (state.device && state.device.gatt.connected) {
    state.device.gatt.disconnect();
  } else {
    onDisconnected();
  }
}

// All BLE writes funnel through this single queue so nothing is ever sent
// while a previous write is still settling. Sending two GATT operations at
// once (e.g. the poll loop firing while a programme's Start/Set-speed write
// is also going out) is a well-known cause of "GATT operation already in
// progress" errors on Android, which can knock the whole connection over --
// this was the most likely cause of disconnects when starting a programme,
// since that's the moment several writes land close together.
let writeQueue = Promise.resolve();
function send(frame) {
  const job = writeQueue.then(async () => {
    if (!state.writeChar) { log('Send skipped: not connected'); return; }
    try {
      if (state.writeChar.properties.writeWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(frame);
      } else {
        await state.writeChar.writeValue(frame);
      }
    } catch (e) {
      log(`Write error (${P.toHex(frame)}): ${e}`);
      throw e;
    } finally {
      await sleep(30); // give the BLE stack a beat before the next operation
    }
  });
  writeQueue = job.catch(() => {}); // keep the chain alive even if this write failed
  return job;
}

function onNotify(event) {
  const data = new Uint8Array(event.target.value.buffer);
  const body = P.parseFrame(data);
  if (!body) return;
  const status = P.parseStatus(body);
  if (!status) return;
  updateStatusUI(status);
  trackSession(status);
}

function trackSession(status) {
  if (status.mode === 3) { // walking
    if (!state.sessionActive) {
      state.sessionActive = true;
      state.sessionDate = todayStr();
    }
    if (status.distanceM != null) state.lastDistanceM = status.distanceM;
    if (status.calories != null) state.lastCalories = status.calories;
    if (status.timeSeconds != null) state.lastTimeS = status.timeSeconds;
  } else if (status.mode === 0 && state.sessionActive) {
    finalizeSession();
  }
  const wasRunning = state.running;
  state.running = (status.mode === 3);
  if (wasRunning !== state.running) syncWatchPlaybackState();
}

// A mini walking pad tops out well under this -- your programmes only ever
// go up to 7.5 km/h. Anything reporting faster than this is a corrupted BLE
// read (a garbled distance or time byte), not a real walk.
const MAX_PLAUSIBLE_SPEED_KMH = 15;
// Sessions shorter than this are almost always a brief mode-flicker on the
// pad's telemetry, not an intentional walk.
const MIN_SESSION_S = 8;

function finalizeSession() {
  if (state.lastTimeS > 0) {
    const avgSpeed = (state.lastDistanceM / 1000) / (state.lastTimeS / 3600);
    if (state.lastTimeS < MIN_SESSION_S) {
      log(`Session discarded: only ${state.lastTimeS}s -- too short to be a real walk, likely a telemetry blip.`);
    } else if (avgSpeed > MAX_PLAUSIBLE_SPEED_KMH) {
      log(`Session discarded: reported ${avgSpeed.toFixed(1)} km/h average -- not physically possible on this pad, likely a corrupted Bluetooth reading. (${state.lastDistanceM}m in ${state.lastTimeS}s)`);
    } else {
      saveHistorySession(state.sessionDate, state.lastDistanceM, state.lastCalories, state.lastTimeS, avgSpeed);
      log(`Session saved: ${state.lastDistanceM}m, ${state.lastCalories} kcal, ${state.lastTimeS}s`);
      renderHistory();
    }
  }
  state.sessionActive = false;
  state.sessionDate = null;
  state.lastDistanceM = 0;
  state.lastCalories = 0;
  state.lastTimeS = 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- UI wiring ------------------------------------------------------

function setStatus(text, connected) {
  $('deviceName').textContent = text;
  $('statusDot').classList.toggle('connected', !!connected);
  $('connectBtn').textContent = connected ? 'Disconnect' : 'Connect';
}

function updateStatusUI(status) {
  if (status.speedKmh != null) $('speedValue').textContent = status.speedKmh.toFixed(1);
  if (status.timeSeconds != null) $('statTime').textContent = formatTime(status.timeSeconds);
  if (status.distanceM != null) $('statDistance').textContent = (status.distanceM / 1000).toFixed(2) + ' km';
  if (status.calories != null) $('statCalories').textContent = Math.round(status.calories);
}

function renderHistory() {
  const data = loadHistory();
  const today = todayStr();
  const byDate = {};
  data.sessions.forEach(s => {
    if (!byDate[s.date]) byDate[s.date] = { distance_m: 0, calories: 0, duration_s: 0 };
    byDate[s.date].distance_m += s.distance_m;
    byDate[s.date].calories += s.calories;
    byDate[s.date].duration_s += s.duration_s;
  });
  const t = byDate[today] || { distance_m: 0, calories: 0, duration_s: 0 };
  $('todayDistance').textContent = (t.distance_m / 1000).toFixed(2) + ' km';
  $('todayTime').textContent = formatTime(t.duration_s);
  $('todayCalories').textContent = Math.round(t.calories);

  const dates = Object.keys(byDate).filter(d => d !== today).sort().reverse().slice(0, 5);
  const list = $('historyList');
  if (dates.length === 0) {
    list.innerHTML = '<div class="empty-note">No previous days yet</div>';
    return;
  }
  list.innerHTML = dates.map(d => {
    const s = byDate[d];
    const label = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="history-row"><div class="history-date">${label}</div>
      <div class="history-figs">${(s.distance_m / 1000).toFixed(2)} km &middot; ${formatTime(s.duration_s)} &middot; ${Math.round(s.calories)} kcal</div></div>`;
  }).join('');
}

function highlightChip() {
  const target = parseFloat($('speedValue').textContent);
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', Math.abs(parseFloat(c.dataset.speed) - target) < 0.05);
  });
}

// ---- Buttons ----------------------------------------------------------

$('connectBtn').addEventListener('click', () => {
  if (state.connected) disconnect(); else connect();
});
$('startBtn').addEventListener('click', () => {
  state.isPaused = false;
  $('pauseBtn').textContent = 'Pause';
  send(P.cmdStart()).catch(() => {});
});
$('stopBtn').addEventListener('click', () => {
  state.isPaused = false;
  $('pauseBtn').textContent = 'Pause';
  cancelProgramme(false);
  send(P.cmdStop()).catch(() => {});
});

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const kmh = parseFloat(chip.dataset.speed);
    setSpeedAssured(kmh);
  });
});

$('nudgeDown').addEventListener('click', () => {
  const cur = parseFloat($('speedValue').textContent) || 0;
  send(P.cmdSetSpeed(Math.max(0, cur - 0.5))).catch(() => {});
});
$('nudgeUp').addEventListener('click', () => {
  const cur = parseFloat($('speedValue').textContent) || 0;
  send(P.cmdSetSpeed(cur + 0.5)).catch(() => {});
});

// ---- Video panel (YouTube, same idea as the desktop app) --------------

function loadVideo(url) {
  const idMatch = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  const frame = $('videoFrame');
  if (!idMatch) {
    frame.innerHTML = '<div class="video-placeholder">Paste a valid YouTube link</div>';
    return;
  }
  frame.innerHTML = `<iframe src="https://www.youtube.com/embed/${idMatch[1]}?autoplay=0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  localStorage.setItem(VIDEO_KEY, url);
}

$('browseYoutubeBtn').addEventListener('click', () => {
  window.open('https://www.youtube.com', '_blank');
});

$('loadVideoBtn').addEventListener('click', () => loadVideo($('videoUrlInput').value.trim()));
$('videoUrlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideo(e.target.value.trim()); });

const savedVideo = localStorage.getItem(VIDEO_KEY);
if (savedVideo) { $('videoUrlInput').value = savedVideo; loadVideo(savedVideo); }

// ---- Spoken encouragement (male voice), same idea as the desktop app ---

let encouragingVoice = null;
function initEncouragingVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  encouragingVoice = voices.find(v => v.lang.startsWith('en') && (
    v.name.includes('Male') || v.name.includes('George') || v.name.includes('Oliver') ||
    v.name.includes('Daniel') || v.name.includes('UK English')
  )) || voices.find(v => v.lang === 'en-GB') || voices[0] || null;
}
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = initEncouragingVoice;
  initEncouragingVoice();
}

function speakEncouragement(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (encouragingVoice) utterance.voice = encouragingVoice;
  utterance.lang = 'en-GB';
  utterance.pitch = 0.95;
  utterance.rate = 1.0;
  window.speechSynthesis.speak(utterance);
}

const MOTIVATIONAL_QUOTES = [
  'Great work! Keep up the momentum.',
  'Excellent effort! You are doing brilliant.',
  'Stay focused! You are mastering this stage.',
  'Fantastic pace! Keep pushing forward.',
  'Superb job! Stay strong and keep moving.',
];

// ---- Programmes ---------------------------------------------------------

function renderProgrammeList() {
  const programmes = window.WalkPadProgrammes || [];
  const list = $('programmeOverlayList');

  list.innerHTML = programmes.map((p, i) => {
    const totalMin = Math.round(p.segments.reduce((s, seg) => s + seg.duration_s, 0) / 60);
    const speeds = p.segments.map(s => s.speed_kmh);
    const range = `${Math.min(...speeds)}\u2013${Math.max(...speeds)} km/h`;
    return `<div class="prog-card" data-idx="${i}">
      <div class="prog-num">${i + 1}</div>
      <div class="prog-body">
        <div class="prog-name">${p.name}</div>
        <div class="prog-desc">${p.desc}</div>
        <div class="prog-steps">${p.segments.length} steps &middot; ${totalMin} min &middot; ${range}</div>
      </div>
      <div class="chev">&rsaquo;</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.prog-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.idx, 10);
      closeProgrammeOverlay();
      startProgramme(idx); // same page, same JS context -- the BLE connection is untouched
    });
  });

  $('browseProgrammesBtn').addEventListener('click', openProgrammeOverlay);
  $('closeOverlayBtn').addEventListener('click', closeProgrammeOverlay);
}

function openProgrammeOverlay() { $('programmeOverlay').classList.add('open'); }
function closeProgrammeOverlay() { $('programmeOverlay').classList.remove('open'); }

function requireConnected() {
  if (state.connected && state.writeChar) return true;
  log('Not connected -- tap Connect first, then choose a programme.');
  alert("You're not connected to the walking pad yet. Tap Connect at the top, then pick a programme.");
  return false;
}

function startProgramme(idx) {
  const programmes = window.WalkPadProgrammes || [];
  const p = programmes[idx];
  if (!p) return;
  if (!requireConnected()) return;
  cancelProgramme(); // stop anything already running
  state.programme = p;
  state.programmeIdx = idx;
  state.segmentIndex = -1;
  state.isPaused = false;
  $('pauseBtn').textContent = 'Pause';
  $('lastProgrammeNote').textContent = `Running: ${idx + 1}. ${p.name}`;
  send(P.cmdStart()).catch(() => {});
  speakEncouragement(`Starting programme ${p.name}. Let's begin.`);
  // The pad spins its belt up at its own default (1.0 km/h) and ignores a
  // set-speed sent in the same instant as Start -- which is why the first
  // segment used to run at 1 instead of its target. Give the pad a moment
  // to leave its start-up state before setting the first speed.
  setTimeout(() => {
    if (state.programme === p) advanceSegment();
  }, 1800);
  state.programmeTimer = setInterval(programmeTick, 1000);
  $('programInfoBox').style.display = 'block';
  $('programTitleLine').textContent = `Programme ${idx + 1}: ${p.name}`;
  $('programStepLine').textContent = 'Starting up...';
  $('programTimeLine').textContent = '--:--';
}

/** Send a speed and re-assert it if the pad's telemetry shows it didn't take.
 *  The pad can silently drop a set-speed during belt spin-up or right after a
 *  mode change, so we verify against the reported speed and retry a few times. */
function setSpeedAssured(targetKmh, attempt = 0) {
  state.targetSpeed = targetKmh;
  send(P.cmdSetSpeed(targetKmh)).catch(() => {});
  if (attempt >= 4) return;
  setTimeout(() => {
    // Only keep retrying while this is still the speed we want.
    if (state.targetSpeed !== targetKmh) return;
    if (state.isPaused) return;
    const reported = parseFloat($('speedValue').textContent) || 0;
    if (Math.abs(reported - targetKmh) > 0.15) {
      log(`Speed didn't take (showing ${reported}, want ${targetKmh}) -- resending.`);
      setSpeedAssured(targetKmh, attempt + 1);
    }
  }, 1200);
}

function advanceSegment() {
  state.segmentIndex += 1;
  const seg = state.programme.segments[state.segmentIndex];
  if (!seg) { cancelProgramme(true); return; }
  state.segmentRemaining = seg.duration_s;
  setSpeedAssured(seg.speed_kmh);
  updateProgrammeUI(seg);
  if (state.segmentIndex > 0) {
    const quote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
    speakEncouragement(`${quote} Now starting ${seg.label} at ${seg.speed_kmh} kilometers per hour.`);
  } else {
    speakEncouragement(`First stage: ${seg.label} at ${seg.speed_kmh} kilometers per hour.`);
  }
}

function programmeTick() {
  if (!state.programme || state.isPaused) return;
  if (state.segmentIndex < 0) return; // still in the start-up delay
  state.segmentRemaining -= 1;
  if (state.segmentRemaining <= 0) {
    advanceSegment();
  } else {
    updateProgrammeUI(state.programme.segments[state.segmentIndex]);
  }
}

function updateProgrammeUI(seg) {
  $('programTitleLine').textContent = `Programme ${state.programmeIdx + 1}: ${state.programme.name}`;
  $('programStepLine').textContent = `Step ${state.segmentIndex + 1}/${state.programme.segments.length}: ${seg.label} (${seg.speed_kmh} km/h)`;
  $('programTimeLine').textContent = formatTime(state.segmentRemaining);
}

function cancelProgramme(finished) {
  if (state.programmeTimer) clearInterval(state.programmeTimer);
  state.programmeTimer = null;
  if (state.programme) {
    send(P.cmdStop()).catch(() => {});
    if (finished) speakEncouragement('Congratulations! Workout complete.');
    log(finished ? `Programme "${state.programme.name}" finished` : `Programme "${state.programme.name}" cancelled`);
  }
  state.programme = null;
  state.programmeIdx = -1;
  state.segmentIndex = -1;
  state.isPaused = false;
  state.targetSpeed = null;
  $('pauseBtn').textContent = 'Pause';
  $('programInfoBox').style.display = 'none';
}

$('cancelProgrammeBtn').addEventListener('click', () => cancelProgramme(false));

// ---- Pause / resume (works during a manual walk or a running programme) --

function togglePause() {
  if (!state.running && !state.programme) return;
  if (!state.isPaused) {
    state.isPaused = true;
    state.prePauseSpeed = (parseFloat($('speedValue').textContent) || 0) > 0
      ? parseFloat($('speedValue').textContent) : 3.0;
    $('pauseBtn').textContent = 'Resume';
    speakEncouragement('Walking pad paused.');
    send(P.cmdSetSpeed(0)).catch(() => {});
  } else {
    state.isPaused = false;
    $('pauseBtn').textContent = 'Pause';
    speakEncouragement('Resuming workout.');
    send(P.cmdSetSpeed(state.prePauseSpeed)).catch(() => {});
  }
  syncWatchPlaybackState();
}
$('pauseBtn').addEventListener('click', togglePause);


// ---- Voice control --------------------------------------------------

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

function setupVoice() {
  if (!SpeechRecognitionImpl) {
    $('voiceBtn').textContent = 'Voice unsupported';
    $('voiceBtn').disabled = true;
    log('Speech recognition is not supported in this browser -- voice control is unavailable here. Chrome for Android usually supports it; if it does not work, the on-screen controls still do.');
    return;
  }
  recognizer = new SpeechRecognitionImpl();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = 'en-GB';

  recognizer.onresult = (event) => {
    const said = event.results[event.results.length - 1][0].transcript.trim().toLowerCase();
    log('Heard: "' + said + '"');
    handleVoiceCommand(said);
  };
  recognizer.onerror = (event) => {
    // 'no-speech' fires constantly during normal silent gaps -- not worth logging every time.
    if (event.error !== 'no-speech') log('Voice recognition error: ' + event.error);
  };
  recognizer.onend = () => {
    // Android doesn't actually honour continuous:true -- it silently ends
    // recognition every few seconds of silence, and restarting it re-claims
    // the microphone, which (a) plays Android's own "listening started" tone
    // and (b) briefly interrupts other audio. Restarting instantly turned
    // that into a near-constant bleep and made video playback stutter.
    // Waiting a beat between restarts gives the audio system a moment to
    // settle and cuts the tone/stutter down to an occasional blip instead
    // of a loop.
    if (state.voiceRestartTimer) clearTimeout(state.voiceRestartTimer);
    if (state.listening) {
      state.voiceRestartTimer = setTimeout(() => {
        if (state.listening) { try { recognizer.start(); } catch (e) {} }
      }, 700);
    }
  };
}

function toggleVoice() {
  if (!recognizer) return;
  state.listening = !state.listening;
  $('voiceBtn').classList.toggle('active', state.listening);
  $('voiceBtn').textContent = state.listening ? 'Voice: On' : 'Voice: Off';
  if (state.listening) {
    try { recognizer.start(); log('Voice control on -- try "start", "stop", "faster", "slower", "speed five", "programme one".'); }
    catch (e) { log('Could not start voice recognition: ' + e); }
  } else {
    if (state.voiceRestartTimer) { clearTimeout(state.voiceRestartTimer); state.voiceRestartTimer = null; }
    try { recognizer.stop(); } catch (e) {}
  }
}

function handleVoiceCommand(said) {
  if (/\bstop programme\b|\bcancel programme\b/.test(said)) {
    cancelProgramme(false); return;
  }
  if (/\b(start|begin|go)\b/.test(said) && !/programme/.test(said)) {
    send(P.cmdStart()).catch(() => {}); return;
  }
  if (/\b(stop|halt|pause)\b/.test(said)) {
    send(P.cmdStop()).catch(() => {}); return;
  }
  if (/faster|speed up/.test(said)) {
    const cur = parseFloat($('speedValue').textContent) || 0;
    send(P.cmdSetSpeed(cur + 0.5)).catch(() => {}); return;
  }
  if (/slower|slow down/.test(said)) {
    const cur = parseFloat($('speedValue').textContent) || 0;
    send(P.cmdSetSpeed(Math.max(0, cur - 0.5))).catch(() => {}); return;
  }
  const speedMatch = said.match(/speed\s+(?:to\s+)?([a-z0-9.]+)/);
  if (speedMatch) {
    const kmh = wordsToNumber(speedMatch[1]);
    if (kmh != null) { send(P.cmdSetSpeed(kmh)).catch(() => {}); return; }
  }
  const programmeMatch = said.match(/programme\s+(?:number\s+)?([a-z0-9]+)/);
  if (programmeMatch) {
    const n = wordsToNumber(programmeMatch[1]);
    if (n != null) { startProgramme(Math.round(n) - 1); return; }
  }
}

const NUMBER_WORDS = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
function wordsToNumber(token) {
  if (NUMBER_WORDS.hasOwnProperty(token)) return NUMBER_WORDS[token];
  const n = parseFloat(token);
  return isNaN(n) ? null : n;
}

$('voiceBtn').addEventListener('click', toggleVoice);
setupVoice();
renderProgrammeList();

// ---- Galaxy Watch control via the Media Session API --------------------
//
// There is no way for a watch app to talk directly to a web page. What DOES
// work: the phone exposes a media-notification session, the watch's media
// controls drive that session, and the Media Session API lets this page
// receive those button presses as action handlers.
//
// For the phone to consider this page a media source, something must
// actually be playing audio -- so we hold a silent looping audio track for
// as long as watch control is enabled.
//
// Mapping (watch media button -> pad action):
//   Play (>)          -> START the pad (or RESUME if paused)
//   Pause (||)        -> PAUSE the pad (belt to 0, programme countdown frozen)
//   Stop / Previous   -> STOP the pad and cancel any running programme
//
// NOTE: the watch shows the standard media icons for these -- a web page
// can't relabel that tile with the words "Start/Pause/Stop". Previous-track
// doubles as Stop because some media tiles don't render a dedicated stop
// button.
//
let watchAudio = null;
let watchControlOn = false;

function makeSilentLoop() {
  // A tiny silent WAV, looped. Keeps a media session alive without noise.
  // A genuinely silent 0.5s WAV -- the old one was ~0.045ms and looping it
  // that many thousands of times a second was a real source of audio
  // glitching on its own, on top of the speech-recognition restarts.
  const silentWav = 'data:audio/wav;base64,UklGRkZWAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YSJWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const a = new Audio(silentWav);
  a.loop = true;
  a.volume = 0.01;
  return a;
}

/** Keeps the watch's play/pause icon in step with what the pad is doing.
 *  'playing' makes the tile show a Pause button; 'paused' shows Play. */
function syncWatchPlaybackState() {
  if (!watchControlOn || !('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState =
    (state.running && !state.isPaused) ? 'playing' : 'paused';
}

async function toggleWatchControl() {
  if (!('mediaSession' in navigator)) {
    log('This browser has no Media Session support, so watch control is unavailable here.');
    return;
  }
  watchControlOn = !watchControlOn;
  $('watchBtn').classList.toggle('active', watchControlOn);
  $('watchBtn').textContent = watchControlOn ? 'Watch: On' : 'Watch';

  if (!watchControlOn) {
    if (watchAudio) { watchAudio.pause(); watchAudio = null; }
    navigator.mediaSession.playbackState = 'none';
    log('Watch control off.');
    return;
  }

  try {
    watchAudio = makeSilentLoop();
    await watchAudio.play();
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Walking Pad',
      artist: 'Play = Start | Pause = Pause | Prev = Stop',
      album: "Nigel's Walking Pad",
      artwork: [{ src: 'icon.svg', sizes: '192x192', type: 'image/svg+xml' }],
    });

    // Play -> Start the pad, or Resume if we're mid-pause.
    navigator.mediaSession.setActionHandler('play', () => {
      if (state.isPaused) {
        togglePause();              // resumes and restores the pre-pause speed
      } else {
        state.isPaused = false;
        $('pauseBtn').textContent = 'Pause';
        send(P.cmdStart()).catch(() => {});
        speakEncouragement('Starting.');
      }
      syncWatchPlaybackState();
    });

    // Pause -> pause the belt, freezing any programme countdown.
    navigator.mediaSession.setActionHandler('pause', () => {
      if (!state.isPaused) togglePause();
      syncWatchPlaybackState();
    });

    // Stop -> full stop, cancelling any running programme.
    const doStop = () => {
      if (state.programme) cancelProgramme(false);
      state.isPaused = false;
      $('pauseBtn').textContent = 'Pause';
      send(P.cmdStop()).catch(() => {});
      speakEncouragement('Stopped.');
      syncWatchPlaybackState();
    };
    navigator.mediaSession.setActionHandler('stop', doStop);
    navigator.mediaSession.setActionHandler('previoustrack', doStop);
    // Left unassigned so a stray swipe can't change anything unexpectedly.
    navigator.mediaSession.setActionHandler('nexttrack', null);

    syncWatchPlaybackState();
    log('Watch control on. On your Watch 4, open the Media tile -- ' +
        'Play = Start, Pause = Pause, Previous = Stop.');
    speakEncouragement('Watch control enabled.');
  } catch (e) {
    log('Could not start watch control: ' + e + ' -- tap the button again after interacting with the page.');
    watchControlOn = false;
    $('watchBtn').classList.remove('active');
    $('watchBtn').textContent = 'Watch';
  }
}

$('watchBtn').addEventListener('click', toggleWatchControl);

// ---- Dashboard link + init ---------------------------------------------

$('dashboardBtn').addEventListener('click', () => { window.location.href = 'dashboard.html'; });

const storedServices = localStorage.getItem(SERVICES_KEY);
$('serviceUuidInput').placeholder = (storedServices ? JSON.parse(storedServices) : DEFAULT_SERVICE_GUESSES).join(', ');

renderHistory();
setInterval(renderHistory, 5000); // keeps "today" totals live even before a session ends
requestWakeLock();
