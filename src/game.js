// Deterministic-ish runner simulation. No DOM access, so it can be tested
// headlessly. Obstacles live in metres on the z axis and are projected by the
// renderer; collisions are resolved on the player's plane.

import { clamp, damp, rnd, rndInt } from './util.js';

const SPAWN_Z = 58;
const GRAVITY = 20.5;
const JUMP_VELOCITY = 7.0;
const PLAYER_HEIGHT = 1; // player-heights, used for collision boxes
const SLIDE_HEIGHT = 0.42;

const safeStorage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};

export class Game {
  constructor() {
    this.best = Number(safeStorage.get('bodyrunner.best') || 0) || 0;
    this.reset();
    this.mode = 'ambient';
    this.time = 0;
    this.worldZ = 0;
    this.distance = 0;
    this.power = 0.2;
    this.laneVisual = 0;
    this.slideVisual = 0;
    this.landSquash = 0;
    this.invuln = 0;
    this.shake = 0;
    this.flash = 0;
  }

  reset() {
    this.mode = 'ambient';
    this.time = 0;
    this.worldZ = 0;
    this.distance = 0;
    this.score = 0;
    this.speed = 20;
    this.power = 0;
    this.lane = 0;
    this.laneVisual = 0;
    this.tilt = 0;
    this.jumpH = 0;
    this.vy = 0;
    this.grounded = true;
    this.sliding = false;
    this.slideVisual = 0;
    this.landSquash = 0;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.invuln = 0;
    this.hearts = 3;
    this.maxHearts = 3;
    this.combo = 0;
    this.bestCombo = 0;
    this.mult = 1;
    this.orbs = 0;
    this.orbsToHeart = 0;
    this.hits = 0;
    this.dodges = 0;
    this.timeScale = 1;
    this.shake = 0;
    this.flash = 0;
    this.obstacles = [];
    this.pickups = [];
    this.events = [];
    this.nextSpawnAt = 0;
    this.nextPickupAt = 0;
    this.lastWavePair = false;
    this.lastWasWide = false;
    this.gameOverAt = 0;
  }

  startRun() {
    this.reset();
    this.mode = 'running';
    this.nextSpawnAt = 15;
    this.nextPickupAt = 7;
    this.emit({ type: 'start' });
  }

  emit(event) {
    this.events.push(event);
    if (this.events.length > 60) this.events.shift();
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  updateAmbient(dt) {
    this.time += dt;
    this.worldZ += 19 * dt;
    this.distance += 19 * dt;
    this.power = damp(this.power, 0.24, 2, dt);
    this.laneVisual = Math.sin(this.time * 0.55) * 0.28;
    this.slideVisual = damp(this.slideVisual, 0, 10, dt);
    this.landSquash = Math.max(0, this.landSquash - dt * 4);
    this.invuln = 0;
    this.shake = 0;
    this.flash = Math.max(0, this.flash - dt * 3);
  }

  update(rawDt, input) {
    const dtClamped = Math.min(rawDt, 0.05);
    this.timeScale = Math.min(1, this.timeScale + dtClamped * 2.4);
    const dt = dtClamped * this.timeScale;

    this.flash = Math.max(0, this.flash - dt * 3.2);
    this.shake = Math.max(0, this.shake - dt * 2.8);

    if (this.mode === 'over') {
      this.power = damp(this.power, 0, 4, dt);
      this.slideVisual = damp(this.slideVisual, 0, 8, dt);
      return;
    }
    if (this.mode !== 'running') return;

    this.time += dt;
    this.power = damp(this.power, input.power, 5.5, dt);
    this.invuln = Math.max(0, this.invuln - dt);

    const ramp = Math.min(18, this.time * 0.30);
    this.speed = 19 + 15.5 * this.power + ramp;
    this.worldZ += this.speed * dt;
    this.distance += this.speed * dt;
    this.score += this.speed * dt * 1.9 * this.mult;

    // ---- Horizontal movement -------------------------------------------
    this.lane = input.lane;
    const prevLaneVisual = this.laneVisual;
    this.laneVisual = damp(this.laneVisual, this.lane, 15, dt);
    const laneVelocity = (this.laneVisual - prevLaneVisual) / Math.max(dt, 1 / 240);
    this.tilt = damp(this.tilt, clamp(laneVelocity * 0.055, -0.22, 0.22), 10, dt);

    // ---- Slide ----------------------------------------------------------
    const wantsSlide = input.duck && this.grounded;
    if (wantsSlide) this.sliding = true;
    else if (!input.duck) this.sliding = false;
    if (!this.grounded) this.sliding = false;
    this.slideVisual = damp(this.slideVisual, this.sliding ? 1 : 0, 18, dt);

    // ---- Jump -----------------------------------------------------------
    if (input.jump) this.jumpBuffer = 0.15;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.grounded) this.coyote = 0.09;
    else this.coyote = Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      this.jump();
      this.jumpBuffer = 0;
    }

    if (!this.grounded) {
      let gravity = GRAVITY;
      if (input.duck) gravity += 16; // fast-fall feels responsive
      this.vy -= gravity * dt;
      this.jumpH += this.vy * dt;
      if (this.jumpH <= 0) {
        this.jumpH = 0;
        this.vy = 0;
        this.grounded = true;
        this.landSquash = 1;
        this.emit({ type: 'land' });
      }
    }
    this.landSquash = Math.max(0, this.landSquash - dt * 5);

    // ---- Spawning -------------------------------------------------------
    if (this.distance >= this.nextSpawnAt) {
      this.spawnWave();
      const gap = 14 + this.speed * 0.34 + rnd(0, 3);
      this.nextSpawnAt = this.distance + gap;
    }
    if (this.distance >= this.nextPickupAt) {
      this.spawnPickups();
      this.nextPickupAt = this.distance + rnd(9, 16);
    }

    this.updateObstacles(dt);
    this.updatePickups(dt);

    if (this.mode === 'over') this.gameOverAt = performance.now();
  }

  jump() {
    this.vy = JUMP_VELOCITY;
    this.grounded = false;
    this.coyote = 0;
    this.sliding = false;
    this.slideVisual = 0;
    this.emit({ type: 'jump', lane: this.laneVisual, jumpH: this.jumpH });
  }

  spawnWave() {
    const canPair = this.time > 17 && !this.lastWavePair;
    const canWide = this.time > 26 && !this.lastWasWide;
    const roll = Math.random();

    if (canWide && roll < 0.11) {
      this.addObstacle('bar', 0, { wide: true });
      this.lastWasWide = true;
      this.lastWavePair = false;
      return;
    }
    this.lastWasWide = false;

    if (canPair && roll < 0.4) {
      const firstLane = rndInt(-1, 1);
      let secondLane = rndInt(-1, 1);
      while (secondLane === firstLane) secondLane = rndInt(-1, 1);
      const typeA = Math.random() < 0.5 ? 'block' : 'bar';
      const typeB = Math.random() < 0.5 ? 'block' : 'bar';
      this.addObstacle(typeA, firstLane);
      this.addObstacle(typeB, secondLane);
      this.lastWavePair = true;
      return;
    }

    this.lastWavePair = false;
    const lane = rndInt(-1, 1);
    const type = Math.random() < 0.52 ? 'block' : 'bar';
    this.addObstacle(type, lane);
  }

  addObstacle(type, lane, { wide = false } = {}) {
    this.obstacles.push({
      type,
      lane,
      wide,
      z: SPAWN_Z,
      resolved: false,
      hit: false,
      seed: Math.random(),
      resolveDelay: 0,
    });
  }

  spawnPickups() {
    const lane = rndInt(-1, 1);
    const count = Math.random() < 0.35 ? 3 : 1;
    for (let i = 0; i < count; i += 1) {
      this.pickups.push({
        lane,
        z: SPAWN_Z + i * 4.2,
        collected: false,
        seed: Math.random(),
      });
    }
  }

  playerBoxHeight() {
    return PLAYER_HEIGHT + (SLIDE_HEIGHT - PLAYER_HEIGHT) * this.slideVisual;
  }

  updateObstacles(dt) {
    const laneTolerance = 0.52;
    for (const obstacle of this.obstacles) {
      const previousZ = obstacle.z;
      obstacle.z -= this.speed * dt;
      if (obstacle.resolved) continue;

      // `previousZ >= -0.4` keeps a collision detectable even when a slow frame
      // steps the obstacle past the whole player plane in one go.
      const inWindow = obstacle.z <= 0.55 && previousZ >= -0.4;
      if (inWindow) {
        const laneClose = obstacle.wide || Math.abs(obstacle.lane - this.laneVisual) < laneTolerance;
        if (laneClose && this.collides(obstacle)) {
          obstacle.resolved = true;
          obstacle.hit = true;
          this.hit(obstacle);
          continue;
        }
      }

      if (obstacle.z < -0.45) {
        obstacle.resolved = true;
        if (!obstacle.hit) this.passedObstacle(obstacle);
      }
    }
    this.obstacles = this.obstacles.filter((o) => o.z > -5);
  }

  collides(obstacle) {
    const feet = this.jumpH;
    if (obstacle.type === 'block') {
      return feet < 0.48;
    }
    // Hanging barrier: the only way through is a low profile.
    const top = feet + this.playerBoxHeight();
    return feet < 1.75 && top > 0.92;
  }

  passedObstacle(obstacle) {
    this.dodges += 1;
    this.combo += 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.mult = 1 + Math.min(3, Math.floor(this.combo / 4) * 0.25);
    const bonus = 12 * this.mult;
    this.score += bonus;
    this.emit({
      type: 'dodge',
      lane: obstacle.wide ? this.laneVisual : obstacle.lane,
      combo: this.combo,
      wide: obstacle.wide,
    });
  }

  updatePickups(dt) {
    for (const pickup of this.pickups) {
      const previousZ = pickup.z;
      pickup.z -= this.speed * dt;
      if (pickup.collected) continue;
      if (pickup.z <= 1.1 && previousZ >= -0.4) {
        if (Math.abs(pickup.lane - this.laneVisual) < 0.58) {
          pickup.collected = true;
          this.collectOrb(pickup);
        }
      }
    }
    this.pickups = this.pickups.filter((p) => p.z > -3 && !(p.collected && p.z < 0.5));
  }

  collectOrb(pickup) {
    this.orbs += 1;
    this.orbsToHeart += 1;
    const gain = 45 * this.mult;
    this.score += gain;
    this.emit({ type: 'orb', lane: pickup.lane, gain });
    if (this.orbsToHeart >= 12) {
      this.orbsToHeart = 0;
      if (this.hearts < this.maxHearts) {
        this.hearts += 1;
        this.emit({ type: 'heart', lane: pickup.lane });
      } else {
        this.score += 250;
        this.emit({ type: 'bonus', lane: pickup.lane, gain: 250 });
      }
    }
  }

  hit(obstacle) {
    if (this.invuln > 0) return;
    this.hearts -= 1;
    this.hits += 1;
    this.combo = 0;
    this.mult = 1;
    this.invuln = 1.75;
    this.timeScale = 0.34;
    this.shake = 1;
    this.flash = 1;
    this.emit({
      type: 'hit',
      lane: obstacle.lane,
      wide: obstacle.wide,
      hearts: this.hearts,
      obstacleType: obstacle.type,
    });
    if (this.hearts <= 0) this.gameOver();
  }

  gameOver() {
    this.hearts = 0;
    this.mode = 'over';
    this.timeScale = 0.5;
    const finalScore = Math.floor(this.score);
    this.isBest = finalScore > this.best;
    if (this.isBest) {
      this.best = finalScore;
      safeStorage.set('bodyrunner.best', String(finalScore));
    }
    this.emit({ type: 'gameover', score: finalScore, best: this.best });
  }
}
