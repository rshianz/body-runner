// Canvas renderer: pseudo-3D neon track, parallax skyline, animated runner and
// pooled particles. Static scenery is pre-rendered once per resize.

import { clamp, lerp, mulberry32, rnd, TAU } from './util.js';

const TAU2 = TAU;

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  return canvas;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.horizon = 0;
    this.groundY = 0;
    this.playerHeight = 180;
    this.centerX = 0;
    this.laneWidth = 0;

    this.time = 0;
    this.runPhase = rnd(0, TAU);
    this.dustTimer = 0;
    this.bg = null;
    this.particles = [];
    this.popups = [];
    this.glowCache = new Map();
    this.grads = null;
    this.flashRing = 0;

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, rect.width || window.innerWidth);
    const h = Math.max(240, rect.height || window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      this.canvas.width !== Math.floor(w * this.dpr) ||
      this.canvas.height !== Math.floor(h * this.dpr)
    ) {
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
    }
    this.w = w;
    this.h = h;
    this.horizon = h * 0.545;
    this.groundY = h * 0.875;
    this.playerHeight = clamp(h * 0.255, 120, 260);
    this.centerX = w * 0.5;
    this.laneWidth = w * 0.185;
    this.buildScene();
  }

  buildScene() {
    const { w, h, horizon, groundY } = this;
    const skyH = Math.ceil(horizon + h * 0.08);

    // ---- Sky -----------------------------------------------------------
    const sky = makeCanvas(w, skyH);
    const sctx = sky.getContext('2d');
    const skyGrad = sctx.createLinearGradient(0, 0, 0, skyH);
    skyGrad.addColorStop(0, '#05060f');
    skyGrad.addColorStop(0.36, '#0b0e24');
    skyGrad.addColorStop(0.68, '#221b46');
    skyGrad.addColorStop(0.87, '#4a2a55');
    skyGrad.addColorStop(1, '#7d3f5d');
    sctx.fillStyle = skyGrad;
    sctx.fillRect(0, 0, w, skyH);

    // Stars
    const rand = mulberry32(20261110);
    for (let i = 0; i < 150; i += 1) {
      const x = rand() * w;
      const y = rand() * horizon * 0.88;
      const r = rand() * 1.4 + 0.2;
      const alpha = 0.18 + rand() * 0.6;
      sctx.fillStyle = `rgba(210, 230, 255, ${alpha})`;
      sctx.beginPath();
      sctx.arc(x, y, r, 0, TAU2);
      sctx.fill();
    }

    // Sun / moon with atmospheric haze
    const sunX = w * 0.74;
    const sunY = horizon * 0.66;
    const sunR = Math.min(w, h) * 0.085;
    const sunGlow = sctx.createRadialGradient(sunX, sunY, sunR * 0.3, sunX, sunY, sunR * 4.2);
    sunGlow.addColorStop(0, 'rgba(255, 214, 170, 0.75)');
    sunGlow.addColorStop(0.16, 'rgba(255, 140, 160, 0.32)');
    sunGlow.addColorStop(0.5, 'rgba(150, 100, 220, 0.12)');
    sunGlow.addColorStop(1, 'rgba(80, 60, 160, 0)');
    sctx.fillStyle = sunGlow;
    sctx.fillRect(sunX - sunR * 4.2, sunY - sunR * 4.2, sunR * 8.4, sunR * 8.4);

    sctx.fillStyle = '#ffd9b8';
    sctx.beginPath();
    sctx.arc(sunX, sunY, sunR, 0, TAU2);
    sctx.fill();
    sctx.fillStyle = 'rgba(255, 170, 190, 0.55)';
    sctx.beginPath();
    sctx.arc(sunX + sunR * 0.12, sunY + sunR * 0.15, sunR * 0.93, 0, TAU2);
    sctx.fill();

    // Cloud bands
    for (let i = 0; i < 5; i += 1) {
      const cy = horizon * (0.30 + i * 0.11);
      const cw = w * (0.35 + rand() * 0.6);
      const cx = rand() * w - cw * 0.2;
      const grad = sctx.createLinearGradient(0, cy - 16, 0, cy + 18);
      grad.addColorStop(0, 'rgba(130, 120, 200, 0)');
      grad.addColorStop(0.5, `rgba(160, 150, 230, ${0.05 + rand() * 0.05})`);
      grad.addColorStop(1, 'rgba(60, 40, 100, 0)');
      sctx.fillStyle = grad;
      sctx.beginPath();
      sctx.ellipse(cx + cw / 2, cy, cw / 2, 14 + rand() * 8, 0, 0, TAU2);
      sctx.fill();
    }

    // ---- Far skyline ---------------------------------------------------
    const farTileW = Math.max(w * 1.4, 1100);
    const farH = h * 0.20;
    const far = makeCanvas(farTileW, farH + 4);
    const fctx = far.getContext('2d');
    const frand = mulberry32(913377);
    fctx.fillStyle = '#0d0f22';
    let fx = -20;
    while (fx < farTileW + 40) {
      const bw = 24 + frand() * 70;
      const bh = farH * (0.22 + frand() * 0.78);
      fctx.fillStyle = frand() > 0.4 ? 'rgba(18, 19, 45, 0.95)' : 'rgba(24, 22, 52, 0.95)';
      fctx.fillRect(fx, farH - bh, bw, bh);
      // antenna
      if (frand() > 0.72) {
        fctx.fillRect(fx + bw * 0.5, farH - bh - 12, 2, 12);
      }
      // windows
      const cols = Math.floor(bw / 12);
      const rows = Math.floor(bh / 14);
      for (let c = 0; c < cols; c += 1) {
        for (let r = 0; r < rows; r += 1) {
          if (frand() > 0.82) {
            const warm = frand() > 0.5;
            fctx.fillStyle = warm ? 'rgba(255, 186, 130, 0.5)' : 'rgba(120, 220, 255, 0.35)';
            fctx.fillRect(fx + 5 + c * 12, farH - bh + 8 + r * 14, 2.5, 3.5);
          }
        }
      }
      fx += bw + 6 + frand() * 18;
    }
    // horizon fade
    const fade = fctx.createLinearGradient(0, 0, 0, farH);
    fade.addColorStop(0, 'rgba(15, 12, 36, 0.15)');
    fade.addColorStop(0.75, 'rgba(20, 14, 42, 0.05)');
    fade.addColorStop(1, 'rgba(50, 30, 60, 0.55)');
    fctx.fillStyle = fade;
    fctx.fillRect(0, 0, farTileW, farH);

    // ---- Near hills ----------------------------------------------------
    const nearTileW = Math.max(w * 1.25, 900);
    const nearH = h * 0.13;
    const near = makeCanvas(nearTileW, nearH + 4);
    const nctx = near.getContext('2d');
    const nrand = mulberry32(440021);
    nctx.fillStyle = '#100f24';
    nctx.beginPath();
    nctx.moveTo(0, nearH);
    let px = 0;
    let py = nearH * (0.4 + nrand() * 0.4);
    nctx.lineTo(0, py);
    while (px < nearTileW) {
      const step = 50 + nrand() * 120;
      px += step;
      const nextY = nearH * (0.28 + nrand() * 0.62);
      nctx.quadraticCurveTo(px - step / 2, py - 10 - nrand() * 16, px, nextY);
      py = nextY;
    }
    nctx.lineTo(nearTileW, nearH);
    nctx.closePath();
    nctx.fill();

    // a few towers on the near ridge
    for (let i = 0; i < 9; i += 1) {
      const x = nrand() * nearTileW;
      const bw = 26 + nrand() * 40;
      const bh = nearH * (0.4 + nrand() * 0.9);
      nctx.fillStyle = '#0a0a18';
      nctx.fillRect(x, nearH - bh, bw, bh);
      nctx.fillStyle = 'rgba(85, 240, 220, 0.35)';
      nctx.fillRect(x + bw * 0.2, nearH - bh + 4, bw * 0.6, 1.5);
    }

    // ---- Scene gradients ------------------------------------------------
    const groundGrad = this.ctx.createLinearGradient(0, horizon, 0, h);
    groundGrad.addColorStop(0, '#241a3c');
    groundGrad.addColorStop(0.25, '#120f24');
    groundGrad.addColorStop(1, '#050510');

    const trackGrad = this.ctx.createLinearGradient(0, horizon, 0, h);
    trackGrad.addColorStop(0, 'rgba(38, 32, 74, 0.1)');
    trackGrad.addColorStop(0.4, 'rgba(25, 28, 62, 0.55)');
    trackGrad.addColorStop(1, 'rgba(12, 16, 38, 0.92)');

    const haze = this.ctx.createLinearGradient(0, horizon - h * 0.12, 0, horizon + h * 0.1);
    haze.addColorStop(0, 'rgba(120, 80, 170, 0)');
    haze.addColorStop(0.55, 'rgba(190, 110, 180, 0.16)');
    haze.addColorStop(1, 'rgba(40, 25, 80, 0)');

    const vignette = this.ctx.createRadialGradient(
      w * 0.5,
      h * 0.55,
      Math.min(w, h) * 0.25,
      w * 0.5,
      h * 0.55,
      Math.max(w, h) * 0.78
    );
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(0.72, 'rgba(2, 2, 10, 0.22)');
    vignette.addColorStop(1, 'rgba(2, 2, 10, 0.72)');

    const scanTile = makeCanvas(4, 4);
    const scanCtx = scanTile.getContext('2d');
    scanCtx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    scanCtx.fillRect(0, 0, 4, 1);
    const scanPattern = this.ctx.createPattern(scanTile, 'repeat');

    this.bg = {
      sky,
      skyH,
      far,
      farTileW,
      farH,
      near,
      nearTileW,
      nearH,
      sunX,
      sunY,
      groundGrad,
      trackGrad,
      haze,
      vignette,
      scanPattern,
    };
  }

  // ---- Projection -------------------------------------------------------
  project(z, lane) {
    const clamped = Math.max(z, -4);
    const p = 1 / (1 + clamped * 0.145);
    const y = this.horizon + (this.groundY - this.horizon) * p;
    const laneW = this.laneWidth * p;
    const x = this.centerX + lane * laneW;
    return { x, y, p, laneW };
  }

  playerAnchor() {
    const proj = this.project(0, this.lastLaneVisual || 0);
    return {
      x: proj.x,
      feetY: proj.y - (this.lastJumpH || 0) * this.playerHeight,
      groundY: proj.y,
    };
  }

  glow(color) {
    if (this.glowCache.has(color)) return this.glowCache.get(color);
    const size = 128;
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 1;
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    this.glowCache.set(color, c);
    return c;
  }

  // ---- Particles / popups ----------------------------------------------
  burst(x, y, { count = 14, color = '#57f5d5', speed = 260, size = 4, gravity = 900, life = 0.6, spread = TAU2, direction = -Math.PI / 2, shape = 'dot' } = {}) {
    if (this.particles.length > 260) return;
    for (let i = 0; i < count; i += 1) {
      const angle = direction + (Math.random() - 0.5) * spread;
      const vel = speed * (0.35 + Math.random() * 0.9);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * vel,
        vy: Math.sin(angle) * vel,
        life: life * (0.6 + Math.random() * 0.7),
        maxLife: life,
        size: size * (0.5 + Math.random()),
        color,
        gravity,
        drag: 1.6,
        shape,
        rot: Math.random() * TAU2,
      });
    }
  }

  popup(x, y, text, color = '#eaf6ff', size = 22) {
    this.popups.push({
      x,
      y,
      text,
      color,
      size,
      life: 1.05,
      maxLife: 1.05,
    });
  }

  onEvent(event, game) {
    const anchor = this.playerAnchor();
    switch (event.type) {
      case 'start':
        this.particles.length = 0;
        this.popups.length = 0;
        break;
      case 'jump':
        this.burst(anchor.x, anchor.groundY - 4, {
          count: 12,
          color: '#5ff0d8',
          speed: 170,
          size: 3,
          gravity: 500,
          life: 0.45,
          direction: -Math.PI / 2,
          spread: Math.PI * 0.9,
        });
        break;
      case 'land':
        this.burst(anchor.x, anchor.groundY - 2, {
          count: 16,
          color: '#9b8dff',
          speed: 220,
          size: 3.5,
          gravity: 620,
          life: 0.5,
          direction: -Math.PI / 2,
          spread: Math.PI * 1.1,
        });
        this.shakeAmount = Math.max(this.shakeAmount || 0, 4);
        break;
      case 'orb': {
        const proj = this.project(0.4, event.lane);
        this.burst(proj.x, proj.y - this.playerHeight * 0.55, {
          count: 12,
          color: '#ffd76a',
          speed: 200,
          size: 3,
          gravity: 260,
          life: 0.5,
        });
        this.popup(proj.x, proj.y - this.playerHeight * 0.8, `+${Math.round(event.gain || 45)}`, '#ffd76a', 20);
        break;
      }
      case 'bonus': {
        const proj = this.project(0.4, event.lane);
        this.popup(proj.x, proj.y - this.playerHeight * 0.9, `+${event.gain}`, '#ffe6a3', 24);
        break;
      }
      case 'heart': {
        const proj = this.project(0.4, event.lane);
        this.popup(proj.x, proj.y - this.playerHeight * 0.95, '+1 LIFE', '#ff7da8', 26);
        this.burst(proj.x, proj.y - this.playerHeight * 0.6, {
          count: 22,
          color: '#ff7da8',
          speed: 260,
          size: 4,
          gravity: 120,
          life: 0.8,
        });
        break;
      }
      case 'hit': {
        const proj = this.project(0, this.lastLaneVisual || 0);
        this.burst(proj.x, proj.y - this.playerHeight * 0.45, {
          count: 34,
          color: '#ff4d7d',
          speed: 430,
          size: 5,
          gravity: 900,
          life: 0.85,
        });
        this.burst(proj.x, proj.y - this.playerHeight * 0.6, {
          count: 16,
          color: '#ffffff',
          speed: 300,
          size: 2.5,
          gravity: 500,
          life: 0.4,
        });
        this.popup(proj.x, proj.y - this.playerHeight * 1.05, 'OUCH!', '#ff8aa6', 26);
        this.shakeAmount = 20;
        break;
      }
      case 'gameover': {
        const proj = this.project(0, this.lastLaneVisual || 0);
        this.burst(proj.x, proj.y - this.playerHeight * 0.5, {
          count: 60,
          color: '#8b7bff',
          speed: 520,
          size: 5,
          gravity: 700,
          life: 1.3,
        });
        break;
      }
      case 'dodge':
        if (event.combo > 0 && event.combo % 4 === 0) {
          const proj = this.project(0, this.lastLaneVisual || 0);
          this.popup(
            proj.x,
            proj.y - this.playerHeight * 1.15,
            `COMBO x${(1 + Math.min(3, Math.floor(event.combo / 4) * 0.25)).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`,
            '#5ff0d8',
            22
          );
        }
        break;
      default:
        break;
    }
  }

  // ---- Main draw --------------------------------------------------------
  draw(game, dt) {
    const ctx = this.ctx;
    this.time += dt;
    this.lastLaneVisual = game.laneVisual;
    this.lastJumpH = game.jumpH;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();

    const shake = Math.max(game.shake || 0, this.shakeAmount || 0);
    this.shakeAmount = Math.max(0, (this.shakeAmount || 0) - dt * 30);
    if (shake > 0.01) {
      const amp = shake * 12;
      ctx.translate(
        (Math.random() - 0.5) * amp,
        (Math.random() - 0.5) * amp
      );
    }

    this.drawSky(game);
    this.drawGround(game);

    const farObstacles = game.obstacles.filter((o) => o.z >= 0).sort((a, b) => b.z - a.z);
    const nearObstacles = game.obstacles.filter((o) => o.z < 0).sort((a, b) => b.z - a.z);
    const pickups = game.pickups.filter((p) => !p.collected).sort((a, b) => b.z - a.z);

    for (const pickup of pickups) if (pickup.z >= 0) this.drawPickup(pickup);
    for (const obstacle of farObstacles) this.drawObstacle(obstacle, game);

    this.drawRunner(game, dt);

    for (const obstacle of nearObstacles) this.drawObstacle(obstacle, game);
    for (const pickup of pickups) if (pickup.z < 0) this.drawPickup(pickup);

    this.drawSpeedLines(game);
    this.updateAndDrawParticles(dt);
    this.drawPopups(dt);

    ctx.restore();

    // Full-screen treatments (no shake)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = this.bg;
    if (game.power > 0.4) {
      ctx.fillStyle = `rgba(80, 240, 220, ${(game.power - 0.4) * 0.035})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    if (game.flash > 0.01) {
      ctx.fillStyle = `rgba(255, 70, 120, ${game.flash * 0.34})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    ctx.fillStyle = bg.vignette;
    ctx.fillRect(0, 0, this.w, this.h);

    // Faint scanline layer for texture
    ctx.fillStyle = bg.scanPattern;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  drawSky(game) {
    const ctx = this.ctx;
    const bg = this.bg;
    ctx.drawImage(bg.sky, 0, 0, this.w, bg.skyH);

    const scrollFar = ((game.worldZ || 0) * 0.55) % bg.farTileW;
    ctx.drawImage(
      bg.far,
      -scrollFar,
      this.horizon - bg.farH + 6,
      bg.farTileW,
      bg.farH
    );
    ctx.drawImage(
      bg.far,
      bg.farTileW - scrollFar,
      this.horizon - bg.farH + 6,
      bg.farTileW,
      bg.farH
    );

    const scrollNear = ((game.worldZ || 0) * 1.35) % bg.nearTileW;
    ctx.drawImage(
      bg.near,
      -scrollNear,
      this.horizon - bg.nearH + 2,
      bg.nearTileW,
      bg.nearH
    );
    ctx.drawImage(
      bg.near,
      bg.nearTileW - scrollNear,
      this.horizon - bg.nearH + 2,
      bg.nearTileW,
      bg.nearH
    );

    ctx.fillStyle = bg.haze;
    ctx.fillRect(0, this.horizon - this.h * 0.12, this.w, this.h * 0.22);

    // Horizon light bar
    const horizonGlow = ctx.createLinearGradient(0, this.horizon - 2, 0, this.horizon + 26);
    horizonGlow.addColorStop(0, 'rgba(255, 170, 200, 0.30)');
    horizonGlow.addColorStop(1, 'rgba(255, 170, 200, 0)');
    ctx.fillStyle = horizonGlow;
    ctx.fillRect(0, this.horizon - 2, this.w, 28);
  }

  drawGround(game) {
    const ctx = this.ctx;
    const bg = this.bg;
    ctx.fillStyle = bg.groundGrad;
    ctx.fillRect(0, this.horizon, this.w, this.h - this.horizon);

    // Track surface
    const nearEdgeL = this.project(-2, -1.5);
    const nearEdgeR = this.project(-2, 1.5);
    const farEdge = this.project(64, 0);
    ctx.beginPath();
    ctx.moveTo(nearEdgeL.x, nearEdgeL.y);
    ctx.lineTo(nearEdgeR.x, nearEdgeR.y);
    ctx.lineTo(farEdge.x, farEdge.y);
    ctx.closePath();
    ctx.fillStyle = bg.trackGrad;
    ctx.fill();

    // Alternating lane wash
    for (let lane = -1; lane <= 1; lane += 1) {
      if (lane === 0) continue;
      const n1 = this.project(-2, lane - 0.5);
      const n2 = this.project(-2, lane + 0.5);
      const f1 = this.project(64, lane - 0.5);
      const f2 = this.project(64, lane + 0.5);
      ctx.beginPath();
      ctx.moveTo(n1.x, n1.y);
      ctx.lineTo(n2.x, n2.y);
      ctx.lineTo(f2.x, f2.y);
      ctx.lineTo(f1.x, f1.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(120, 140, 255, 0.035)';
      ctx.fill();
    }

    // Lane boundaries
    ctx.lineWidth = 1.5;
    for (const laneEdge of [-1.5, -0.5, 0.5, 1.5]) {
      const near = this.project(-2, laneEdge);
      const far = this.project(64, laneEdge);
      const edgeGrad = ctx.createLinearGradient(far.x, far.y, near.x, near.y);
      const bright = Math.abs(laneEdge) === 1.5 ? 0.5 : 0.24;
      edgeGrad.addColorStop(0, 'rgba(120, 140, 255, 0)');
      edgeGrad.addColorStop(0.55, `rgba(120, 200, 255, ${bright * 0.35})`);
      edgeGrad.addColorStop(1, `rgba(120, 240, 255, ${bright})`);
      ctx.strokeStyle = edgeGrad;
      ctx.beginPath();
      ctx.moveTo(far.x, far.y);
      ctx.lineTo(near.x, near.y);
      ctx.stroke();
    }

    // Neon rails
    for (const side of [-1.5, 1.5]) {
      const near = this.project(-2, side);
      const far = this.project(64, side);
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 245, 235, 0.28)';
      ctx.lineWidth = 3;
      ctx.shadowColor = 'rgba(80, 240, 220, 0.65)';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(far.x, far.y);
      ctx.lineTo(near.x, near.y);
      ctx.stroke();
      ctx.restore();
    }

    // Scrolling rungs
    const spacing = 4.2;
    const phase = (game.worldZ || 0) % spacing;
    for (let i = 0; i < 17; i += 1) {
      const z = i * spacing - phase;
      if (z < -2) continue;
      const left = this.project(z, -1.5);
      const right = this.project(z, 1.5);
      const alpha = clamp(left.p * 0.42, 0, 0.4);
      ctx.strokeStyle = `rgba(140, 170, 255, ${alpha})`;
      ctx.lineWidth = Math.max(1, 2 * left.p);
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }
  }

  drawObstacle(obstacle, game) {
    const proj = this.project(obstacle.z, obstacle.lane);
    if (proj.p < 0.02) return;
    const unit = this.playerHeight * proj.p;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = clamp(proj.p * 1.6, 0.15, 1);

    if (obstacle.type === 'block') {
      const bw = unit * 0.62;
      const bh = unit * 0.42;
      const x = proj.x - bw / 2;
      const y = proj.y - bh;
      const grad = ctx.createLinearGradient(0, y, 0, proj.y);
      grad.addColorStop(0, '#3c1d3f');
      grad.addColorStop(1, '#1a0d20');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, unit * 0.05);
      ctx.fill();
      ctx.strokeStyle = obstacle.hit ? 'rgba(255, 120, 150, 0.5)' : 'rgba(255, 90, 130, 0.85)';
      ctx.lineWidth = Math.max(1.2, unit * 0.018);
      ctx.stroke();

      // hazard chevrons
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, unit * 0.05);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 120, 100, 0.32)';
      ctx.lineWidth = Math.max(2, unit * 0.035);
      const step = unit * 0.11;
      for (let sx = -bh; sx < bw + bh; sx += step) {
        ctx.beginPath();
        ctx.moveTo(x + sx, proj.y);
        ctx.lineTo(x + sx + bh, y);
        ctx.stroke();
      }
      ctx.restore();

      ctx.fillStyle = 'rgba(255, 170, 190, 0.9)';
      ctx.fillRect(x + bw * 0.12, y + unit * 0.01, bw * 0.76, Math.max(1, unit * 0.012));
    } else {
      // Hanging barrier: slide underneath it.
      const clearance = unit * 0.95;
      const beamH = unit * 0.26;
      const beamY = proj.y - clearance - beamH;
      const half = (obstacle.wide ? this.project(obstacle.z, 1.5).x - proj.x : proj.laneW * 0.82);
      const left = proj.x - half;
      const right = proj.x + half;
      const postW = Math.max(2, unit * 0.05);

      // posts
      ctx.fillStyle = 'rgba(40, 20, 50, 0.95)';
      ctx.fillRect(left, beamY, postW, proj.y - beamY);
      ctx.fillRect(right - postW, beamY, postW, proj.y - beamY);

      const beamGrad = ctx.createLinearGradient(0, beamY, 0, beamY + beamH);
      beamGrad.addColorStop(0, '#ff4d80');
      beamGrad.addColorStop(0.5, '#8a2a6a');
      beamGrad.addColorStop(1, '#2a1038');
      ctx.fillStyle = beamGrad;
      ctx.beginPath();
      ctx.roundRect(left, beamY, right - left, beamH, Math.max(1, unit * 0.02));
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 130, 175, 0.95)';
      ctx.lineWidth = Math.max(1.2, unit * 0.014);
      ctx.stroke();

      // warning stripes on beam
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(left, beamY, right - left, beamH, 6);
      ctx.clip();
      ctx.strokeStyle = 'rgba(20, 8, 24, 0.55)';
      ctx.lineWidth = Math.max(3, unit * 0.05);
      for (let sx = left - beamH; sx < right + beamH; sx += unit * 0.13) {
        ctx.beginPath();
        ctx.moveTo(sx, beamY + beamH);
        ctx.lineTo(sx + beamH, beamY);
        ctx.stroke();
      }
      ctx.restore();

      // clearance glow + arrows
      ctx.strokeStyle = 'rgba(120, 245, 230, 0.22)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(left + postW, proj.y - 2);
      ctx.lineTo(right - postW, proj.y - 2);
      ctx.stroke();
      if (unit > 60) {
        ctx.fillStyle = 'rgba(120, 245, 230, 0.5)';
        const arrowY = proj.y - clearance * 0.35;
        const ax = proj.x;
        ctx.beginPath();
        ctx.moveTo(ax, arrowY + unit * 0.06);
        ctx.lineTo(ax - unit * 0.05, arrowY - unit * 0.03);
        ctx.lineTo(ax + unit * 0.05, arrowY - unit * 0.03);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawPickup(pickup) {
    const proj = this.project(pickup.z, pickup.lane);
    if (proj.p < 0.02) return;
    const unit = this.playerHeight * proj.p;
    const bob = Math.sin(this.time * 3 + (pickup.seed || 0) * 10) * unit * 0.03;
    const x = proj.x;
    const y = proj.y - unit * 0.62 + bob;
    const size = unit * 0.11;
    const ctx = this.ctx;

    const glow = this.glow('rgba(255, 214, 106, 0.55)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(proj.p * 1.4, 0.1, 0.9);
    ctx.drawImage(glow, x - unit * 0.34, y - unit * 0.34, unit * 0.68, unit * 0.68);
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.time * 1.7 + (pickup.seed || 0) * 6);
    ctx.fillStyle = 'rgba(255, 226, 140, 0.96)';
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.66, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.66, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1, size * 0.15);
    ctx.stroke();
    ctx.restore();
  }

  drawRunner(game, dt) {
    const ctx = this.ctx;
    const h = this.playerHeight;
    const proj = this.project(0, game.laneVisual);
    const feetY = proj.y - game.jumpH * h;
    const x = proj.x;
    const power = clamp(game.power * 1.3 + 0.15, 0.15, 1);
    const speedFactor = clamp((game.speed - 15) / 30, 0, 1.4);
    this.runPhase += (6 + speedFactor * 13) * dt * (game.mode === 'over' ? 0.3 : 1);

    // Ground shadow
    const shadowScale = clamp(1 - game.jumpH * 0.42, 0.35, 1);
    ctx.save();
    ctx.globalAlpha = 0.38 * shadowScale;
    ctx.fillStyle = '#02030a';
    ctx.beginPath();
    ctx.ellipse(x, proj.y + 3, h * 0.15 * shadowScale, h * 0.035 * shadowScale, 0, 0, TAU2);
    ctx.fill();
    ctx.restore();

    // Aura
    const aura = this.glow('rgba(90, 245, 220, 0.35)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.12 + power * 0.22) * (game.invuln > 0 ? 0.5 : 1);
    ctx.drawImage(aura, x - h * 0.55, feetY - h * 0.95, h * 1.1, h * 1.3);
    ctx.restore();

    ctx.save();
    ctx.translate(x, feetY);

    // Blink while invulnerable
    if (game.invuln > 0 && Math.floor(game.invuln * 14) % 2 === 0) {
      ctx.globalAlpha = 0.45;
    }

    if (game.slideVisual > 0.02) {
      // Slide: rotate the whole body down around the hips.
      ctx.translate(0, -h * 0.2);
      ctx.rotate(game.slideVisual * 1.18);
    } else {
      ctx.translate(0, -h * 0.37);
    }

    this.drawBody(ctx, h, game, power);

    ctx.restore();

    // Dust kicked up while running
    if (game.mode === 'running' && game.grounded && game.power > 0.22) {
      this.dustTimer -= dt;
      if (this.dustTimer <= 0) {
        this.dustTimer = 0.06 + Math.random() * 0.05;
        this.burst(x - h * 0.1, proj.y, {
          count: 2,
          color: 'rgba(140, 210, 255, 0.8)',
          speed: 90,
          size: 2.5,
          gravity: -40,
          life: 0.45,
          direction: -Math.PI / 2 - 0.6,
          spread: 0.7,
        });
      }
    }
  }

  drawBody(ctx, h, game, power) {
    const phase = this.runPhase;
    const air = clamp(game.jumpH * 2.6, 0, 1);
    const slide = game.slideVisual;
    const squash = 1 - game.landSquash * 0.08;

    // ---- Limb geometry -------------------------------------------------
    const makeLeg = (offset) => {
      const p = phase + offset;
      const swing = Math.sin(p);
      const lift = Math.max(0, Math.sin(p + 1.1));
      let thigh = swing * 0.62 * (0.55 + power * 0.55);
      let bend = 0.12 + lift * 0.8;
      thigh = lerp(thigh, 0.85, air);
      bend = lerp(bend, 1.5, air);
      const thighLen = h * 0.19;
      const shinLen = h * 0.18;
      const knee = {
        x: Math.sin(thigh) * thighLen,
        y: Math.cos(thigh) * thighLen,
      };
      const shinAngle = thigh - bend;
      const foot = {
        x: knee.x + Math.sin(shinAngle) * shinLen,
        y: knee.y + Math.cos(shinAngle) * shinLen,
      };
      return { knee, foot, thigh, shinAngle };
    };

    const makeArm = (offset) => {
      const p = phase + offset;
      const swing = Math.sin(p);
      let upper = -swing * 0.85 * (0.6 + power * 0.5) - 0.12;
      let bend = 0.55 + Math.max(0, swing) * 0.55;
      upper = lerp(upper, -1.5, air);
      bend = lerp(bend, 0.55, air);
      const upperLen = h * 0.17;
      const foreLen = h * 0.16;
      const elbow = { x: Math.sin(upper) * upperLen, y: Math.cos(upper) * upperLen };
      const foreAngle = upper + bend;
      const hand = {
        x: elbow.x + Math.sin(foreAngle) * foreLen,
        y: elbow.y + Math.cos(foreAngle) * foreLen,
      };
      return { elbow, hand, upper, foreAngle };
    };

    const legA = makeLeg(0);
    const legB = makeLeg(Math.PI);
    const armA = makeArm(Math.PI);
    const armB = makeArm(0);

    const hip = { x: 0, y: 0 };
    const shoulder = { x: h * 0.035, y: -h * 0.285 * squash };
    const lean = game.tilt * 0.6;

    // ---- Trailing energy scarf ----------------------------------------
    const scarfWave = Math.sin(phase * 0.5) * h * 0.02;
    ctx.save();
    ctx.globalAlpha = 0.4 + power * 0.4;
    const scarfGrad = ctx.createLinearGradient(shoulder.x, shoulder.y, -h * 0.4, shoulder.y + h * 0.05);
    scarfGrad.addColorStop(0, 'rgba(255, 110, 190, 0.85)');
    scarfGrad.addColorStop(1, 'rgba(120, 120, 255, 0)');
    ctx.strokeStyle = scarfGrad;
    ctx.lineWidth = h * 0.028;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shoulder.x - h * 0.02, shoulder.y);
    ctx.quadraticCurveTo(
      -h * 0.2,
      shoulder.y + scarfWave - h * 0.02,
      -h * 0.36,
      shoulder.y + h * 0.06 + scarfWave
    );
    ctx.stroke();
    ctx.restore();

    // ---- Trailing leg (behind body) -----------------------------------
    const strokeLeg = (leg, back) => {
      ctx.strokeStyle = back ? '#2f8f9e' : '#64f2d4';
      ctx.lineWidth = h * (back ? 0.052 : 0.056);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hip.x, hip.y);
      ctx.lineTo(leg.knee.x, leg.knee.y);
      ctx.lineTo(leg.foot.x, leg.foot.y);
      ctx.stroke();
      // shoe
      ctx.fillStyle = back ? '#1c5f70' : '#b8fff2';
      ctx.beginPath();
      ctx.ellipse(leg.foot.x, leg.foot.y, h * 0.05, h * 0.024, leg.shinAngle, 0, TAU2);
      ctx.fill();
    };

    strokeLeg(legB, true);

    // ---- Back arm ------------------------------------------------------
    ctx.strokeStyle = '#4c6cc9';
    ctx.lineWidth = h * 0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(shoulder.x + armB.elbow.x, shoulder.y + armB.elbow.y);
    ctx.lineTo(shoulder.x + armB.hand.x, shoulder.y + armB.hand.y);
    ctx.stroke();

    // ---- Torso ---------------------------------------------------------
    ctx.save();
    ctx.translate(0, 0);
    ctx.rotate(lean * 0.35);
    const torsoGrad = ctx.createLinearGradient(0, shoulder.y, 0, hip.y);
    torsoGrad.addColorStop(0, '#8bf7e3');
    torsoGrad.addColorStop(0.45, '#4fd8d0');
    torsoGrad.addColorStop(1, '#3a6fbc');
    ctx.fillStyle = torsoGrad;
    ctx.beginPath();
    ctx.moveTo(hip.x - h * 0.062, hip.y);
    ctx.quadraticCurveTo(hip.x - h * 0.105, shoulder.y + h * 0.06, shoulder.x - h * 0.078, shoulder.y);
    ctx.quadraticCurveTo(shoulder.x, shoulder.y - h * 0.035, shoulder.x + h * 0.082, shoulder.y);
    ctx.quadraticCurveTo(hip.x + h * 0.1, shoulder.y + h * 0.08, hip.x + h * 0.06, hip.y);
    ctx.closePath();
    ctx.fill();

    // chest light
    ctx.fillStyle = 'rgba(200, 255, 248, 0.9)';
    ctx.beginPath();
    ctx.ellipse(shoulder.x + h * 0.005, shoulder.y + h * 0.095, h * 0.026, h * 0.038, 0.2, 0, TAU2);
    ctx.fill();
    ctx.restore();

    // ---- Front leg -----------------------------------------------------
    strokeLeg(legA, false);

    // ---- Front arm -----------------------------------------------------
    ctx.strokeStyle = '#78f6dd';
    ctx.lineWidth = h * 0.05;
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(shoulder.x + armA.elbow.x, shoulder.y + armA.elbow.y);
    ctx.lineTo(shoulder.x + armA.hand.x, shoulder.y + armA.hand.y);
    ctx.stroke();

    // ---- Head ----------------------------------------------------------
    const headX = shoulder.x + Math.sin(lean) * h * 0.02 + h * 0.012;
    const headY = shoulder.y - h * 0.098;
    ctx.save();
    ctx.shadowColor = 'rgba(90, 250, 220, 0.7)';
    ctx.shadowBlur = h * 0.12;
    ctx.fillStyle = '#d9fff8';
    ctx.beginPath();
    ctx.arc(headX, headY, h * 0.078, 0, TAU2);
    ctx.fill();
    ctx.restore();

    // visor
    ctx.fillStyle = '#ff4d9d';
    ctx.beginPath();
    ctx.ellipse(headX + h * 0.028, headY - h * 0.008, h * 0.043, h * 0.021, -0.18, 0, TAU2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.beginPath();
    ctx.ellipse(headX + h * 0.04, headY - h * 0.016, h * 0.014, h * 0.007, -0.2, 0, TAU2);
    ctx.fill();
  }

  drawSpeedLines(game) {
    if (game.power < 0.32) return;
    const ctx = this.ctx;
    const intensity = (game.power - 0.32) / 0.68;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const count = Math.floor(6 + intensity * 12);
    for (let i = 0; i < count; i += 1) {
      const seed = i * 137.5;
      const angle = ((seed * 3.7 + this.time * 90 * (0.4 + intensity)) % 360) * (Math.PI / 180);
      const radius = this.h * (0.18 + ((seed % 47) / 47) * 0.42);
      const cx = this.centerX + Math.cos(angle) * radius;
      const cy = this.horizon + Math.sin(angle) * radius * 0.55;
      if (cy > this.groundY + 20) continue;
      const len = this.h * (0.02 + intensity * 0.05);
      ctx.strokeStyle = `rgba(120, 230, 255, ${0.05 + intensity * 0.11})`;
      ctx.lineWidth = 1 + intensity * 1.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  }

  updateAndDrawParticles(dt) {
    const ctx = this.ctx;
    if (!this.particles.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.vx -= p.vx * p.drag * dt;
      p.vy -= p.vy * p.drag * dt * 0.35;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.4, p.size * alpha), 0, TAU2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPopups(dt) {
    const ctx = this.ctx;
    if (!this.popups.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = this.popups.length - 1; i >= 0; i -= 1) {
      const pop = this.popups[i];
      pop.life -= dt;
      if (pop.life <= 0) {
        this.popups.splice(i, 1);
        continue;
      }
      const t = 1 - pop.life / pop.maxLife;
      ctx.globalAlpha = clamp(pop.life / pop.maxLife + 0.15, 0, 1);
      ctx.fillStyle = pop.color;
      ctx.font = `700 ${pop.size}px "Space Grotesk", system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 8;
      ctx.fillText(pop.text, pop.x, pop.y - t * 54);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
}
