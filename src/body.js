// Turns 33 raw pose landmarks into game inputs and a run "power" reading.
//
// Everything is measured in torso-length units in an aspect-corrected space, so
// thresholds do not change when the player moves closer to or further from the
// camera. A calibrated standing baseline is captured at the start of each run.

import { LM } from './pose.js';
import { clamp, damp } from './util.js';

const CALIBRATION_SAMPLES = 36;

const point = (landmark, aspect) => ({
  x: (1 - landmark.x) * aspect,
  y: landmark.y,
  v: landmark.visibility == null ? 1 : landmark.visibility,
});

function weightedMid(a, b) {
  const wa = Math.max(0, a.v);
  const wb = Math.max(0, b.v);
  const sum = wa + wb;
  if (sum < 1e-5) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: 0 };
  return { x: (a.x * wa + b.x * wb) / sum, y: (a.y * wa + b.y * wb) / sum, v: Math.max(a.v, b.v) };
}

function readBody(lm, aspect) {
  const p = (i) => point(lm[i], aspect);
  const lShoulder = p(LM.L_SHOULDER);
  const rShoulder = p(LM.R_SHOULDER);
  const lHip = p(LM.L_HIP);
  const rHip = p(LM.R_HIP);
  const lKnee = p(LM.L_KNEE);
  const rKnee = p(LM.R_KNEE);
  const lAnkle = p(LM.L_ANKLE);
  const rAnkle = p(LM.R_ANKLE);
  const lWrist = p(LM.L_WRIST);
  const rWrist = p(LM.R_WRIST);

  const shoulder = weightedMid(lShoulder, rShoulder);
  const hip = weightedMid(lHip, rHip);
  const knee = weightedMid(lKnee, rKnee);
  const ankle = weightedMid(lAnkle, rAnkle);
  const wrist = weightedMid(lWrist, rWrist);

  const torso = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
  const shoulderW = Math.hypot(lShoulder.x - rShoulder.x, lShoulder.y - rShoulder.y);
  const torsoVisible = (shoulder.v > 0.35 && hip.v > 0.35) || torso > 0.055;
  const confidence = clamp(
    (lShoulder.v + rShoulder.v + lHip.v + rHip.v + Math.min(lAnkle.v, rAnkle.v)) / 5,
    0,
    1
  );

  return {
    lShoulder,
    rShoulder,
    lHip,
    rHip,
    lKnee,
    rKnee,
    lAnkle,
    rAnkle,
    lWrist,
    rWrist,
    shoulder,
    hip,
    knee,
    ankle,
    wrist,
    torso,
    shoulderW,
    valid: torsoVisible && confidence > 0.3,
    confidence,
  };
}

export class BodyReader {
  constructor() {
    this.sensitivity = 1;
    this.calibration = {
      active: false,
      samples: [],
      progress: 0,
      complete: false,
    };
    this.baseline = null;
    this.laneFloat = 0;
    this.lane = 0;
    this.duckDepth = 0;
    this.ducking = false;
    this.power = 0;
    this.motion = 0;
    this.hipRise = 0;
    this.hipVelocity = 0;
    this.prevSwing = null;
    this.prevArmSwing = null;
    this.lastJumpAt = -10000;
    this.lastUpdate = 0;
    this.lastSeenAt = 0;
    this.lastValid = false;
    this.lastMetrics = null;
  }

  beginCalibration() {
    this.calibration = {
      active: true,
      samples: [],
      progress: 0,
      complete: false,
    };
    this.baseline = null;
    this.calibrationStartedAt = performance.now();
  }

  cancelCalibration() {
    this.calibration.active = false;
    this.calibration.complete = false;
    this.calibration.progress = 0;
    this.calibration.samples = [];
  }

  finishCalibration() {
    const samples = this.calibration.samples;
    if (samples.length < 8) return false;
    const avg = (key) => samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
    this.baseline = {
      centerX: avg('centerX'),
      hipY: avg('hipY'),
      shoulderY: avg('shoulderY'),
      torso: Math.max(avg('torso'), 0.03),
      shoulderW: Math.max(avg('shoulderW'), 0.03),
      kneeY: avg('kneeY'),
      ankleY: avg('ankleY'),
    };
    this.calibration.active = false;
    this.calibration.complete = true;
    this.laneFloat = 0;
    this.lane = 0;
    this.ducking = false;
    this.duckDepth = 0;
    this.power = 0;
    this.motion = 0;
    this.prevSwing = null;
    this.prevArmSwing = null;
    return true;
  }

  get calibrated() {
    return Boolean(this.baseline) && this.calibration.complete;
  }

  /**
   * @param {Array|null} landmarks smoothed landmarks (mirrored inside)
   * @param {number} nowMs timestamp from the tracker
   * @param {number} aspect video width / height
   */
  update(landmarks, nowMs, aspect = 4 / 3) {
    const dt = clamp((nowMs - this.lastUpdate) / 1000, 1 / 240, 0.12);
    this.lastUpdate = nowMs;

    if (!landmarks || landmarks.length < 33) {
      this.lastValid = false;
      this.power = damp(this.power, 0, 2.5, dt);
      this.motion = damp(this.motion, 0, 2.5, dt);
      this.ducking = false;
      return this.emit({
        valid: false,
        calibrating: this.calibration.active,
        progress: this.calibration.progress,
        calibrationComplete: false,
        lane: this.lane,
        laneFloat: this.laneFloat,
        ducking: false,
        jump: false,
        power: this.power,
        motion: this.motion,
      });
    }

    const body = readBody(landmarks, aspect);
    this.lastValid = body.valid;
    if (!body.valid) {
      this.power = damp(this.power, 0, 3, dt);
      this.motion = damp(this.motion, 0, 3, dt);
      this.ducking = false;
      return this.emit({
        valid: false,
        calibrating: this.calibration.active,
        progress: this.calibration.progress,
        calibrationComplete: false,
        lane: this.lane,
        laneFloat: this.laneFloat,
        ducking: false,
        jump: false,
        power: this.power,
        motion: this.motion,
        confidence: body.confidence,
      });
    }

    this.lastSeenAt = nowMs;

    if (this.calibration.active) {
      const rawCenter = body.hip.x;
      this.calibration.samples.push({
        centerX: rawCenter,
        hipY: body.hip.y,
        shoulderY: body.shoulder.y,
        torso: body.torso,
        shoulderW: body.shoulderW,
        kneeY: body.knee.y,
        ankleY: body.ankle.y,
      });
      this.calibration.progress = clamp(
        this.calibration.samples.length / CALIBRATION_SAMPLES,
        0,
        1
      );
      if (this.calibration.samples.length >= CALIBRATION_SAMPLES) {
        const complete = this.finishCalibration();
        return this.emit({
          valid: true,
          calibrating: false,
          progress: 1,
          calibrationComplete: complete,
          lane: 0,
          laneFloat: 0,
          ducking: false,
          jump: false,
          power: 0,
          motion: 0,
          confidence: body.confidence,
        });
      }
      return this.emit({
        valid: true,
        calibrating: true,
        progress: this.calibration.progress,
        calibrationComplete: false,
        lane: 0,
        laneFloat: 0,
        ducking: false,
        jump: false,
        power: 0,
        motion: 0,
        confidence: body.confidence,
      });
    }

    if (!this.baseline) {
      return this.emit({
        valid: true,
        calibrating: false,
        progress: 0,
        calibrationComplete: false,
        lane: 0,
        laneFloat: 0,
        ducking: false,
        jump: false,
        power: 0,
        motion: 0,
        confidence: body.confidence,
      });
    }

    const base = this.baseline;
    const scale = clamp(body.torso, base.torso * 0.65, base.torso * 1.45);

    // ---- Horizontal lane -------------------------------------------------
    const span = clamp(base.shoulderW * 0.42 + 0.055, 0.075, 0.34) / this.sensitivity;
    const rawLane = clamp((body.hip.x - base.centerX) / span, -1.5, 1.5);
    this.laneFloat = damp(this.laneFloat, rawLane, 11, dt);

    const prevLane = this.lane;
    if (this.lane === 0) {
      if (this.laneFloat > 0.48) this.lane = 1;
      else if (this.laneFloat < -0.48) this.lane = -1;
    } else if (this.lane === 1) {
      if (this.laneFloat < 0.16) this.lane = this.laneFloat < -0.48 ? -1 : 0;
    } else {
      if (this.laneFloat > -0.16) this.lane = this.laneFloat > 0.48 ? 1 : 0;
    }

    // ---- Vertical: jump and crouch --------------------------------------
    const hipRiseRaw = (base.hipY - body.hip.y) / scale;
    const hipDropRaw = (body.hip.y - base.hipY) / scale;
    const shoulderDropRaw = (body.shoulder.y - base.shoulderY) / scale;
    const prevHipRiseRaw = this.prevHipRiseRaw == null ? hipRiseRaw : this.prevHipRiseRaw;
    const hipVelRaw = clamp((hipRiseRaw - prevHipRiseRaw) / dt, -12, 12);
    this.prevHipRiseRaw = hipRiseRaw;
    this.hipVelocity = damp(this.hipVelocity, hipVelRaw, 24, dt);
    this.hipRise = damp(this.hipRise, hipRiseRaw, 22, dt);

    const rawDuck = (hipDropRaw * 0.55 + shoulderDropRaw * 0.70) * 0.75;
    this.duckDepth = damp(this.duckDepth, rawDuck, 18, dt);
    if (!this.ducking && this.duckDepth > 0.30) this.ducking = true;
    else if (this.ducking && this.duckDepth < 0.13) this.ducking = false;

    let jump = false;
    const hipRise = this.hipRise;
    const risingFast = hipRise > 0.16 && this.hipVelocity > 0.55;
    const clearlyAirborne = hipRise > 0.42;
    if (
      (risingFast || clearlyAirborne) &&
      this.duckDepth < 0.24 &&
      nowMs - this.lastJumpAt > 400
    ) {
      jump = true;
      this.lastJumpAt = nowMs;
    }

    // ---- Run effort ------------------------------------------------------
    const liftL = Math.max(
      0,
      ((base.kneeY - body.lKnee.y) * 0.55 + (base.ankleY - body.lAnkle.y) * 0.45) / scale
    );
    const liftR = Math.max(
      0,
      ((base.kneeY - body.rKnee.y) * 0.55 + (base.ankleY - body.rAnkle.y) * 0.45) / scale
    );
    const swing = liftL - liftR;
    const armL = (body.lWrist.y - body.shoulder.y) / scale;
    const armR = (body.rWrist.y - body.shoulder.y) / scale;
    const armSwing = armL - armR;

    let legRate = 0;
    let armRate = 0;
    if (this.prevSwing !== null && dt > 0) {
      legRate = Math.abs(swing - this.prevSwing) / dt;
      armRate = Math.abs(armSwing - this.prevArmSwing) / dt;
    }
    this.prevSwing = swing;
    this.prevArmSwing = armSwing;

    const rawMotion = Math.min(legRate, 22) + Math.min(armRate, 22) * 0.4;
    this.motion = damp(this.motion, rawMotion, 9, dt);
    const targetPower = clamp((this.motion - 1.1) / 4.4, 0, 1);
    this.power =
      targetPower > this.power
        ? damp(this.power, targetPower, 11, dt)
        : damp(this.power, targetPower, 2.4, dt);

    // Occasional single-landmark wobble should not steer the runner.
    if (prevLane !== this.lane) {
      this.laneChangedAt = nowMs;
    }

    return this.emit({
      valid: true,
      calibrating: false,
      progress: 1,
      calibrationComplete: false,
      lane: this.lane,
      laneFloat: this.laneFloat,
      laneChanged: prevLane !== this.lane,
      ducking: this.ducking,
      jump,
      power: this.power,
      motion: this.motion,
      hipRise,
      crouch: this.duckDepth,
      confidence: body.confidence,
      body,
    });
  }

  emit(metrics) {
    this.lastMetrics = metrics;
    return metrics;
  }
}
