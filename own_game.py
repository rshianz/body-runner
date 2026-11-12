"""
Body Runner — an endless runner YOU control with your body.
run in place = run • lean = change lane • hand up = jump • crouch = slide
Stand still and the police catches you. Hit an obstacle = game over.

Run:  python3 body_runner.py        (pip install pygame)
"""
import math, random, threading, time
import cv2, mediapipe as mp
import pygame

# ---------- camera / pose (low latency settings) ----------
CAM_W, CAM_H  = 640, 480          # low res on purpose: faster inference
MODEL_COMPLEX = 0                 # 0 = fast model, 1 = more accurate
CAL_SECONDS   = 2.0

# ---------- gesture thresholds (same ones you already tuned) ----------
JUMP_MARGIN = 0.05                # wrist this far above nose = jump
DUCK_RATIO  = 0.75                # torso below this fraction of standing = sliding
LEAN_RANGE  = 0.13                # shoulder-centre offset that changes lane
CENTER_BAND = 0.05                # must return this close to centre
RUN_ENERGY  = 0.012               # motion level that counts as running (watch HUD!)
REQUIRE_RUN = True                # False = auto-run, body only steers

# ---------- game feel ----------
RUN_SPEED, SPEED_RAMP = 14.0, 0.04
ACCEL, BRAKE = 40.0, 6.0          # spins up fast, coasts down slowly (forgiving)
LANE_T, JUMP_TIME, PASS_H = 0.12, 0.55, 0.45 #0.55 in middle

# ---------- police ----------
POLICE_SPEED, GAP_MAX, GAP_START, POLICE_GRACE = 10.5, 30.0, 18.0, 3.0

# ---------- world ----------
Z_MAX, SPAWN_GAP0, SPAWN_GAP_MIN = 60.0, 15.0, 8.0

W, H, FPS = 1100, 700, 60
CX, HORIZON, PLAYER_Y = W // 2, int(H * 0.34), int(H * 0.86)
LANE_W, RUNNER = int(W * 0.16), 130

NOSE, LSH, RSH, LHIP, RHIP, LWR, RWR, LANK, RANK = 0, 11, 12, 23, 24, 15, 16, 27, 28
DOTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
mp_pose = mp.solutions.pose

def project(z, lane_x):
    t = 1.0 / (1.0 + z * 0.09)
    return CX + lane_x * LANE_W * t, HORIZON + (PLAYER_Y - HORIZON) * t, t

class Camera:
    """Reads frames in a background thread; read() always returns the NEWEST
    frame. Constantly draining the driver buffer removes the 100-300 ms of
    stale-frame latency you get with cap.read() in the main loop."""
    def __init__(self, w, h):
        self.cap = cv2.VideoCapture(0)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
        try: self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception: pass
        self.lock, self.frame, self.fid, self.alive = threading.Lock(), None, 0, True
        threading.Thread(target=self._loop, daemon=True).start()
    def _loop(self):
        while self.alive:
            ok, f = self.cap.read()
            if ok:
                with self.lock:
                    self.frame, self.fid = f, self.fid + 1
    def read(self):
        with self.lock:
            return self.fid, self.frame
    def stop(self):
        self.alive = False; time.sleep(0.1); self.cap.release()

class Body:
    def __init__(self):
        self.tracked, self.torso, self.dx = False, 0.35, 0.5
        self.hands_up = self.both_up = self.jump_edge = False
        self.energy, self.running = 0.0, not REQUIRE_RUN
        self._prev, self._was_up = None, False

    def update(self, res):
        self.jump_edge = False
        if not res or not res.pose_landmarks:
            self.tracked = self.hands_up = self.both_up = self.running = False
            self.energy *= 0.9
            return
        lm = res.pose_landmarks.landmark
        if lm[LHIP].visibility > 0.4 and lm[RHIP].visibility > 0.4:
            self.torso = ((lm[LHIP].y + lm[RHIP].y) - (lm[LSH].y + lm[RSH].y)) / 2
        self.dx = (lm[LSH].x + lm[RSH].x) / 2
        l_up = lm[LWR].y < lm[NOSE].y - JUMP_MARGIN
        r_up = lm[RWR].y < lm[NOSE].y - JUMP_MARGIN
        self.hands_up, self.both_up = l_up or r_up, l_up and r_up
        self.jump_edge = self.hands_up and not self._was_up   # fire once per raise
        self._was_up = self.hands_up
        # running effort = vertical motion of ankles + wrists
        pts = [lm[i].y for i in (LANK, RANK, LWR, RWR) if lm[i].visibility > 0.5]
        if pts:
            if self._prev:
                raw = sum(abs(a - b) for a, b in zip(pts, self._prev)) / len(pts)
                self.energy += 0.3 * (raw - self.energy)
            self._prev = pts
        self.tracked = True
        if not REQUIRE_RUN:
            self.running = True
        elif self.running:
            if self.energy < RUN_ENERGY * 0.6: self.running = False
        elif self.energy > RUN_ENERGY:
            self.running = True

class Game:
    def __init__(self):
        self.cal_torso, self.cal_center = 0.35, 0.5
        self.state, self.cal, self.t0 = 'cal', [], time.time()
        self.reset()

    def reset(self):
        self.distance = self.speed = self.phase = 0.0
        self.gap, self.grace = GAP_START, POLICE_GRACE
        self.lane, self.x = 0, 0.0
        self.jump_t, self.jump_h, self.slide = None, 0.0, False
        self.obs, self.next_spawn = [], Z_MAX * 0.7
        self.idle, self.over, self.restart_t = 0.0, '', 0.0

    def game_over(self, reason):
        self.state, self.over, self.restart_t = 'over', reason, 0.0

    def spawn(self, z):
        lanes = [-1, 0, 1]
        if random.random() < 0.22:                       # passable wall: jump or slide
            kind = random.choice(['low', 'high'])
            for l in lanes:
                self.obs.append({'lane': l, 'z': z, 'type': kind, 'done': False})
            return
        for l in random.sample(lanes, random.choice([1, 1, 2])):
            t = random.choices(['low', 'high', 'block'], [0.3, 0.3, 0.4])[0]
            self.obs.append({'lane': l, 'z': z, 'type': t, 'done': False})

    def update(self, body, dt):
        if self.state == 'cal':
            if body.tracked:
                self.cal.append((body.torso, body.dx))
            if time.time() - self.t0 > CAL_SECONDS and len(self.cal) > 10:
                ts = sorted(t for t, _ in self.cal); cs = sorted(c for _, c in self.cal)
                self.cal_torso, self.cal_center = ts[len(ts)//2], cs[len(cs)//2]
                self.state = 'play'
            return
        if self.state == 'over':
            self.restart_t = self.restart_t + dt if body.both_up else 0.0
            if self.restart_t > 1.2:
                self.reset(); self.state = 'play'
            return

        # --- speed comes from actually running in place ---
        running = body.tracked and body.running
        self.idle = 0.0 if running else self.idle + dt
        vmax = RUN_SPEED + min(self.distance * SPEED_RAMP, 6.0)
        target = vmax if running else 0.0
        if target > self.speed: self.speed = min(target, self.speed + ACCEL * dt)
        else:                   self.speed = max(target, self.speed - BRAKE * dt)
        self.distance += self.speed * dt
        self.phase += self.speed * dt

        # --- police: gap grows while you outrun them, shrinks when you stop ---
        if self.grace > 0: self.grace -= dt
        else: self.gap = min(GAP_MAX, self.gap + (self.speed - POLICE_SPEED) * dt)
        if self.gap <= 0: return self.game_over('caught')

        # --- lanes (lean, with dead zone so it doesn't flicker) ---
        dxc = body.dx - self.cal_center if body.tracked else 0.0
        if dxc < -LEAN_RANGE: self.lane = -1
        elif dxc > LEAN_RANGE: self.lane = 1
        elif abs(dxc) < CENTER_BAND: self.lane = 0
        self.x += (self.lane - self.x) * min(1.0, dt / LANE_T)

        # --- jump (discrete) / slide (lasts as long as you crouch) ---
        if body.jump_edge and self.jump_t is None: self.jump_t = 0.0
        if self.jump_t is not None:
            self.jump_t += dt
            if self.jump_t >= JUMP_TIME: self.jump_t = None
        self.jump_h = math.sin(math.pi * min(self.jump_t / JUMP_TIME, 1.0)) if self.jump_t is not None else 0.0
        self.slide = body.tracked and body.torso < self.cal_torso * DUCK_RATIO

        # --- obstacles ---
        gapd = max(SPAWN_GAP_MIN, SPAWN_GAP0 - self.distance * 0.01)
        while self.next_spawn - self.distance < Z_MAX:
            self.spawn(self.next_spawn - self.distance)
            self.next_spawn += gapd
        for ob in self.obs: ob['z'] -= self.speed * dt
        for ob in self.obs:
            if not ob['done'] and ob['z'] <= 0:
                ob['done'] = True
                if abs(self.x - ob['lane']) < 0.55:
                    if ob['type'] == 'low' and self.jump_h > PASS_H: pass      # jumped it
                    elif ob['type'] == 'high' and self.slide: pass              # slid under it
                    else: return self.game_over('crash')
        self.obs = [o for o in self.obs if o['z'] > -6]

def draw_runner(surf, x, y, size, act, phase, color):
    lw = max(2, int(size * 0.10))
    if act == 'slide':
        pygame.draw.ellipse(surf, color, (int(x - .55*size), int(y - .32*size), int(.85*size), int(.32*size)))
        pygame.draw.circle(surf, (255, 225, 190), (int(x + .38*size), int(y - .30*size)), int(.13*size))
        return
    sw = math.sin(phase * 2)
    hy = y - (abs(sw) * 0.03 * size if act == 'run' else 0)
    if act == 'run':
        pygame.draw.line(surf, color, (x - .04*size, hy - .46*size), (x - .30*size, hy - .04*size), lw)
        pygame.draw.line(surf, color, (x + .04*size, hy - .46*size), (x + .30*size, hy - .24*size - sw*.10*size), lw)
    elif act == 'jump':
        pygame.draw.line(surf, color, (x, hy - .46*size), (x - .26*size, hy - .18*size), lw)
        pygame.draw.line(surf, color, (x, hy - .46*size), (x + .26*size, hy - .18*size), lw)
    else:
        pygame.draw.line(surf, color, (x - .08*size, hy - .46*size), (x - .08*size, hy), lw)
        pygame.draw.line(surf, color, (x + .08*size, hy - .46*size), (x + .08*size, hy), lw)
    pygame.draw.rect(surf, color, (int(x - .15*size), int(hy - .78*size), int(.30*size), int(.34*size)),
                     border_radius=int(.10 * size))
    if act == 'run':
        pygame.draw.line(surf, color, (x, hy - .74*size), (x + sw*.28*size, hy - .52*size), lw)
        pygame.draw.line(surf, color, (x, hy - .74*size), (x - sw*.28*size, hy - .52*size), lw)
    else:
        pygame.draw.line(surf, color, (x - .15*size, hy - .74*size), (x - .22*size, hy - .52*size), lw)
        pygame.draw.line(surf, color, (x + .15*size, hy - .74*size), (x + .22*size, hy - .52*size), lw)
    pygame.draw.circle(surf, (255, 225, 190), (int(x), int(hy - .92*size)), int(.13*size))

def main():
    pygame.init()
    screen = pygame.display.set_mode((W, H))
    pygame.display.set_caption("Body Runner — run in place!")
    clock = pygame.time.Clock()
    font, mid, big = pygame.font.SysFont(None, 30), pygame.font.SysFont(None, 46), pygame.font.SysFont(None, 78)
    cam, body, game = Camera(CAM_W, CAM_H), Body(), Game()
    pose = mp_pose.Pose(model_complexity=MODEL_COMPLEX, min_detection_confidence=0.5)
    last_fid, rgb, lms = -1, None, None

    def txt(s, f, col, pos, center=False):
        r = f.render(s, True, col)
        screen.blit(r, r.get_rect(**({'center': pos} if center else {'topleft': pos})))

    def bar(x, y, wd, ht, frac, col, label):
        pygame.draw.rect(screen, (35, 35, 45), (x, y, wd, ht))
        pygame.draw.rect(screen, col, (x, y, int(wd * max(0, min(1, frac))), ht))
        txt(label, font, (230, 230, 230), (x, y - 20))

    running = True
    while running:
        dt = clock.tick(FPS) / 1000.0
        for e in pygame.event.get():
            if e.type == pygame.QUIT or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                running = False
            elif e.type == pygame.KEYDOWN and e.key == pygame.K_r and game.state == 'over':
                game.reset(); game.state = 'play'

        # pose runs only when a NEW camera frame exists (never waits, never stale)
        fid, frame = cam.read()
        if frame is not None and fid != last_fid:
            last_fid = fid
            rgb = cv2.cvtColor(cv2.flip(frame, 1), cv2.COLOR_BGR2RGB)
            res = pose.process(rgb)
            body.update(res)
            lms = res.pose_landmarks.landmark if res and res.pose_landmarks else None

        game.update(body, dt)

        # ---------- draw ----------
        screen.fill((120, 190, 240))
        pygame.draw.rect(screen, (70, 75, 90), (0, HORIZON, W, H - HORIZON))
        pygame.draw.polygon(screen, (55, 58, 68),
                            [(CX - LANE_W*2.4, H), (CX - LANE_W*.06, HORIZON),
                             (CX + LANE_W*.06, HORIZON), (CX + LANE_W*2.4, H)])
        off = game.distance % 3
        for bx in (-1.5, -0.5, 0.5, 1.5):
            i = 0
            while i * 3 - off < Z_MAX:
                z = i * 3 - off
                if z > 0.2:
                    x1, y1, t1 = project(z, bx); x2, y2, _ = project(z + 1.1, bx)
                    pygame.draw.line(screen, (235, 235, 235), (x1, y1), (x2, y2), max(1, int(5 * t1)))
                i += 1

        for ob in sorted(game.obs, key=lambda o: -o['z']):
            x, y, t = project(ob['z'], ob['lane'])
            if ob['type'] == 'low':                       # red hurdle: jump
                w, h = LANE_W*.88*t, 34*t
                pygame.draw.rect(screen, (220, 60, 60), (int(x-w/2), int(y-h), int(w), int(h)))
                for s_ in range(3):
                    pygame.draw.rect(screen, (245, 245, 245),
                                     (int(x-w/2+s_*w/3+w/12), int(y-h), int(w/6), int(h)))
            elif ob['type'] == 'high':                    # orange beam: slide under
                w = LANE_W*.88*t; top = y - 115*t
                pygame.draw.line(screen, (140, 140, 150), (x-w/2, y), (x-w/2, top), max(1, int(6*t)))
                pygame.draw.line(screen, (140, 140, 150), (x+w/2, y), (x+w/2, top), max(1, int(6*t)))
                pygame.draw.rect(screen, (255, 165, 0), (int(x-w/2), int(top-22*t), int(w), int(22*t)))
            else:                                         # blue block: dodge
                w, h = LANE_W*.95*t, 190*t
                pygame.draw.rect(screen, (60, 105, 190), (int(x-w/2), int(y-h), int(w), int(h)))
                pygame.draw.rect(screen, (200, 225, 255),
                                 (int(x-w/2+w*.12), int(y-h+h*.15), int(w*.76), int(h*.28)))

        px, py = CX + game.x * LANE_W, PLAYER_Y - game.jump_h * 95
        act = 'jump' if game.jump_t is not None else ('slide' if game.slide else ('run' if game.speed > 2 else 'idle'))
        draw_runner(screen, px, py, RUNNER, act, game.phase, (40, 90, 240))

        s = 1 - game.gap / GAP_MAX                        # police danger 0..1
        if s > 0.02:
            ppx, ppy = CX + game.x * LANE_W * .75, PLAYER_Y + 85 * s
            draw_runner(screen, ppx, ppy, RUNNER * (0.35 + 0.85 * s), 'run', game.phase * 1.2, (210, 40, 40))
            if s > 0.7 and (time.time() % 0.4) < 0.2:
                txt("!!!", big, (255, 60, 60), (int(ppx), int(ppy - RUNNER * 1.6)), center=True)

        txt(f"{game.distance:.0f} m", mid, (255, 255, 255), (W // 2, 14), center=True)
        bar(16, 60, 220, 14, game.speed / 20.0, (80, 220, 120), f"SPEED {game.speed:.0f}")
        bar(16, 105, 220, 14, body.energy / (RUN_ENERGY * 2), (255, 210, 60), f"RUN EFFORT {body.energy:.3f}")
        bar(16, 150, 220, 14, s, (235, 70, 70), "POLICE")
        pygame.draw.line(screen, (255, 255, 255), (16 + 110, 105), (16 + 110, 119), 2)   # effort threshold notch

        if game.state == 'cal':
            rem = max(0, CAL_SECONDS - (time.time() - game.t0))
            msg = f"STAND STILL — calibrating {rem:.1f}s" if game.cal else "STEP INTO FRAME"
            txt(msg, mid, (255, 255, 90), (W // 2, H // 2 - 40), center=True)
            txt("run in place = run • lean = lane • hand up = jump • crouch = slide",
                font, (255, 255, 255), (W // 2, H // 2 + 10), center=True)
        elif game.state == 'play':
            if not body.tracked:
                txt("TRACKING LOST — get back in frame!", mid, (255, 80, 80), (W // 2, H // 2 - 40), center=True)
            elif game.idle > 0.4 and (time.time() % 0.5) < 0.3:
                txt("RUN IN PLACE!", big, (255, 220, 60), (W // 2, H // 2 - 60), center=True)
            if game.speed < POLICE_SPEED and game.grace <= 0:
                tc = game.gap / max(POLICE_SPEED - game.speed, 0.5)
                txt(f"police catches you in {tc:.0f}s", font, (255, 150, 150), (W // 2, H // 2 - 10), center=True)
        else:
            dim = pygame.Surface((W, H), pygame.SRCALPHA); dim.fill((0, 0, 0, 160)); screen.blit(dim, (0, 0))
            txt("CAUGHT BY THE POLICE!" if game.over == 'caught' else "CRASHED!",
                big, (255, 90, 90), (W // 2, H // 2 - 80), center=True)
            txt(f"distance: {game.distance:.0f} m", mid, (255, 255, 255), (W // 2, H // 2 - 20), center=True)
            txt("hold both hands up" if game.restart_t > 0 else "raise both hands (or press R) to restart",
                font, (230, 230, 230), (W // 2, H // 2 + 30), center=True)

        if rgb is not None:                               # small camera preview
            PW, PH = 220, 165
            img = pygame.transform.scale(pygame.image.frombuffer(rgb.tobytes(), (CAM_W, CAM_H), 'RGB'), (PW, PH))
            pos = (W - PW - 14, H - PH - 14)
            screen.blit(img, pos)
            if lms:
                for i in DOTS:
                    p = lms[i]
                    pygame.draw.circle(screen, (120, 255, 120),
                                       (int(pos[0] + p.x * PW), int(pos[1] + p.y * PH)), 3)
            pygame.draw.rect(screen, (80, 255, 120) if body.tracked else (255, 80, 80), (*pos, PW, PH), 2)

        pygame.display.flip()

    cam.stop(); pygame.quit()

if __name__ == '__main__':
    main()