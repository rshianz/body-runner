import { Game } from './game.js';
import { Renderer } from './render.js';
import { PoseTracker, POSE_EDGES } from './pose.js';
import { BodyReader } from './body.js';
import { InputController } from './input.js';
import { AudioEngine } from './audio.js';
import { clamp, formatScore } from './util.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  stage: $('stage'),
  camera: $('camera'),
  hud: $('hud'),
  hudScore: $('hudScore'),
  hudBest: $('hudBest'),
  hudDist: $('hudDist'),
  hudHearts: $('hudHearts'),
  hudMult: $('hudMult'),
  hudPowerFill: $('hudPowerFill'),
  hudPowerLabel: $('hudPowerLabel'),
  hudCombo: $('hudCombo'),
  camPanel: $('camPanel'),
  camPreview: $('camPreview'),
  poseDot: $('poseDot'),
  poseLabel: $('poseLabel'),
  poseStats: $('poseStats'),
  hintBar: $('hintBar'),

  screenIntro: $('screenIntro'),
  screenCalibrate: $('screenCalibrate'),
  screenPause: $('screenPause'),
  screenGameover: $('screenGameover'),

  introPreview: $('introPreview'),
  introPreviewEmpty: $('introPreviewEmpty'),
  introStatus: $('introStatus'),
  cameraBadge: $('cameraBadge'),
  btnCamera: $('btnCamera'),
  btnKeyboard: $('btnKeyboard'),

  sensSlider: $('sensSlider'),
  sensValue: $('sensValue'),
  btnMute: $('btnMute'),
  muteLabel: $('muteLabel'),

  calibPreview: $('calibPreview'),
  calibTitle: $('calibTitle'),
  calibStatus: $('calibStatus'),
  calibCount: $('calibCount'),
  calibBarFill: $('calibBarFill'),
  calibScan: $('calibScan'),
  calibHint: $('calibHint'),
  btnCalibCancel: $('btnCalibCancel'),
  btnCalibReady: $('btnCalibReady'),

  btnResume: $('btnResume'),
  btnQuit: $('btnQuit'),

  goScore: $('goScore'),
  goBestBadge: $('goBestBadge'),
  goDist: $('goDist'),
  goOrbs: $('goOrbs'),
  goCombo: $('goCombo'),
  goTime: $('goTime'),
  goEyebrow: $('goEyebrow'),
  goTitle: $('goTitle'),
  goTip: $('goTip'),
  btnRestart: $('btnRestart'),
  btnMenu: $('btnMenu'),

  loading: $('loading'),
  loadingTitle: $('loadingTitle'),
  loadingDetail: $('loadingDetail'),
  btnLoadingCancel: $('btnLoadingCancel'),
  toast: $('toast'),
};

const game = new Game();
const renderer = new Renderer(el.stage);
const audio = new AudioEngine();
const input = new InputController();
const body = new BodyReader();
const tracker = new PoseTracker(el.camera, {
  onFrame: handlePoseFrame,
  onStatus: (text) => setLoading(el.loadingTitle.textContent, text),
});

let mode = 'intro';
let rafId = 0;
let lastFrame = performance.now();
let lastHudUpdate = 0;
let lastHudLives = -1;
let cameraOn = false;
let poseMode = false;
let modelQuality = null;
let latestLandmarks = null;
let poseStats = { inferenceMs: 0, fps: 0, delegate: '—' };
let previewTimer = 0;
let calibGeneration = 0;
let calibTimers = [];
let cameraFlowGeneration = 0;
let gameOverTimer = 0;
let hintTimer = 0;
let toastTimer = 0;
let quality = 'accurate';

const screens = {
  intro: el.screenIntro,
  calibrate: el.screenCalibrate,
  pause: el.screenPause,
  gameover: el.screenGameover,
};

// ---------------------------------------------------------------------------
// Mode & screens
// ---------------------------------------------------------------------------

function setMode(next) {
  mode = next;
  el.app.dataset.mode = next;
}

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.hidden = key !== name;
  }
}

function setHudVisible(visible) {
  el.hud.hidden = !visible;
}

function setLoading(title, detail) {
  el.loadingTitle.textContent = title;
  if (detail) el.loadingDetail.textContent = detail;
}

function toast(message, duration = 3800) {
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), duration);
}

// ---------------------------------------------------------------------------
// Pose plumbing
// ---------------------------------------------------------------------------

function handlePoseFrame({ landmarks, inferenceMs, fps, delegate }) {
  latestLandmarks = landmarks;
  poseStats = { inferenceMs, fps, delegate };

  const aspect = el.camera.videoWidth ? el.camera.videoWidth / el.camera.videoHeight : 4 / 3;
  const metrics = body.update(landmarks, performance.now(), aspect);
  input.applyPose(metrics);

  if (mode === 'calibrate') updateCalibrationProgress(metrics);
}

function updateCalibrationProgress(metrics) {
  // The completion frame arrives as `active` flips to false, so handle it first.
  if (metrics.calibrationComplete) {
    finishCalibration();
    return;
  }
  if (!body.calibration.active) return;
  const pct = Math.round(metrics.progress * 100);
  el.calibBarFill.style.width = `${pct}%`;
  if (metrics.valid) {
    el.calibHint.textContent = 'Capturing stance…';
    el.calibStatus.textContent = 'Hold still — building your body baseline.';
  } else {
    el.calibHint.textContent = 'No body detected — step back into frame';
    el.calibStatus.textContent = 'Waiting for your whole body to be visible.';
  }
}

// ---------------------------------------------------------------------------
// Camera flow
// ---------------------------------------------------------------------------

async function startCameraFlow() {
  if (mode === 'loading' && !el.loading.hidden) return;
  audio.ensure();
  audio.play('ui');
  clearCalibTimers();
  const generation = ++cameraFlowGeneration;
  setMode('loading');
  showScreen(null);
  setHudVisible(false);
  el.loading.hidden = false;
  setLoading('Warming up', 'Requesting camera…');

  try {
    await tracker.startCamera();
    if (generation !== cameraFlowGeneration) return;
    cameraOn = true;

    if (!tracker.landmarker || modelQuality !== quality) {
      setLoading('Loading body tracking', 'First run downloads the pose model…');
      await tracker.loadModel(quality);
      if (generation !== cameraFlowGeneration) return;
      modelQuality = quality;
    }

    setLoading('Warming up', 'Preparing the tracker…');
    // Let the loading state paint before the (brief) synchronous warm-up.
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (generation !== cameraFlowGeneration) return;
    tracker.warmup();
    tracker.setPaused(false);
    tracker.start();

    el.loading.hidden = true;
    el.introPreviewEmpty.classList.add('is-hidden');
    el.cameraBadge.textContent = 'LIVE';
    el.cameraBadge.classList.add('is-live');

    beginCalibration({ quick: false });
  } catch (error) {
    if (generation !== cameraFlowGeneration) return;
    console.error('[body-runner] camera setup failed', error);
    el.loading.hidden = true;
    cameraOn = Boolean(tracker.stream);
    // Stop first: it resets the intro copy to the standby defaults.
    stopCameraSession();
    setMode('intro');
    showScreen('intro');
    setHudVisible(false);
    el.cameraBadge.textContent = 'BLOCKED';
    el.cameraBadge.classList.remove('is-live');
    el.introStatus.textContent = cameraErrorMessage(error);
    toast('Camera unavailable — you can still play with the keyboard.', 5200);
  }
}

function cancelCameraSetup() {
  cameraFlowGeneration += 1;
  clearCalibTimers();
  el.loading.hidden = true;
  tracker.cancelCamera();
  stopCameraSession();
  setMode('intro');
  showScreen('intro');
  setHudVisible(false);
  toast('Camera setup cancelled. Keyboard play is ready to go.', 3600);
}

function cameraErrorMessage(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was denied. Allow it in your browser, or play with the keyboard.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable camera was found. Connect one, or play with the keyboard.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is busy in another app. Close it and try again.';
  }
  if (name === 'TimeoutError') {
    return 'The camera did not start. Check for a permission prompt, then try again.';
  }
  if (name === 'AbortError') {
    return 'Camera setup was interrupted. Try again when you are ready.';
  }
  if (name === 'TypeError' || /secure/i.test(String(error && error.message))) {
    return 'Camera access needs localhost or HTTPS. Play with the keyboard instead.';
  }
  return 'The tracking engine could not start. Check your connection and try again.';
}

function stopCameraSession() {
  clearCalibTimers();
  calibGeneration += 1;
  body.cancelCalibration();
  input.markPoseLost();
  try {
    tracker.cancelCamera();
  } catch {
    /* already stopped */
  }
  cameraOn = false;
  poseMode = false;
  latestLandmarks = null;
  el.introPreviewEmpty.classList.remove('is-hidden');
  el.cameraBadge.textContent = 'STANDBY';
  el.cameraBadge.classList.remove('is-live');
  el.introStatus.textContent =
    'Stand two to three metres back so your whole body is in frame.';
  el.hud.hidden = true;
  el.camPanel.hidden = true;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

function enterCalibration({ quick }) {
  calibGeneration += 1;
  clearCalibTimers();
  game.reset();
  game.mode = 'ambient';
  setMode('calibrate');
  showScreen('calibrate');
  setHudVisible(false);
  el.calibPreview.getContext('2d').clearRect(0, 0, 480, 360);
  el.calibCount.textContent = quick ? '2' : '3';
  el.calibCount.classList.remove('is-hidden');
  el.calibScan.classList.remove('is-on');
  el.calibBarFill.style.width = '0%';
  el.btnCalibReady.hidden = false;
  el.calibTitle.textContent = quick ? 'Quick reset' : 'Step into frame';
  el.calibStatus.textContent = quick
    ? 'Stand tall again for a two-second recharge.'
    : 'Fit your head and both feet in the preview, then hold still.';
  el.calibHint.textContent = 'Whole body in frame';
  tracker.setPaused(false);
}

function beginCalibration({ quick }) {
  enterCalibration({ quick });
  const gen = calibGeneration;
  const steps = quick ? [2, 1] : [3, 2, 1];
  let index = 0;

  const tick = () => {
    if (gen !== calibGeneration || mode !== 'calibrate') return;
    if (index < steps.length) {
      el.calibCount.textContent = String(steps[index]);
      // Re-trigger the pop animation by alternating the hidden class.
      el.calibCount.classList.remove('is-hidden');
      audio.play('count');
      index += 1;
      calibTimers.push(setTimeout(tick, 700));
    } else {
      captureStance();
    }
  };
  tick();
}

function captureStance() {
  if (mode !== 'calibrate' || body.calibration.active) return;
  clearCalibTimers();
  body.beginCalibration();
  el.calibCount.classList.add('is-hidden');
  el.calibScan.classList.add('is-on');
  el.btnCalibReady.hidden = true;
  el.calibTitle.textContent = 'Hold that stance';
  el.calibStatus.textContent = 'Capturing your standing baseline…';
  el.calibHint.textContent = 'Stand tall, arms relaxed';
  el.calibBarFill.style.width = '0%';
}

function finishCalibration() {
  if (mode !== 'calibrate') return;
  calibGeneration += 1;
  clearCalibTimers();
  el.calibBarFill.style.width = '100%';
  audio.play('go');
  poseMode = true;
  input.setMode('pose');
  startRun();
}

function clearCalibTimers() {
  for (const id of calibTimers) clearTimeout(id);
  calibTimers = [];
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function startRun() {
  game.startRun();
  renderer.particles.length = 0;
  renderer.popups.length = 0;
  renderer.shakeAmount = 0;
  input.reset();
  input.enabled = true;
  input.setMode(poseMode ? 'pose' : 'keyboard');
  lastHudLives = -1;
  lastHudUpdate = 0;
  setMode('playing');
  showScreen(null);
  setHudVisible(true);
  el.camPanel.hidden = !poseMode;
  updateHud(performance.now(), true);
  el.hintBar.classList.remove('is-hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.hintBar.classList.add('is-hidden'), 7000);
}

function startKeyboardRun() {
  audio.ensure();
  audio.play('ui');
  if (cameraOn) stopCameraSession();
  poseMode = false;
  cameraOn = false;
  body.calibration.complete = false;
  body.baseline = null;
  input.setMode('keyboard');
  startRun();
  toast('Keyboard mode — arrows to move, ↑ jump, ↓ slide, P pause.', 4200);
}

function pauseRun() {
  if (mode !== 'playing') return;
  setMode('paused');
  showScreen('pause');
  input.enabled = false;
  tracker.setPaused(true);
}

function resumeRun() {
  if (mode !== 'paused') return;
  setMode('playing');
  showScreen(null);
  input.enabled = true;
  lastFrame = performance.now();
  if (cameraOn) tracker.setPaused(false);
}

function scheduleGameOver() {
  if (mode !== 'playing') return;
  setMode('dying');
  input.enabled = false;
  tracker.setPaused(true);
  clearTimeout(gameOverTimer);
  gameOverTimer = setTimeout(showGameOver, 900);
}

function showGameOver() {
  if (mode !== 'gameover' && mode !== 'dying') return;
  setMode('gameover');
  showScreen('gameover');
  setHudVisible(false);
  el.goScore.textContent = formatScore(game.score);
  el.goBestBadge.hidden = !game.isBest;
  el.goDist.textContent = `${Math.round(game.distance)} m`;
  el.goOrbs.textContent = String(game.orbs);
  el.goCombo.textContent = String(game.bestCombo);
  el.goTime.textContent = formatTime(game.time);
  el.goEyebrow.textContent = game.isBest ? 'PERSONAL BEST' : 'RUN COMPLETE';
  el.goTitle.textContent = game.isBest ? 'You beat your record' : 'Out of lives';
  el.goTip.innerHTML = cameraOn
    ? 'Press <kbd>R</kbd> to run again with a quick reset'
    : 'Press <kbd>R</kbd> to restart';
  audio.play('ui');
}

function restartRun() {
  if (mode !== 'gameover') return;
  audio.ensure();
  audio.play('ui');
  if (cameraOn) {
    poseMode = true;
    input.setMode('pose');
    beginCalibration({ quick: true });
  } else {
    startKeyboardRun();
  }
}

function quitToMenu() {
  clearTimeout(gameOverTimer);
  clearCalibTimers();
  calibGeneration += 1;
  stopCameraSession();
  game.reset();
  game.mode = 'ambient';
  input.enabled = false;
  input.markPoseLost();
  setMode('intro');
  showScreen('intro');
  setHudVisible(false);
  el.hintBar.classList.add('is-hidden');
  lastHudLives = -1;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function updateHud(now, force = false) {
  if (!force && now - lastHudUpdate < 90) return;
  lastHudUpdate = now;

  el.hudScore.textContent = formatScore(game.score);
  el.hudBest.textContent = formatScore(Math.max(game.best, game.score));
  el.hudDist.textContent = `${Math.round(game.distance)} m`;
  el.hudMult.textContent = `×${(Math.round(game.mult * 10) / 10).toFixed(1)}`;

  const power = clamp(game.power, 0, 1);
  el.hudPowerFill.style.transform = `scaleX(${power})`;
  el.hudPowerLabel.textContent = `${Math.round(power * 100)}%`;

  if (game.hearts !== lastHudLives) {
    let html = '';
    for (let i = 0; i < game.maxHearts; i += 1) {
      html += `<span class="heart${i < game.hearts ? '' : ' is-empty'}">♥</span>`;
    }
    el.hudHearts.innerHTML = html;
    lastHudLives = game.hearts;
  }

  if (game.combo >= 4) {
    el.hudCombo.textContent = `COMBO ×${game.combo}`;
    el.hudCombo.classList.add('is-on');
  } else {
    el.hudCombo.classList.remove('is-on');
  }
}

function updatePosePanel() {
  if (!poseMode || !cameraOn) {
    el.camPanel.hidden = true;
    return;
  }
  el.camPanel.hidden = false;
  const poseAge = performance.now() - input.lastPoseAt;
  const fresh = input.poseConnected && poseAge < 600;
  el.poseDot.className = `dot ${fresh ? 'ok' : poseAge > 2200 ? 'bad' : 'warn'}`;
  el.poseLabel.textContent = fresh ? 'POSE LOCKED' : poseAge > 2200 ? 'STEP INTO FRAME' : 'NO POSE';
  const fps = Math.round(poseStats.fps || 0);
  const ms = Math.round(poseStats.inferenceMs || 0);
  el.poseStats.textContent = fresh ? `${fps} fps · ${ms} ms` : `${fps} fps`;
}

// ---------------------------------------------------------------------------
// Camera preview
// ---------------------------------------------------------------------------

function activePreviewCanvas() {
  if (!cameraOn) return null;
  if (mode === 'calibrate') return el.calibPreview;
  if (mode === 'intro') return el.introPreview;
  if (mode === 'playing' || mode === 'dying' || mode === 'paused') return el.camPreview;
  return null;
}

function drawCameraPreview() {
  const canvas = activePreviewCanvas();
  const video = el.camera;
  if (!canvas || !video.videoWidth) return;

  const ctx = canvas.getContext('2d');
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, cw, ch);

  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;

  ctx.save();
  // Mirror the feed so moving right on screen matches moving right physically.
  ctx.translate(cw, 0);
  ctx.scale(-1, 1);
  ctx.globalAlpha = 0.92;
  ctx.drawImage(video, dx, dy, dw, dh);
  ctx.globalAlpha = 1;

  if (latestLandmarks) {
    drawSkeleton(ctx, latestLandmarks, dx, dy, dw, dh, cw, ch);
  }
  ctx.restore();

  const vignette = ctx.createLinearGradient(0, ch * 0.55, 0, ch);
  vignette.addColorStop(0, 'rgba(4, 7, 16, 0)');
  vignette.addColorStop(1, 'rgba(4, 7, 16, 0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, ch * 0.55, cw, ch * 0.45);

  if (!latestLandmarks) {
    ctx.fillStyle = 'rgba(255, 215, 106, 0.9)';
    ctx.font = '600 11px "Space Grotesk", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SEARCHING FOR BODY…', cw / 2, ch - 14);
  }

  // corner brackets
  ctx.strokeStyle = 'rgba(95, 240, 216, 0.35)';
  ctx.lineWidth = 1.5;
  const pad = 10;
  const len = 14;
  ctx.beginPath();
  ctx.moveTo(pad, pad + len);
  ctx.lineTo(pad, pad);
  ctx.lineTo(pad + len, pad);
  ctx.moveTo(cw - pad - len, pad);
  ctx.lineTo(cw - pad, pad);
  ctx.lineTo(cw - pad, pad + len);
  ctx.moveTo(pad, ch - pad - len);
  ctx.lineTo(pad, ch - pad);
  ctx.lineTo(pad + len, ch - pad);
  ctx.moveTo(cw - pad - len, ch - pad);
  ctx.lineTo(cw - pad, ch - pad);
  ctx.lineTo(cw - pad, ch - pad - len);
  ctx.stroke();
}

function drawSkeleton(ctx, landmarks, dx, dy, dw, dh, cw, ch) {
  const point = (i) => {
    const l = landmarks[i];
    if (!l) return null;
    return { x: dx + l.x * dw, y: dy + l.y * dh, v: l.visibility == null ? 1 : l.visibility };
  };

  const leftJoints = new Set([11, 13, 15, 23, 25, 27, 29, 31]);
  const rightJoints = new Set([12, 14, 16, 24, 26, 28, 30, 32]);

  ctx.lineCap = 'round';
  for (const [a, b] of POSE_EDGES) {
    const pa = point(a);
    const pb = point(b);
    if (!pa || !pb) continue;
    if (pa.v < 0.25 || pb.v < 0.25) continue;
    const left = leftJoints.has(a) || leftJoints.has(b);
    const right = rightJoints.has(a) || rightJoints.has(b);
    let color = 'rgba(235, 248, 255, 0.85)';
    if (left && !right) color = 'rgba(95, 240, 216, 0.95)';
    else if (right && !left) color = 'rgba(160, 150, 255, 0.95)';

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, cw * 0.0055);
    ctx.shadowColor = color;
    ctx.shadowBlur = cw * 0.012;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  for (let i = 0; i < landmarks.length; i += 1) {
    if (i === 0) continue;
    const p = point(i);
    if (!p || p.v < 0.3) continue;
    const left = leftJoints.has(i);
    const right = rightJoints.has(i);
    ctx.fillStyle = left
      ? 'rgba(95, 240, 216, 0.95)'
      : right
        ? 'rgba(160, 150, 255, 0.95)'
        : 'rgba(235, 248, 255, 0.75)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.8, cw * 0.004), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function handleGameEvents(events) {
  for (const event of events) {
    if (event.type !== 'dodge') audio.play(event.type);
    renderer.onEvent(event, game);
    if (event.type === 'gameover') scheduleGameOver();
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function advance(dt) {
  if (mode === 'playing') {
    game.update(dt, input.snapshot());
    handleGameEvents(game.drainEvents());
    updateHud(performance.now());
    updatePosePanel();
  } else if (mode === 'dying') {
    game.update(dt, { lane: game.lane, jump: false, duck: false, power: 0 });
    handleGameEvents(game.drainEvents());
    updatePosePanel();
  } else if (mode === 'gameover') {
    game.update(dt, { lane: game.lane, jump: false, duck: false, power: 0 });
    handleGameEvents(game.drainEvents());
  } else if (mode === 'intro' || mode === 'calibrate' || mode === 'loading') {
    game.updateAmbient(dt);
  }

  if (mode !== 'paused') {
    renderer.draw(game, dt);
    previewTimer += dt;
    if (previewTimer >= 1 / 24) {
      previewTimer = 0;
      drawCameraPreview();
    }
  }
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000 || 0.016, 0.05);
  lastFrame = now;
  advance(dt);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

input.onPause = () => {
  if (mode === 'playing') pauseRun();
  else if (mode === 'paused') resumeRun();
};

el.btnCamera.addEventListener('click', startCameraFlow);
el.btnLoadingCancel.addEventListener('click', cancelCameraSetup);
el.btnKeyboard.addEventListener('click', startKeyboardRun);
el.btnCalibCancel.addEventListener('click', quitToMenu);
el.btnCalibReady.addEventListener('click', captureStance);
el.btnResume.addEventListener('click', resumeRun);
el.btnQuit.addEventListener('click', quitToMenu);
el.btnRestart.addEventListener('click', restartRun);
el.btnMenu.addEventListener('click', quitToMenu);

el.sensSlider.addEventListener('input', () => {
  const value = Number(el.sensSlider.value);
  body.sensitivity = value;
  el.sensValue.textContent = `${value.toFixed(1)}×`;
});

document.querySelectorAll('.seg[data-quality]').forEach((button) => {
  button.addEventListener('click', () => {
    quality = button.dataset.quality;
    document
      .querySelectorAll('.seg[data-quality]')
      .forEach((node) => node.classList.toggle('is-active', node === button));
    audio.play('ui');
    if (modelQuality && modelQuality !== quality) {
      toast('Tracking quality switches the next time the camera starts.', 3600);
    }
  });
});

function syncMuteUi() {
  el.btnMute.classList.toggle('is-muted', audio.muted);
  el.btnMute.setAttribute('aria-pressed', String(audio.muted));
  el.muteLabel.textContent = audio.muted ? 'Off' : 'On';
}

el.btnMute.addEventListener('click', () => {
  audio.ensure();
  audio.setMuted(!audio.muted);
  syncMuteUi();
  if (!audio.muted) audio.play('ui');
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && mode === 'loading') {
    event.preventDefault();
    cancelCameraSetup();
  } else if (event.code === 'KeyR' && mode === 'gameover') {
    event.preventDefault();
    restartRun();
  } else if (event.code === 'Enter' && mode === 'gameover') {
    event.preventDefault();
    restartRun();
  } else if (event.code === 'Escape' && mode === 'paused') {
    resumeRun();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'playing') pauseRun();
});

window.addEventListener('resize', () => {
  renderer.resize();
});

window.addEventListener('pagehide', () => {
  tracker.stop();
});

syncMuteUi();
el.hud.hidden = true;
el.camPanel.hidden = true;
el.loading.hidden = true;
showScreen('intro');
setMode('intro');
game.mode = 'ambient';

if (new URLSearchParams(window.location.search).has('debug')) {
  window.__bodyRunner = {
    game,
    input,
    body,
    tracker,
    renderer,
    advance,
    beginCalibration,
    simulatePose(landmarks) {
      handlePoseFrame({ landmarks, inferenceMs: 12, fps: 30, delegate: 'SIM' });
    },
    get poseMode() {
      return poseMode;
    },
    get mode() {
      return mode;
    },
  };
}

cancelAnimationFrame(rafId);
rafId = requestAnimationFrame(frame);
