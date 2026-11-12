// Tiny WebAudio synth — no asset files, no network, no autoplay surprises.

const STORAGE_KEY = 'bodyrunner.muted';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    try {
      this.muted = window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    this.ctx = new Ctor();
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 22;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(compressor);
    compressor.connect(this.ctx.destination);
    this.compressor = compressor;
    return true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  tone({ freq = 440, to = null, duration = 0.15, type = 'sine', gain = 0.2, delay = 0 }) {
    if (!this.ensure() || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.03);
  }

  noise({ duration = 0.18, gain = 0.14, lowpass = 1400, delay = 0 }) {
    if (!this.ensure() || this.muted) return;
    if (!this.noiseBuffer) {
      const length = Math.floor(this.ctx.sampleRate * 0.5);
      const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(lowpass, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  play(type) {
    switch (type) {
      case 'jump':
        this.tone({ freq: 340, to: 640, duration: 0.14, type: 'triangle', gain: 0.18 });
        break;
      case 'land':
        this.tone({ freq: 150, to: 70, duration: 0.14, type: 'sine', gain: 0.16 });
        this.noise({ duration: 0.12, gain: 0.07, lowpass: 900 });
        break;
      case 'orb':
        this.tone({ freq: 880, duration: 0.09, type: 'sine', gain: 0.13 });
        this.tone({ freq: 1320, duration: 0.12, type: 'sine', gain: 0.1, delay: 0.05 });
        break;
      case 'heart':
        [523, 659, 784, 1046].forEach((freq, i) =>
          this.tone({ freq, duration: 0.16, type: 'triangle', gain: 0.14, delay: i * 0.07 })
        );
        break;
      case 'bonus':
        this.tone({ freq: 784, to: 1568, duration: 0.22, type: 'sine', gain: 0.12 });
        break;
      case 'hit':
        this.tone({ freq: 190, to: 48, duration: 0.4, type: 'sawtooth', gain: 0.2 });
        this.noise({ duration: 0.3, gain: 0.22, lowpass: 2200 });
        break;
      case 'gameover':
        [392, 330, 262, 196].forEach((freq, i) =>
          this.tone({ freq, duration: 0.34, type: 'triangle', gain: 0.13, delay: i * 0.13 })
        );
        break;
      case 'start':
        [392, 523, 659].forEach((freq, i) =>
          this.tone({ freq, duration: 0.18, type: 'sine', gain: 0.12, delay: i * 0.08 })
        );
        break;
      case 'ui':
        this.tone({ freq: 520, duration: 0.06, type: 'sine', gain: 0.07 });
        break;
      case 'count':
        this.tone({ freq: 660, duration: 0.1, type: 'sine', gain: 0.1 });
        break;
      case 'go':
        this.tone({ freq: 880, to: 1320, duration: 0.2, type: 'triangle', gain: 0.14 });
        break;
      default:
        break;
    }
  }
}
