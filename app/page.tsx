"use client";
import React, { useEffect, useRef, useState } from "react";

// 2D Space Game: Asteroids + Dogfights (single file, drop-in for app/page.tsx)
// Controls: WASD/Arrow keys to move, Mouse to aim, Left Click/Space to shoot, Shift to boost, P to pause, R to restart.
// Works on desktop; basic touch support provided (left joystick + tap to shoot/aim).

// ======= Utility types =======
type Vec = { x: number; y: number };

function v(x = 0, y = 0): Vec { return { x, y }; }
function add(a: Vec, b: Vec): Vec { return { x: a.x + b.x, y: a.y + b.y }; }
function sub(a: Vec, b: Vec): Vec { return { x: a.x - b.x, y: a.y - b.y }; }
function mul(a: Vec, s: number): Vec { return { x: a.x * s, y: a.y * s }; }
function len(a: Vec): number { return Math.hypot(a.x, a.y); }
function norm(a: Vec): Vec { const L = len(a) || 1; return { x: a.x / L, y: a.y / L }; }
function rot(a: Vec, angle: number): Vec { const c = Math.cos(angle), s = Math.sin(angle); return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }; }
function clamp(val: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, val)); }
function rand(min: number, max: number): number { return Math.random() * (max - min) + min; }
function randSign(): number { return Math.random() < 0.5 ? -1 : 1; }
function wrap(p: Vec, w: number, h: number) { if (p.x < 0) p.x += w; if (p.x >= w) p.x -= w; if (p.y < 0) p.y += h; if (p.y >= h) p.y -= h; }

// ======= Input =======
class Input {
  keys = new Set<string>();
  mouse = { pos: v(), down: false };
  touches: { id: number; pos: Vec }[] = [];
  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    canvas.addEventListener("mousedown", () => (this.mouse.down = true));
    canvas.addEventListener("mouseup", () => (this.mouse.down = false));
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouse.pos = v(e.clientX - rect.left, e.clientY - rect.top);
    });
    // Touch (very simple: first touch = move stick, second touch/tap = fire towards it)
    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.touches = [...e.touches].map((t) => ({ id: t.identifier, pos: v(t.clientX, t.clientY) }));
      if (e.touches.length === 1) this.mouse.down = false;
      if (e.touches.length >= 2) this.mouse.down = true; // tap/hold to shoot
    }, { passive: false });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      this.touches = [...e.touches].map((t) => ({ id: t.identifier, pos: v(t.clientX, t.clientY) }));
    }, { passive: false });
    canvas.addEventListener("touchend", (e) => {
      e.preventDefault();
      this.touches = [...e.touches].map((t) => ({ id: t.identifier, pos: v(t.clientX, t.clientY) }));
      if (e.touches.length < 2) this.mouse.down = false;
    });
  }
  get axis(): Vec {
    const up = this.keys.has("w") || this.keys.has("arrowup") ? -1 : 0;
    const down = this.keys.has("s") || this.keys.has("arrowdown") ? 1 : 0;
    const left = this.keys.has("a") || this.keys.has("arrowleft") ? -1 : 0;
    const right = this.keys.has("d") || this.keys.has("arrowright") ? 1 : 0;
    let ax = v(left + right, up + down);
    if (ax.x !== 0 || ax.y !== 0) ax = norm(ax);
    // Touch joystick (bottom-left quadrant)
    if (this.touches.length > 0) {
      const t = this.touches[0].pos;
      const W = window.innerWidth, H = window.innerHeight;
      const center = v(W * 0.2, H * 0.8);
      const dir = norm(sub(t, center));
      ax = { x: clamp(dir.x, -1, 1), y: clamp(dir.y, -1, 1) };
    }
    return ax;
  }
}

// ======= Audio (minimal bleeps) =======
class Sfx {
  ctx?: AudioContext;
  enabled = true;
  private ensure() { if (!this.ctx && typeof window !== "undefined") this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); }
  tone(freq: number, dur = 0.1, type: OscillatorType = "square", vol = 0.2) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  shoot() { this.tone(880, 0.07, "square", 0.15); }
  explode() { this.tone(80 + Math.random() * 60, 0.3, "sawtooth", 0.25); }
  hit() { this.tone(240, 0.08, "triangle", 0.12); }
  pickup() { this.tone(660, 0.15, "triangle", 0.15); }
}

// ======= Entities =======
interface Body { pos: Vec; vel: Vec; radius: number; alive: boolean; }

class Bullet implements Body {
  pos = v(); vel = v(); radius = 3; alive = true; fromPlayer = true; ttl = 1.2;
  constructor(p: Vec, v_: Vec, fromPlayer: boolean) { this.pos = { ...p }; this.vel = { ...v_ }; this.fromPlayer = fromPlayer; }
  update(dt: number, W: number, H: number) { this.ttl -= dt; if (this.ttl <= 0) this.alive = false; this.pos = add(this.pos, mul(this.vel, dt)); wrap(this.pos, W, H); }
  render(g: CanvasRenderingContext2D) { g.save(); g.translate(this.pos.x, this.pos.y); g.beginPath(); g.arc(0, 0, this.radius, 0, Math.PI * 2); g.fillStyle = this.fromPlayer ? "#f9f871" : "#ff6b6b"; g.fill(); g.restore(); }
}

class Particle implements Body {
  pos = v(); vel = v(); radius = 2; alive = true; ttl = 0.6; color = "white";
  constructor(p: Vec, v_: Vec, color = "white", ttl = 0.6) { this.pos = { ...p }; this.vel = { ...v_ }; this.color = color; this.ttl = ttl; }
  update(dt: number, W: number, H: number) { this.ttl -= dt; if (this.ttl <= 0) this.alive = false; this.pos = add(this.pos, mul(this.vel, dt)); this.vel = mul(this.vel, 0.98); wrap(this.pos, W, H); }
  render(g: CanvasRenderingContext2D) { g.save(); g.globalAlpha = clamp(this.ttl, 0, 1); g.translate(this.pos.x, this.pos.y); g.fillStyle = this.color; g.beginPath(); g.arc(0, 0, this.radius, 0, Math.PI * 2); g.fill(); g.restore(); }
}

class Asteroid implements Body {
  pos = v(); vel = v(); radius = 30; alive = true; rot = 0; spin = rand(-1, 1); verts: Vec[] = []; level = 3; // 3->2->1
  constructor(p: Vec, size = 30, level = 3) {
    this.pos = { ...p }; this.radius = size; this.level = level; this.vel = v(rand(-30, 30), rand(-30, 30));
    const count = 8 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) { const ang = (i / count) * Math.PI * 2; const r = size * rand(0.7, 1.2); this.verts.push(rot(v(r, 0), ang)); }
  }
  update(dt: number, W: number, H: number) { this.rot += this.spin * dt; this.pos = add(this.pos, mul(this.vel, dt)); wrap(this.pos, W, H); }
  render(g: CanvasRenderingContext2D) { g.save(); g.translate(this.pos.x, this.pos.y); g.rotate(this.rot); g.strokeStyle = "#cdd6f4"; g.lineWidth = 2; g.beginPath(); this.verts.forEach((pt, i) => i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)); g.closePath(); g.stroke(); g.restore(); }
}

class Ship implements Body {
  pos = v(); vel = v(); radius = 14; alive = true; angle = 0; cooldown = 0; boost = 1; boostCD = 0; color = "#89b4fa";
  constructor(p: Vec) { this.pos = { ...p }; }
  update(dt: number, W: number, H: number, input: Input) {
    const aim = input.mouse.pos.x ? sub(input.mouse.pos, this.pos) : v(1, 0);
    this.angle = Math.atan2(aim.y, aim.x);
    const accel = 220; const drag = 0.9; const maxSpd = 320;
    const a = input.axis; this.vel.x += a.x * accel * dt; this.vel.y += a.y * accel * dt;
    if (input.keys.has("shift")) this.tryBoost();
    this.vel = mul(this.vel, Math.pow(drag, dt * 60));
    const spd = len(this.vel); if (spd > maxSpd * this.boost) this.vel = mul(norm(this.vel), maxSpd * this.boost);
    this.pos = add(this.pos, mul(this.vel, dt)); wrap(this.pos, W, H);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.boostCD = Math.max(0, this.boostCD - dt);
  }
  tryBoost() { if (this.boostCD <= 0) { this.boost = 1.8; this.boostCD = 3; setTimeout(() => (this.boost = 1), 300); } }
  canShoot() { return this.cooldown <= 0; }
  shoot(target: Vec, bullets: Bullet[], sfx: Sfx) {
    if (!this.canShoot()) return; this.cooldown = 0.15;
    const dir = norm(sub(target, this.pos));
    bullets.push(new Bullet(add(this.pos, mul(dir, this.radius + 6)), add(mul(dir, 520), this.vel), true));
    sfx.shoot();
  }
  render(g: CanvasRenderingContext2D) {
    g.save(); g.translate(this.pos.x, this.pos.y); g.rotate(this.angle);
    // Futuristic delta-wing with glowing cockpit
    g.lineWidth = 2; g.strokeStyle = this.color; g.fillStyle = "rgba(137,180,250,0.15)";
    g.beginPath(); g.moveTo(18, 0); g.lineTo(-12, -10); g.lineTo(-6, 0); g.lineTo(-12, 10); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(0, 0, 6, 4, 0, 0, Math.PI * 2); g.fillStyle = "#94e2d5"; g.fill();
    // Thruster glow
    g.beginPath(); g.moveTo(-14, 0); g.lineTo(-20, -3); g.lineTo(-20, 3); g.closePath(); g.fillStyle = "#f5c2e7"; g.fill();
    g.restore();
  }
}

class Enemy implements Body {
  pos = v(); vel = v(); radius = 16; alive = true; angle = 0; cooldown = rand(0.2, 0.8); kind: "dart" | "ufo" = Math.random() < 0.6 ? "dart" : "ufo";
  constructor(p: Vec) { this.pos = { ...p }; this.vel = v(rand(-80, 80), rand(-80, 80)); }
  update(dt: number, W: number, H: number, target: Ship, bullets: Bullet[], sfx: Sfx) {
    // Simple steering seek + some jitter
    const desired = norm(sub(target.pos, this.pos));
    const steer = add(desired, v(rand(-0.3, 0.3), rand(-0.3, 0.3)));
    const acc = mul(norm(steer), this.kind === "dart" ? 120 : 80);
    this.vel = add(this.vel, mul(acc, dt));
    const maxV = this.kind === "dart" ? 240 : 160; const drag = 0.96;
    if (len(this.vel) > maxV) this.vel = mul(norm(this.vel), maxV);
    this.vel = mul(this.vel, Math.pow(drag, dt * 60));
    this.pos = add(this.pos, mul(this.vel, dt)); wrap(this.pos, W, H);
    this.angle = Math.atan2(this.vel.y, this.vel.x);
    // Fire periodically when roughly aligned
    this.cooldown -= dt;
    const toPlayer = sub(target.pos, this.pos); const dist = len(toPlayer);
    const dir = norm(toPlayer);
    const facing = Math.cos(this.angle - Math.atan2(dir.y, dir.x));
    if (this.cooldown <= 0 && dist < 520 && facing > 0.5) {
      this.cooldown = this.kind === "dart" ? rand(0.5, 1.2) : rand(0.8, 1.6);
      bullets.push(new Bullet(add(this.pos, mul(dir, this.radius + 4)), add(mul(dir, 360), this.vel), false));
      sfx.shoot();
    }
  }
  render(g: CanvasRenderingContext2D) {
    g.save(); g.translate(this.pos.x, this.pos.y); g.rotate(this.angle);
    g.lineWidth = 2; g.strokeStyle = this.kind === "dart" ? "#fab387" : "#f38ba8"; g.fillStyle = this.kind === "dart" ? "rgba(250,179,135,0.15)" : "rgba(243,139,168,0.15)";
    if (this.kind === "dart") {
      g.beginPath(); g.moveTo(18, 0); g.lineTo(-14, -8); g.lineTo(-8, 0); g.lineTo(-14, 8); g.closePath(); g.fill(); g.stroke();
    } else {
      g.beginPath(); g.ellipse(0, 0, 16, 10, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.arc(0, 0, 5, 0, Math.PI * 2); g.fillStyle = "#cba6f7"; g.fill();
    }
    g.restore();
  }
}

// ======= Game State =======
class Game {
  W = 800; H = 600; dpr = 1; running = true; over = false; wave = 1; score = 0; lives = 3; time = 0;
  bullets: Bullet[] = []; particles: Particle[] = []; asteroids: Asteroid[] = []; enemies: Enemy[] = [];
  player: Ship; input: Input; sfx = new Sfx();
  constructor(public canvas: HTMLCanvasElement, public g: CanvasRenderingContext2D) {
    this.input = new Input(canvas);
    this.player = new Ship(v(this.W / 2, this.H / 2));
    this.resize();
    this.spawnWave();
  }
  resize() {
    const { canvas, g } = this;
    const W = (this.W = window.innerWidth);
    const H = (this.H = window.innerHeight);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(W * this.dpr);
    canvas.height = Math.floor(H * this.dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  spawnWave() {
    // Asteroids
    const numAst = 3 + this.wave;
    for (let i = 0; i < numAst; i++) {
      const edge = Math.random();
      const p = v(edge < 0.5 ? rand(0, this.W) : (edge < 0.75 ? 0 : this.W), edge < 0.5 ? (edge < 0.25 ? 0 : this.H) : rand(0, this.H));
      this.asteroids.push(new Asteroid(p, rand(26, 46), 3));
    }
    // Enemies
    const numE = Math.min(2 + Math.floor(this.wave / 2), 6);
    for (let i = 0; i < numE; i++) {
      const p = v(rand(0, this.W), rand(0, this.H));
      this.enemies.push(new Enemy(p));
    }
  }
  splitAsteroid(a: Asteroid) {
    if (a.level > 1) {
      for (let i = 0; i < 2; i++) {
        const child = new Asteroid({ ...a.pos }, a.radius * 0.65, a.level - 1);
        child.vel = add(a.vel, v(rand(-40, 40), rand(-40, 40)));
        this.asteroids.push(child);
      }
    }
  }
  addExplosion(p: Vec, color = "#f38ba8", amount = 18) {
    for (let i = 0; i < amount; i++) {
      this.particles.push(new Particle({ ...p }, rot(v(rand(60, 240), 0), rand(0, Math.PI * 2)), color, rand(0.3, 0.9)));
    }
  }
  update(dt: number) {
    if (!this.running) return;
    this.time += dt;
    // Player
    this.player.update(dt, this.W, this.H, this.input);
    // Shooting
    if ((this.input.mouse.down || this.input.keys.has(" ")) && this.player.canShoot()) this.player.shoot(this.input.mouse.pos, this.bullets, this.sfx);

    // Enemies
    this.enemies.forEach((e) => e.update(dt, this.W, this.H, this.player, this.bullets, this.sfx));

    // Bullets
    this.bullets.forEach((b) => b.update(dt, this.W, this.H));

    // Asteroids
    this.asteroids.forEach((a) => a.update(dt, this.W, this.H));

    // Particles
    this.particles.forEach((p) => p.update(dt, this.W, this.H));

    // Collisions
    const circleHit = (a: Body, b: Body) => len(sub(a.pos, b.pos)) < a.radius + b.radius;

    // Bullet vs asteroid/enemy
    for (const b of this.bullets) if (b.alive) {
      if (b.fromPlayer) {
        for (const e of this.enemies) if (e.alive && circleHit(b, e)) {
          e.alive = false; b.alive = false; this.score += 150; this.addExplosion(e.pos, "#fab387", 22); this.sfx.explode();
        }
      } else {
        if (this.player.alive && circleHit(b, this.player)) {
          b.alive = false; this.hitPlayer();
        }
      }
      for (const a of this.asteroids) if (a.alive && circleHit(b, a)) {
        a.alive = false; b.alive = false; this.splitAsteroid(a); this.score += 50; this.addExplosion(a.pos, "#cdd6f4", 18); this.sfx.hit();
      }
    }

    // Player vs asteroid/enemy
    for (const a of this.asteroids) if (a.alive && this.player.alive && circleHit(a, this.player)) { a.alive = false; this.splitAsteroid(a); this.hitPlayer(); }
    for (const e of this.enemies) if (e.alive && this.player.alive && circleHit(e, this.player)) { e.alive = false; this.addExplosion(e.pos, "#fab387", 22); this.hitPlayer(); }

    // Cleanup
    this.bullets = this.bullets.filter((b) => b.alive);
    this.particles = this.particles.filter((p) => p.alive);
    this.asteroids = this.asteroids.filter((a) => a.alive);
    this.enemies = this.enemies.filter((e) => e.alive);

    // Wave clear?
    if (this.asteroids.length === 0 && this.enemies.length === 0) {
      this.wave++; this.sfx.pickup(); this.spawnWave();
    }

    // Game over
    if (!this.player.alive && !this.over) {
      this.over = true; this.running = false;
      setTimeout(() => { /* show game over overlay handled in render */ }, 0);
    }
  }
  hitPlayer() {
    this.addExplosion(this.player.pos, "#94e2d5", 26); this.sfx.explode();
    this.lives--; this.player.alive = this.lives > 0;
    if (this.player.alive) {
      // Respawn with brief invulnerability
      this.player.pos = v(this.W / 2, this.H / 2); this.player.vel = v();
      const blink = this.player; let t = 0; const id = setInterval(() => { t++; blink.radius = t % 2 === 0 ? 14 : 0; if (t > 20) { blink.radius = 14; clearInterval(id); } }, 60);
    }
  }
  restart() {
    this.bullets = []; this.particles = []; this.asteroids = []; this.enemies = [];
    this.player = new Ship(v(this.W / 2, this.H / 2));
    this.running = true; this.over = false; this.wave = 1; this.score = 0; this.lives = 3; this.time = 0;
    this.spawnWave();
  }
  togglePause() { if (this.over) return; this.running = !this.running; }
  render() {
    const g = this.g; g.clearRect(0, 0, this.W, this.H);
    // Starfield backdrop
    g.save(); g.fillStyle = "#0b1021"; g.fillRect(0, 0, this.W, this.H); g.restore();
    // Parallax stars
    for (let i = 0; i < 80; i++) { const px = (i * 97 + (this.time * 10)) % this.W; const py = (i * 53) % this.H; g.fillStyle = i % 7 === 0 ? "#f8f8f2" : "#bac2de"; g.fillRect(px, py, 2, 2); }

    this.asteroids.forEach((a) => a.render(g));
    this.enemies.forEach((e) => e.render(g));
    this.bullets.forEach((b) => b.render(g));
    if (this.player.alive) this.player.render(g);
    this.particles.forEach((p) => p.render(g));

    // HUD
    g.save(); g.fillStyle = "white"; g.font = "16px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillText(`Score ${this.score}`, 16, 24);
    g.fillText(`Wave ${this.wave}`, 16, 44);
    g.fillText(`Lives ${this.lives}`, 16, 64);
    g.fillText("WASD to move, Mouse to aim, Click/Space shoot, Shift boost, P pause, R restart", 16, this.H - 16);
    g.restore();

    if (!this.running && !this.over) {
      this.drawCenterText("Paused – Press P to resume", 28);
    }
    if (this.over) {
      this.drawCenterText(`Game Over\nScore ${this.score}\nPress R to restart`, 28);
    }
  }
  drawCenterText(text: string, size = 28) {
    const g = this.g; g.save(); g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#e6edf3"; g.font = `${size}px ui-sans-serif, system-ui`;
    const lines = text.split("\n");
    lines.forEach((line, i) => g.fillText(line, this.W / 2, this.H / 2 + i * (size + 8)));
    g.restore();
  }
}

// ======= React Page =======
export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const g = canvas.getContext("2d");
    if (!g) return;
    const game = new Game(canvas, g); gameRef.current = game; setReady(true);

    const onResize = () => game.resize();
    window.addEventListener("resize", onResize);

    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      let dt = (now - last) / 1000; last = now; dt = Math.min(0.05, dt);
      game.update(dt); game.render();
      raf = requestAnimationFrame(loop);
    };
    let raf = requestAnimationFrame(loop);

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "p") game.togglePause();
      if (e.key.toLowerCase() === "r") game.restart();
      if (e.key.toLowerCase() === "m") game.sfx.enabled = !game.sfx.enabled;
    };
    window.addEventListener("keydown", keyHandler);

    // Prevent context menu on right-click to keep mouse focus
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    return () => {
      cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); window.removeEventListener("keydown", keyHandler);
    };
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#0b1021" }}>
      <canvas ref={canvasRef} style={{ display: "block", cursor: ready ? "crosshair" : "default" }} />
      {/* Minimal on-screen controls for mobile */}
      <style>{`
        .hud-btn{position:fixed; right:12px; bottom:12px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.2); color:#e6edf3; padding:8px 10px; border-radius:10px; font:14px ui-sans-serif,system-ui;}
        .joystick{position:fixed; left:16px; bottom:16px; width:120px; height:120px; border-radius:50%; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2);}
      `}</style>
      <div className="joystick" />
      <button className="hud-btn" onClick={() => { const g = gameRef.current; if (!g) return; if (g.over) g.restart(); else g.togglePause(); }}>
        Toggle Pause / Restart
      </button>
    </div>
  );
}
