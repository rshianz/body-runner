// Merges camera-body input with keyboard fallback into one control snapshot.

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const DUCK = new Set(['ArrowDown', 'KeyS']);
const JUMP = new Set(['ArrowUp', 'KeyW', 'Space']);

const isTypingTarget = (target) =>
  target &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable);

export class InputController {
  constructor() {
    this.mode = 'keyboard';
    this.enabled = false;
    this.keyboardLane = 0;
    this.poseLane = 0;
    this.jumpQueued = false;
    this.keys = new Set();
    this.duckHeld = false;
    this.posePower = 0;
    this.poseConnected = false;
    this.poseDuck = false;
    this.lastKeyboardAt = -1e9;
    this.lastPoseAt = -1e9;
    this.onPause = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.duckHeld = false;
    });
  }

  setMode(mode) {
    this.mode = mode;
    this.keyboardLane = 0;
    this.poseLane = 0;
    this.jumpQueued = false;
    this.poseConnected = false;
  }

  reset() {
    this.keyboardLane = 0;
    this.poseLane = 0;
    this.jumpQueued = false;
    this.lastKeyboardAt = -1e9;
  }

  handleKeyDown(event) {
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Escape' || event.code === 'KeyP') {
      if (this.onPause) {
        event.preventDefault();
        this.onPause();
      }
      return;
    }
    if (!this.enabled) return;

    if (LEFT.has(event.code) || RIGHT.has(event.code)) {
      event.preventDefault();
      if (event.repeat) return;
      const dir = LEFT.has(event.code) ? -1 : 1;
      this.keyboardLane = Math.max(-1, Math.min(1, this.keyboardLane + dir));
      this.lastKeyboardAt = performance.now();
      return;
    }
    if (DUCK.has(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
      this.duckHeld = true;
      return;
    }
    if (JUMP.has(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
      if (!event.repeat) {
        this.jumpQueued = true;
        this.lastKeyboardAt = performance.now();
      }
    }
  }

  handleKeyUp(event) {
    if (DUCK.has(event.code) || JUMP.has(event.code)) {
      this.keys.delete(event.code);
      this.duckHeld = [...DUCK].some((code) => this.keys.has(code));
    }
  }

  applyPose(metrics) {
    this.poseConnected = metrics.valid;
    this.lastPoseAt = performance.now();
    if (!metrics.valid) {
      this.poseDuck = false;
      return;
    }
    this.poseLane = metrics.lane;
    this.posePower = metrics.power;
    this.poseDuck = metrics.ducking;
    if (metrics.jump) this.jumpQueued = true;
  }

  /** Called when the camera loses the player for a while. */
  markPoseLost() {
    this.poseConnected = false;
    this.poseDuck = false;
    this.posePower = 0;
  }

  get poseActive() {
    return this.mode === 'pose';
  }

  snapshot() {
    const now = performance.now();
    const usingKeyboardLane = now - this.lastKeyboardAt < 1200;
    const lane = usingKeyboardLane
      ? this.keyboardLane
      : this.mode === 'pose'
        ? this.poseLane
        : this.keyboardLane;

    let power;
    if (this.mode === 'pose') {
      // Keep the run moving when the tracker briefly loses the pose.
      power = now - this.lastPoseAt < 700 ? this.posePower : Math.min(this.posePower, 0.32);
    } else {
      power = 0.78;
    }

    const poseFresh = now - this.lastPoseAt < 500;
    const duck =
      this.duckHeld || (this.mode === 'pose' && this.poseDuck && this.poseConnected && poseFresh);
    const jump = this.jumpQueued;
    this.jumpQueued = false;

    return { lane, jump, duck, power, poseConnected: this.poseConnected };
  }
}
