# Body Runner

A browser endless runner controlled by your body. Your webcam tracks you locally, turns
your movement into input, and puts a neon runner on a three-lane track.

- **Run in place** to build speed and score
- **Lean left / right** to switch lanes
- **Jump** over crates
- **Crouch** to slide under hanging gates
- Collect orbs for points and extra lives; three hits ends the run

No accounts, no uploads, no server. Pose inference runs in your browser with
[MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker).

## Run it

The camera API needs a secure origin, so open the game from `localhost` (not `file://`).

```bash
cd body-runner
python3 -m http.server 5173
```

Then open <http://localhost:5173> and choose **Start with camera**.

The first camera start downloads the pose engine and model from a CDN (a few MB) and
shows a loading screen. Your browser caches them for later runs.

### Keyboard fallback

No camera, or just want to try the track? Choose **Play with keyboard**:

| Action | Camera              | Keyboard          |
| ------ | ------------------- | ----------------- |
| Move   | Lean your body      | `←` `→` or `A` `D` |
| Jump   | Jump straight up    | `↑` or `W` / `Space` |
| Slide  | Crouch down         | `↓` or `S`        |
| Pause  | —                   | `P` or `Esc`      |
| Restart| —                   | `R` on the results screen |

## Camera setup

1. Stand **two to three metres** back so your head and both feet fit in the frame.
2. Keep the camera still and make sure you are reasonably lit.
3. Hold still for the short calibration countdown. This records your standing
   hip height, shoulder width and centre so the game can measure your movement
   relative to your own body.
4. Play. Press `P` to pause at any time.

Higher **Motion sensitivity** makes lane changes and jumps easier; **Fast** tracking
quality uses the lite model for lower latency on slower machines. Changes to tracking
quality apply the next time the camera starts.

## How the tracking works

- **Whole-body landmarks** from MediaPipe (33 points, one pose at a time).
- **Body-relative units.** Every threshold is expressed in torso lengths in an
  aspect-corrected space, so moving closer to or farther from the camera does not
  break the controls. A standing baseline is calibrated before each run.
- **Lane control** uses the hip centre offset from the calibrated centre, with
  hysteresis so the runner does not flicker between lanes.
- **Jump** is triggered by upward hip velocity early in the movement (with a
  height check) so the avatar leaves the ground with you rather than after you.
- **Crouch** combines hip drop and shoulder drop, again with hysteresis.
- **Run power** comes from alternating knee / ankle lift and arm swing, smoothed
  with a fast attack and a slower release.
- **One Euro filtering** on every landmark: strong smoothing while you are still,
  almost none during fast moves.
- Landmarks with low visibility are ignored, and losing the pose for a moment
  does not throw the game away.

## Latency and performance

- The camera is requested at 60fps with `latency: 0` and processed through
  `requestVideoFrameCallback`, so the newest frame is always the one being tracked
  (no queue of stale frames).
- Inference rate adapts between 24 and 60 Hz based on measured inference cost, so
  the render loop keeps its budget.
- The game renders on `requestAnimationFrame` with a fixed-step accumulator and
  damped interpolation; detection and rendering are decoupled.
- GPU inference is used when available, with an automatic CPU fallback.
- A warm-up pass hides shader/model startup cost behind the loading screen.
- Static scenery is pre-rendered per resize, gradients are cached, and particles
  come from a capped pool. HUD numbers update at about 11 Hz, not every frame.
- The HUD shows live pose FPS and inference milliseconds so you can see the cost.

## Project structure

```
index.html        layout, HUD, menus and calibration screens
styles.css        visual system (dark neon / glass UI)
src/main.js       app state, camera flow, loop, HUD wiring
src/pose.js       camera + MediaPipe Pose Landmarker, smoothing, adaptive rate
src/body.js       calibration and body metrics -> lane / jump / crouch / power
src/input.js      camera + keyboard input merge
src/game.js       runner simulation, spawning, collisions, scoring (DOM-free)
src/render.js     pseudo-3D track, parallax city, runner animation, effects
src/audio.js      small WebAudio synth (no audio assets)
src/util.js       math, easing, One Euro filter
```

The `game.js` simulation has no DOM dependencies and can be exercised headlessly.

## Scoring

- Distance and time add to your score continuously.
- Passing obstacles builds a combo; every 4 dodges increases the multiplier
  (up to ×4).
- Orbs are worth points; every 12 orbs gives a life (or a bonus when full).
- A hit costs a life, resets the combo, and slows time for a moment.

Your best score is stored in `localStorage` on this device.

## Privacy

Video frames are drawn to a canvas and fed to the local pose model. Nothing is
recorded, uploaded or persisted. The only network requests are the page's own
assets, Google Fonts, and the MediaPipe engine/model files loaded from a CDN.

## Troubleshooting

**The camera button says BLOCKED** — allow camera access for `localhost` in the
browser's site settings. On macOS also check System Settings → Privacy & Security →
Camera. The keyboard mode always works.

**"No body detected"** — step back so your feet are visible, add light, avoid
standing directly in front of a bright window, and keep the camera still. Press
the main menu and start the camera again to recalibrate.

**Low pose FPS** — switch Tracking quality to **Fast**, close other GPU-heavy tabs,
and make sure the browser is using hardware acceleration.

**Nothing loads** — the first run needs internet access for the pose engine and
model. If your network blocks the CDN, use keyboard mode; the game itself is fully
local.

## Browser support

Recent Chrome, Edge, Safari or Firefox with WebGL and `getUserMedia`. Chrome-based
browsers get the best GPU pose performance.
