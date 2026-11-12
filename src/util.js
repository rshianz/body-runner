// Small, dependency-free helpers shared by the tracker, game and renderer.

export const TAU = Math.PI * 2;

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

/** Framerate independent exponential smoothing. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * Math.max(0, dt)));

export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInCubic = (t) => Math.pow(clamp(t, 0, 1), 3);
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp(t, 0, 1) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
};

export const rnd = (min = 0, max = 1) => min + Math.random() * (max - min);
export const rndInt = (min, max) => Math.floor(rnd(min, max + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Deterministic PRNG so scenery is stable between resizes. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const formatScore = (n) => Math.floor(n).toLocaleString('en-US');

class LowPass {
  constructor() {
    this.value = null;
  }
  reset() {
    this.value = null;
  }
  filter(x, alpha) {
    if (this.value === null || !Number.isFinite(this.value)) {
      this.value = x;
      return x;
    }
    this.value = alpha * x + (1 - alpha) * this.value;
    return this.value;
  }
}

/**
 * One Euro filter: heavy smoothing when slow (kills landmark jitter) but
 * almost none when fast (kills input latency during quick moves).
 */
export class OneEuroFilter {
  constructor({ minCutoff = 1.4, beta = 2.2, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPass();
    this.dxFilter = new LowPass();
    this.prevX = null;
    this.prevT = null;
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.prevX = null;
    this.prevT = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (TAU * Math.max(cutoff, 0.0001));
    return 1 / (1 + tau / Math.max(dt, 0.0001));
  }

  filter(x, timeSec) {
    if (this.prevT === null || this.prevX === null) {
      this.prevT = timeSec;
      this.prevX = x;
      this.xFilter.filter(x, 1);
      return x;
    }
    let dt = timeSec - this.prevT;
    if (!(dt > 0)) dt = 1 / 30;
    dt = Math.min(dt, 0.2);

    const dx = (x - this.prevX) / dt;
    const edx = this.dxFilter.filter(dx, OneEuroFilter.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const y = this.xFilter.filter(x, OneEuroFilter.alpha(cutoff, dt));

    this.prevX = x;
    this.prevT = timeSec;
    return y;
  }
}

export const roundRect = (ctx, x, y, w, h, r) => {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
};
