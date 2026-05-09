'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const BALL_RADIUS    = 18;
const GOAL_WIDTH     = BALL_RADIUS * 4;   // ボール直径×2
const GOAL_DEPTH     = 70;
const GOAL_WALL_W    = 14;
const CONTROLS_H     = 80;
const OBSTACLE_COUNT = 5;
const SEESAW_COUNT   = 2;
const LAUNCH_VX      = -5;
const LAUNCH_VY      = -1.5;
const WALL_T         = 60;

// ── Matter.js aliases ──────────────────────────────────────────────────────
const { Engine, World, Bodies, Body, Events, Constraint, Composite } = Matter;

// ── Canvas setup ──────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight - CONTROLS_H;
}
resize();
window.addEventListener('resize', () => { resize(); rebuildWorld(); });

// ── Physics engine ────────────────────────────────────────────────────────
let engine, world;

function createEngine() {
  engine = Engine.create({ gravity: { x: 0, y: 1.8 } });
  world  = engine.world;
}
createEngine();

// ── Game state ────────────────────────────────────────────────────────────
let ball        = null;
let ballsLeft   = 3;
let state       = 'waiting'; // waiting | launched | result
let goalSensor  = null;
let obstacles   = [];        // all obstacle bodies (sticks + seesaws)
let seesawBodies = new Set();// subset of obstacles that are seesaws
let seesawPins  = [];
let lastCollisionSounds = 0;

// ── Wood grain texture cache ──────────────────────────────────────────────
let bgGrain = null;

function buildBgGrain() {
  const oc  = document.createElement('canvas');
  oc.width  = canvas.width;
  oc.height = canvas.height;
  const oc2 = oc.getContext('2d');
  oc2.fillStyle = '#e8d5a8';
  oc2.fillRect(0, 0, oc.width, oc.height);
  for (let x = 0; x < oc.width; x += 18 + Math.random() * 14) {
    const alpha = 0.04 + Math.random() * 0.06;
    oc2.strokeStyle = `rgba(100,60,20,${alpha})`;
    oc2.lineWidth   = 1 + Math.random() * 2;
    oc2.beginPath();
    oc2.moveTo(x, 0);
    const cp1x = x + (Math.random() - 0.5) * 30;
    const cp2x = x + (Math.random() - 0.5) * 30;
    oc2.bezierCurveTo(cp1x, oc.height * 0.33, cp2x, oc.height * 0.66, x, oc.height);
    oc2.stroke();
  }
  return oc;
}

// ── Goal / Launch positions ────────────────────────────────────────────────
function goalX()   { return 50 + GOAL_WIDTH / 2; }
function goalY()   { return canvas.height - GOAL_DEPTH - 4; }
function launchX() { return canvas.width - 36; }
function launchY() { return 44; }

// ── Helper: make a rect body with stored dimensions ───────────────────────
function makeRect(x, y, w, h, opts) {
  const body = Bodies.rectangle(x, y, w, h, opts);
  body.plugin = { w, h };
  return body;
}

// ── World construction ────────────────────────────────────────────────────
function buildGoal() {
  const gx = goalX();
  const gy = goalY();
  const hw = GOAL_WIDTH / 2 + GOAL_WALL_W / 2;

  const leftWall  = makeRect(gx - hw, gy + GOAL_DEPTH / 2, GOAL_WALL_W, GOAL_DEPTH, {
    isStatic: true, label: 'goalWall', friction: 0.3, restitution: 0.1
  });
  const rightWall = makeRect(gx + hw, gy + GOAL_DEPTH / 2, GOAL_WALL_W, GOAL_DEPTH, {
    isStatic: true, label: 'goalWall', friction: 0.3, restitution: 0.1
  });
  goalSensor = makeRect(gx, gy + GOAL_DEPTH - 6, GOAL_WIDTH, 12, {
    isStatic: true, isSensor: true, label: 'goalSensor'
  });
  World.add(world, [leftWall, rightWall, goalSensor]);
}

function buildWalls() {
  const W = canvas.width, H = canvas.height;
  World.add(world, [
    makeRect(-WALL_T / 2,     H / 2, WALL_T, H * 2,  { isStatic: true, label: 'wall', friction: 0.3, restitution: 0.3 }),
    makeRect(W + WALL_T / 2,  H / 2, WALL_T, H * 2,  { isStatic: true, label: 'wall', friction: 0.3, restitution: 0.3 }),
    makeRect(W / 2, -WALL_T / 2, W * 2, WALL_T,      { isStatic: true, label: 'wall', friction: 0,   restitution: 0.5 }),
  ]);
}

function isInExcludeZone(x, y, w, h) {
  const W = canvas.width, H = canvas.height;
  const launchZone = { x: W * 0.76, y: 0,       w: W * 0.24, h: H * 0.22 };
  const goalZone   = { x: 0,        y: H * 0.68, w: W * 0.28, h: H * 0.32 };
  function overlaps(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }
  return overlaps(x - w/2, y - h/2, w, h, launchZone.x, launchZone.y, launchZone.w, launchZone.h)
      || overlaps(x - w/2, y - h/2, w, h, goalZone.x,   goalZone.y,   goalZone.w,   goalZone.h);
}

function generateObstacles() {
  const W = canvas.width, H = canvas.height;
  const placed = [];

  function tryPlace(attempts, fn) {
    for (let i = 0; i < attempts; i++) {
      const r = fn();
      if (r) { placed.push(r); return r; }
    }
  }

  // Fixed sticks
  for (let i = 0; i < OBSTACLE_COUNT; i++) {
    tryPlace(30, () => {
      const w     = 80 + Math.random() * 100;
      const h     = 12;
      const angle = (Math.random() - 0.5) * (Math.PI * 0.55);
      const x     = W * 0.08 + Math.random() * (W * 0.84);
      const y     = H * 0.12 + Math.random() * (H * 0.70);
      if (isInExcludeZone(x, y, w + 20, h + 20)) return null;
      for (const p of placed) {
        if (Math.hypot(p.x - x, p.y - y) < 70) return null;
      }
      const body = makeRect(x, y, w, h, {
        isStatic: true, label: 'obstacle', angle,
        friction: 0.5, restitution: 0.25
      });
      obstacles.push(body);
      World.add(world, body);
      return { x, y };
    });
  }

  // Seesaws
  for (let i = 0; i < SEESAW_COUNT; i++) {
    tryPlace(30, () => {
      const w = 130 + Math.random() * 60;
      const h = 12;
      const x = W * 0.15 + Math.random() * (W * 0.70);
      const y = H * 0.20 + Math.random() * (H * 0.55);
      if (isInExcludeZone(x, y, w + 30, h + 60)) return null;
      for (const p of placed) {
        if (Math.hypot(p.x - x, p.y - y) < 100) return null;
      }
      const seesaw = makeRect(x, y, w, h, {
        label: 'seesaw', friction: 0.4, restitution: 0.2, frictionAir: 0.02
      });
      const pin = Bodies.circle(x, y, 4, {
        isStatic: true, label: 'seesawPin',
        collisionFilter: { mask: 0 }
      });
      const constraint = Constraint.create({
        bodyA: seesaw, pointA: { x: 0, y: 0 },
        bodyB: pin,    pointB: { x: 0, y: 0 },
        length: 0, stiffness: 1
      });
      obstacles.push(seesaw);
      seesawBodies.add(seesaw);
      seesawPins.push(pin);
      World.add(world, [seesaw, pin, constraint]);
      return { x, y };
    });
  }
}

function clearObstacles() {
  obstacles.forEach(b => World.remove(world, b));
  seesawPins.forEach(b => World.remove(world, b));
  Composite.allConstraints(world).forEach(c => World.remove(world, c));
  obstacles    = [];
  seesawBodies = new Set();
  seesawPins   = [];
}

function createBall() {
  if (ball) { World.remove(world, ball); ball = null; }
  ball = Bodies.circle(launchX(), launchY(), BALL_RADIUS, {
    label: 'ball', isStatic: true,
    friction: 0.6, restitution: 0.4, frictionAir: 0.005, density: 0.003
  });
  World.add(world, ball);
}

function removeBall() {
  if (ball) { World.remove(world, ball); ball = null; }
}

function rebuildWorld() {
  bgGrain = null;
  stopRollingSound();
  World.clear(world);
  Engine.clear(engine);
  createEngine();
  ball         = null;
  obstacles    = [];
  seesawBodies = new Set();
  seesawPins   = [];
  goalSensor   = null;
  buildWalls();
  buildGoal();
  generateObstacles();
  createBall();
  registerCollisions();
}

// ── Collision events ───────────────────────────────────────────────────────
function registerCollisions() {
  Events.on(engine, 'collisionStart', (event) => {
    for (const pair of event.pairs) {
      const { bodyA, bodyB } = pair;
      const hasBall = bodyA === ball || bodyB === ball;
      const hasGoal = bodyA === goalSensor || bodyB === goalSensor;

      if (hasBall && hasGoal && state === 'launched') {
        onGoalSuccess();
        return;
      }
      if (hasBall) {
        const now = Date.now();
        if (now - lastCollisionSounds > 80) {
          playCollision(Math.min((pair.collision.depth || 1) * 0.3, 1));
          lastCollisionSounds = now;
        }
      }
    }
  });
}

// ── Game logic ─────────────────────────────────────────────────────────────
function onLaunch() {
  if (state !== 'waiting' || ballsLeft <= 0 || !ball) return;
  resumeAudio();
  Body.setStatic(ball, false);
  Body.setVelocity(ball, { x: LAUNCH_VX, y: LAUNCH_VY });
  state = 'launched';
  startRollingSound();
}

function onGoalSuccess() {
  state = 'result';
  stopRollingSound();
  playGoal();
  setTimeout(() => showMessage('🎉 SUCCESS!', 'リフレッシュして再挑戦'), 200);
}

function onGoalFail() {
  stopRollingSound();
  playFail();
  ballsLeft--;
  removeBall();
  if (ballsLeft > 0) {
    state = 'waiting';
    setTimeout(createBall, 600);
  } else {
    state = 'result';
    setTimeout(() => showMessage('GAME OVER', 'リフレッシュして再挑戦'), 400);
  }
}

function onRefresh() {
  hideMessage();
  ballsLeft = 3;
  state     = 'waiting';
  rebuildWorld();
}

// ── UI ─────────────────────────────────────────────────────────────────────
const overlay = document.getElementById('ui-overlay');

function showMessage(main, sub) {
  overlay.innerHTML = `${main}<div class="sub">${sub}</div>`;
  overlay.classList.remove('hidden');
}
function hideMessage() { overlay.classList.add('hidden'); }

// ── Drawing helpers ────────────────────────────────────────────────────────
function drawBackground() {
  if (!bgGrain || bgGrain.width !== canvas.width || bgGrain.height !== canvas.height) {
    bgGrain = buildBgGrain();
  }
  ctx.drawImage(bgGrain, 0, 0);
  const vgrd = ctx.createRadialGradient(
    canvas.width / 2, canvas.height / 2, canvas.height * 0.3,
    canvas.width / 2, canvas.height / 2, canvas.height * 0.85
  );
  vgrd.addColorStop(0, 'rgba(0,0,0,0)');
  vgrd.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = vgrd;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r,         r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y,     x + r, y,             r);
  ctx.closePath();
}

function drawStick(body, isSeesaw) {
  // Use stored dimensions from plugin (set in makeRect)
  const bw = (body.plugin && body.plugin.w) ? body.plugin.w : 120;
  const bh = (body.plugin && body.plugin.h) ? body.plugin.h : 12;
  const hw = bw / 2, hh = bh / 2;

  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);

  const grad = ctx.createLinearGradient(-hw, -hh, -hw, hh);
  if (isSeesaw) {
    grad.addColorStop(0, '#d4944e');
    grad.addColorStop(0.45, '#b07030');
    grad.addColorStop(1, '#7a4a1a');
  } else {
    grad.addColorStop(0, '#b87840');
    grad.addColorStop(0.45, '#8a5828');
    grad.addColorStop(1, '#5a3010');
  }
  ctx.fillStyle = grad;
  roundRect(-hw, -hh, bw, bh, 4);
  ctx.fill();

  // Wood grain lines
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(80,40,10,0.18)';
  ctx.lineWidth   = 1;
  for (let lx = -hw + 14; lx < hw; lx += 16 + Math.random() * 6) {
    ctx.beginPath();
    ctx.moveTo(lx, -hh);
    ctx.lineTo(lx + (Math.random() - 0.5) * 4, hh);
    ctx.stroke();
  }
  ctx.restore();

  // Seesaw pivot dot
  if (isSeesaw) {
    ctx.fillStyle = 'rgba(50,25,8,0.75)';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Outline
  ctx.strokeStyle = 'rgba(50,25,8,0.45)';
  ctx.lineWidth   = 1.5;
  roundRect(-hw, -hh, bw, bh, 4);
  ctx.stroke();

  ctx.restore();
}

function drawBallBody() {
  if (!ball) return;
  const { x, y } = ball.position;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ball.angle);

  ctx.shadowColor   = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur    = 10;
  ctx.shadowOffsetY = 4;

  const grd = ctx.createRadialGradient(-BALL_RADIUS * 0.3, -BALL_RADIUS * 0.35, 2, 0, 0, BALL_RADIUS);
  grd.addColorStop(0,    '#f0c870');
  grd.addColorStop(0.35, '#c88030');
  grd.addColorStop(0.75, '#8a4e18');
  grd.addColorStop(1,    '#5a3008');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur  = 0;

  // Wood grain rings
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(80,40,10,0.22)';
  ctx.lineWidth   = 1;
  for (let r = BALL_RADIUS * 0.25; r < BALL_RADIUS * 0.9; r += BALL_RADIUS * 0.22) {
    ctx.beginPath();
    ctx.arc(r * 0.2, r * 0.1, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Highlight
  const hl = ctx.createRadialGradient(-BALL_RADIUS * 0.35, -BALL_RADIUS * 0.38, 1, -BALL_RADIUS * 0.2, -BALL_RADIUS * 0.2, BALL_RADIUS * 0.5);
  hl.addColorStop(0, 'rgba(255,240,180,0.55)');
  hl.addColorStop(1, 'rgba(255,220,140,0)');
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawGoalShape() {
  const gx = goalX();
  const gy = goalY();
  const hw = GOAL_WIDTH / 2;

  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(gx, gy + GOAL_DEPTH + 4, hw + 4, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  const wallGrad = ctx.createLinearGradient(0, gy, 0, gy + GOAL_DEPTH);
  wallGrad.addColorStop(0, '#7a4a20');
  wallGrad.addColorStop(1, '#3a2008');

  ctx.fillStyle = wallGrad;
  roundRect(gx - hw - GOAL_WALL_W, gy, GOAL_WALL_W, GOAL_DEPTH, 3);
  ctx.fill();
  roundRect(gx + hw, gy, GOAL_WALL_W, GOAL_DEPTH, 3);
  ctx.fill();

  ctx.strokeStyle = 'rgba(25,12,4,0.55)';
  ctx.lineWidth   = 1.5;
  roundRect(gx - hw - GOAL_WALL_W, gy, GOAL_WALL_W, GOAL_DEPTH, 3);
  ctx.stroke();
  roundRect(gx + hw, gy, GOAL_WALL_W, GOAL_DEPTH, 3);
  ctx.stroke();

  // Dark interior
  const holeGrad = ctx.createLinearGradient(gx - hw, gy, gx - hw, gy + GOAL_DEPTH);
  holeGrad.addColorStop(0, 'rgba(0,0,0,0.05)');
  holeGrad.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = holeGrad;
  ctx.fillRect(gx - hw, gy, GOAL_WIDTH, GOAL_DEPTH);

  // Label
  ctx.fillStyle   = 'rgba(255,220,100,0.9)';
  ctx.font        = 'bold 13px Arial';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('GOAL', gx, gy - 4);
}

function drawHUD() {
  const size   = 13;
  const gap    = 6;
  const startX = canvas.width - 12 - size;
  const cy     = 20;

  for (let i = 0; i < 3; i++) {
    const cx = startX - i * (size * 2 + gap);
    ctx.beginPath();
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    if (i < ballsLeft) {
      const g = ctx.createRadialGradient(cx - 4, cy - 4, 2, cx, cy, size);
      g.addColorStop(0,    '#f0c870');
      g.addColorStop(0.5,  '#c88030');
      g.addColorStop(1,    '#5a3008');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = 'rgba(80,50,30,0.3)';
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(50,25,8,0.5)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }
}

// ── Audio ──────────────────────────────────────────────────────────────────
let audioCtx      = null;
let rollingNode   = null;
let rollingGain   = null;
let rollingFilter = null;
let audioResumed  = false;

function resumeAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audioResumed = true;
}

function startRollingSound() {
  if (!audioCtx) return;
  stopRollingSound();
  const bufSize = audioCtx.sampleRate * 2;
  const buffer  = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data    = buffer.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

  rollingNode = audioCtx.createBufferSource();
  rollingNode.buffer = buffer;
  rollingNode.loop   = true;

  rollingFilter = audioCtx.createBiquadFilter();
  rollingFilter.type            = 'bandpass';
  rollingFilter.frequency.value = 300;
  rollingFilter.Q.value         = 2;

  rollingGain = audioCtx.createGain();
  rollingGain.gain.value = 0.04;

  rollingNode.connect(rollingFilter);
  rollingFilter.connect(rollingGain);
  rollingGain.connect(audioCtx.destination);
  rollingNode.start();
}

function updateRollingSound() {
  if (!rollingGain || !ball || state !== 'launched') return;
  const vel    = ball.velocity;
  const spd    = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
  const target = Math.min(spd * 0.012, 0.15);
  rollingGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.05);
  if (rollingFilter) {
    rollingFilter.frequency.setTargetAtTime(200 + spd * 30, audioCtx.currentTime, 0.1);
  }
}

function stopRollingSound() {
  if (rollingNode) {
    try { rollingNode.stop(); } catch (_) {}
    rollingNode = null;
  }
  rollingGain   = null;
  rollingFilter = null;
}

function playCollision(strength = 0.5) {
  if (!audioCtx || !audioResumed) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type            = 'sine';
  osc.frequency.value = 180 + strength * 120;
  gain.gain.setValueAtTime(0.25 * strength, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.12);
}

function playGoal() {
  if (!audioCtx || !audioResumed) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type            = 'sine';
    osc.frequency.value = freq;
    const t = audioCtx.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

function playFail() {
  if (!audioCtx || !audioResumed) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(120, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime + 0.35);
  gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.4);
}

// ── Main loop ──────────────────────────────────────────────────────────────
let lastTime = performance.now();

function loop(ts) {
  const dt = Math.min(ts - lastTime, 32);
  lastTime = ts;

  Engine.update(engine, dt);

  // Ball out-of-bounds → fail
  if (state === 'launched' && ball && ball.position.y > canvas.height + 60) {
    onGoalFail();
  }

  updateRollingSound();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();
  obstacles.forEach(b => drawStick(b, seesawBodies.has(b)));
  drawGoalShape();
  drawBallBody();
  drawHUD();

  requestAnimationFrame(loop);
}

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', onRefresh);
document.getElementById('btn-launch').addEventListener('click', onLaunch);

buildWalls();
buildGoal();
generateObstacles();
createBall();
registerCollisions();

requestAnimationFrame(loop);
