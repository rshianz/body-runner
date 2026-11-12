// Webcam + MediaPipe Pose Landmarker.
//
// Latency choices:
//  * Camera is requested at 60fps with latency:0 and a small resolution.
//  * Frames are pulled with requestVideoFrameCallback, so we always process the
//    freshest frame and never build a queue of stale ones.
//  * One Euro filtering keeps jitter low without adding the lag of a moving
//    average.
//  * Inference rate adapts to the measured cost so rendering keeps its budget.

import { OneEuroFilter } from './util.js';

export const LM = {
  NOSE: 0,
  L_EAR: 7,
  R_EAR: 8,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
  L_HEEL: 29,
  R_HEEL: 30,
  L_FOOT: 31,
  R_FOOT: 32,
};

export const POSE_EDGES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [27, 29], [29, 31],
  [24, 26], [26, 28], [28, 30], [30, 32],
  [0, 11], [0, 12],
];

const VERSION = '1.2.2';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const WASM_PATH = `${CDN}/wasm`;

const MODELS = {
  accurate:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  fast:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

export class PoseTracker {
  constructor(video, { onFrame, onStatus } = {}) {
    this.video = video;
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});

    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.rvfcId = 0;
    this.timerId = 0;
    this.quality = 'accurate';
    this.delegate = 'GPU';
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.lastDetectAt = 0;
    this.detectErrors = 0;
    this.switchingDelegate = false;
    this.forceCpu = false;
    this.paused = false;
    this.warmed = false;
    this.cancelled = false;
    this.requestToken = null;

    this.inferenceMs = 0;
    this.avgInferenceMs = 0;
    this.detectFps = 0;
    this.targetFps = 30;
    this.detectCount = 0;
    this.fpsWindowStart = 0;

    this.rawLandmarks = null;
    this.lastFrameAt = 0;

    this.filters = Array.from({ length: 33 }, () => ({
      x: new OneEuroFilter({ minCutoff: 1.5, beta: 2.4 }),
      y: new OneEuroFilter({ minCutoff: 1.5, beta: 2.4 }),
    }));
    this.smoothed = Array.from({ length: 33 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 0,
    }));
    this.everSawPose = false;
  }

  get cameraLabel() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    return (track && track.label) || 'camera';
  }

  get settings() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    return track ? track.getSettings() : {};
  }

  async startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not expose a camera API.');
    }
    this.cancelled = false;
    const requestToken = Symbol('camera-request');
    this.requestToken = requestToken;
    const video = {
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 60, min: 24 },
        latency: { ideal: 0 },
      },
    };
    this.onStatus('Waiting for camera permission…');

    // A permission prompt that is never answered should not trap the UI, and a
    // stream that arrives after we gave up must be released immediately.
    let timedOut = false;
    let timerId = 0;
    const request = navigator.mediaDevices.getUserMedia(video);
    request
      .then((lateStream) => {
        // Also catches an older request that resolves after a cancel + retry.
        if (timedOut || this.cancelled || this.requestToken !== requestToken) {
          for (const lateTrack of lateStream.getTracks()) lateTrack.stop();
        }
      })
      .catch(() => {});
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        timedOut = true;
        const error = new Error('The camera did not start in time.');
        error.name = 'TimeoutError';
        reject(error);
      }, 15000);
    });
    this.stream = await Promise.race([request, timeout]);
    clearTimeout(timerId);

    if (this.cancelled) {
      for (const cancelledTrack of this.stream.getTracks()) cancelledTrack.stop();
      this.stream = null;
      const error = new Error('Camera setup was cancelled.');
      error.name = 'AbortError';
      throw error;
    }

    const track = this.stream.getVideoTracks()[0];
    if (track && track.applyConstraints) {
      // Low-latency capture where the platform supports it.
      try {
        await track.applyConstraints({ latency: 0, frameRate: { ideal: 60, min: 24 } });
      } catch {
        /* optional hint */
      }
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play().catch(() => {
      throw new Error('The camera stream could not be played.');
    });
    if (this.video.readyState < 2) {
      await new Promise((resolve) => {
        const done = () => {
          this.video.removeEventListener('loadeddata', done);
          resolve();
        };
        this.video.addEventListener('loadeddata', done, { once: true });
        setTimeout(done, 4000);
      });
    }
    this.everSawPose = false;
  }

  async loadModel(quality = 'accurate') {
    this.quality = MODELS[quality] ? quality : 'accurate';
    this.warmed = false;
    this.onStatus('Loading the body tracking engine…');
    const { FilesetResolver, PoseLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

    const create = (delegate) =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODELS[this.quality],
          delegate,
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });

    const previous = this.landmarker;
    try {
      this.landmarker = this.forceCpu ? await create('CPU') : await create('GPU');
      this.delegate = this.forceCpu ? 'CPU' : 'GPU';
    } catch (error) {
      console.warn('[body-runner] GPU delegate unavailable, using CPU.', error);
      this.onStatus('GPU unavailable — using the CPU engine.');
      this.landmarker = await create('CPU');
      this.delegate = 'CPU';
    }
    if (previous && previous !== this.landmarker && previous.close) {
      try {
        previous.close();
      } catch {
        /* ignore */
      }
    }
    this.detectErrors = 0;
  }

  /**
   * Run the model on a live frame before the run so the first real detection is
   * not an expensive cold start (the call compiles GPU shaders).
   */
  warmup() {
    if (this.warmed || !this.landmarker || this.video.readyState < 2) return;
    try {
      this.lastTimestamp = Math.max(performance.now(), this.lastTimestamp + 1);
      this.landmarker.detectForVideo(this.video, this.lastTimestamp);
      this.warmed = true;
    } catch (error) {
      console.warn('[body-runner] Warmup failed.', error);
    }
  }

  start() {
    if (this.running) return;
    if (!this.landmarker) throw new Error('Pose model is not loaded.');
    this.running = true;
    this.lastDetectAt = 0;
    this.detectCount = 0;
    this.fpsWindowStart = performance.now();
    this.resetFilters();

    if (typeof this.video.requestVideoFrameCallback === 'function') {
      const loop = (now, metadata) => {
        if (!this.running) return;
        this.onVideoFrame(now, metadata);
        this.rvfcId = this.video.requestVideoFrameCallback(loop);
      };
      this.rvfcId = this.video.requestVideoFrameCallback(loop);
    } else {
      this.timerId = setInterval(() => this.onVideoFrame(performance.now(), null), 1000 / 30);
    }
  }

  onVideoFrame(now, metadata) {
    if (!this.running || this.paused) return;
    if (document.hidden) return;
    if (metadata && metadata.mediaTime === this.lastVideoTime) return;
    if (metadata) this.lastVideoTime = metadata.mediaTime;

    const minInterval = 1000 / this.targetFps;
    if (now - this.lastDetectAt < minInterval) return;
    this.detect(now);
  }

  detect(now) {
    if (!this.landmarker || this.video.readyState < 2) return;
    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(now, this.lastTimestamp + 0.01);
    this.lastTimestamp = ts;

    const t0 = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, ts);
      this.detectErrors = 0;
    } catch (error) {
      this.detectErrors += 1;
      if (this.detectErrors === 3) this.recoverDelegate(error);
      return;
    }
    const inferenceMs = performance.now() - t0;
    this.lastDetectAt = now;
    this.inferenceMs = inferenceMs;
    this.avgInferenceMs = this.avgInferenceMs
      ? this.avgInferenceMs * 0.9 + inferenceMs * 0.1
      : inferenceMs;
    this.detectCount += 1;
    if (now - this.fpsWindowStart > 1000) {
      this.detectFps = (this.detectCount * 1000) / (now - this.fpsWindowStart);
      this.detectCount = 0;
      this.fpsWindowStart = now;
      this.adaptRate();
    }

    const landmarks = (result && result.landmarks && result.landmarks[0]) || null;
    this.rawLandmarks = landmarks;
    let smoothed = null;
    if (landmarks && landmarks.length === 33) {
      this.everSawPose = true;
      smoothed = this.smooth(landmarks, now);
      this.lastFrameAt = now;
    }

    this.onFrame({
      landmarks: smoothed,
      raw: landmarks,
      inferenceMs,
      fps: this.detectFps,
      now,
      delegate: this.delegate,
    });
  }

  adaptRate() {
    const ms = this.avgInferenceMs;
    if (ms > 16) this.targetFps = 24;
    else if (ms > 10) this.targetFps = 30;
    else if (ms > 7) this.targetFps = 45;
    else this.targetFps = 60;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused) {
      this.lastVideoTime = -1;
      this.lastDetectAt = 0;
    }
  }

  recoverDelegate(error) {
    if (this.switchingDelegate || this.delegate !== 'GPU') {
      console.warn('[body-runner] Pose inference failed.', error);
      return;
    }
    this.switchingDelegate = true;
    this.forceCpu = true;
    this.onStatus('Switching body tracking to CPU…');
    const wasRunning = this.running;
    this.stop({ keepStream: true });
    if (this.landmarker && this.landmarker.close) {
      try {
        this.landmarker.close();
      } catch {
        /* ignore */
      }
    }
    this.landmarker = null;
    this.loadModel(this.quality)
      .then(() => {
        this.delegate = 'CPU';
        if (wasRunning) this.start();
      })
      .catch((err) => console.error('[body-runner] CPU fallback failed.', err))
      .finally(() => {
        this.switchingDelegate = false;
      });
  }

  smooth(landmarks, nowMs) {
    const now = nowMs / 1000;
    for (let i = 0; i < 33; i += 1) {
      const src = landmarks[i];
      const dst = this.smoothed[i];
      const visibility = src.visibility == null ? 1 : src.visibility;
      if (visibility < 0.25) {
        dst.visibility = visibility;
        continue;
      }
      dst.x = this.filters[i].x.filter(src.x, now);
      dst.y = this.filters[i].y.filter(src.y, now);
      dst.z = src.z || 0;
      dst.visibility = visibility;
    }
    return this.smoothed;
  }

  resetFilters() {
    for (const f of this.filters) {
      f.x.reset();
      f.y.reset();
    }
  }

  setQuality(quality) {
    if (MODELS[quality]) this.quality = quality;
  }

  cancelCamera() {
    this.cancelled = true;
    this.requestToken = null;
    this.stop();
  }

  stop({ keepStream = false } = {}) {
    this.running = false;
    if (this.rvfcId && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.rvfcId);
    }
    this.rvfcId = 0;
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = 0;
    if (!keepStream && this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
      this.video.srcObject = null;
    }
  }

  async dispose() {
    this.stop();
    if (this.landmarker && this.landmarker.close) {
      try {
        this.landmarker.close();
      } catch {
        /* already gone */
      }
    }
    this.landmarker = null;
  }
}

export const isCameraSupported = () =>
  Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
