// components/Runner3D.tsx
'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';

type RAF = number | null;

type Props = {
  width?: number;
  height?: number;
  onSubmitScore?: (score: number) => Promise<void> | void;
  countdownSeconds?: number;
};

const BASE_W = 360;
const BASE_H = 640;
const FIXED_FOV = 60;

// slide tuning
const SLIDE_DURATION_MS = 700;
const SLIDE_COOLDOWN_MS = 200;
const SLIDE_SCALE_Y = 0.55;
const PLAYER_RADIUS = 0.36;
const PLAYER_GROUND_Y = 0.5;

// power-up timing (ms)
const MAGNET_MS = 10_000;
const BOOST_MS = 6_000;
const SHIELD_MS = 12_000;

// boost + magnet params
const MAGNET_RADIUS = 2.2;
const MAGNET_PULL = 0.06;
const BOOST_MULT = 1.55;

// combo
const COMBO_WINDOW_MS = 2500;
const COMBO_MAX = 5; // x2.0 max

// jump forgiveness
const COYOTE_MS = 120;

type ObstacleType = 'ground' | 'air';
type Obs = { mesh: THREE.Mesh; aabb: THREE.Box3; active: boolean; type: ObstacleType };
type Orb = { mesh: THREE.Mesh; aabb: THREE.Sphere; active: boolean; z: number };
type PowerKind = 'magnet' | 'boost' | 'shield';
type Power = { mesh: THREE.Mesh; aabb: THREE.Sphere; active: boolean; kind: PowerKind };

export default function Runner3D({
  width = BASE_W,
  height = BASE_H,
  onSubmitScore,
  countdownSeconds = 2, // 2-second countdown
}: Props) {
  // mounting
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<RAF>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // game state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [dead, setDead] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [speedView, setSpeedView] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);

  // ui state
  const [showSettings, setShowSettings] = useState(false);
  const [quality, setQuality] = useState<number>(2);
  const [theme, setTheme] = useState<'purple' | 'neon' | 'ink'>('purple');

  // HUD power badges + combo
  const [badgePct, setBadgePct] = useState({ magnet: 0, boost: 0, shield: 0 });
  const [comboInfo, setComboInfo] = useState<{ mult: number; pct: number }>({ mult: 1, pct: 0 });

  // refs for timers so HUD can read them
  const magnetUntilRef = useRef(0);
  const boostUntilRef = useRef(0);
  const shieldUntilRef = useRef(0);
  const lastPickupAtRef = useRef(0);
  const comboRef = useRef(0);

  // responsive size
  const size = useMemo(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : width;
    const targetW = Math.min(width, vw - 24);
    const aspect = height / width;
    const targetH = Math.min(height, Math.floor(targetW * aspect));
    return { w: targetW, h: targetH };
  }, [width, height]);

  // theme colors
  const colors = useMemo(() => {
    if (theme === 'neon') {
      return {
        bgTop: '#10172a',
        bgBot: '#05050a',
        rail: 0x00e7ff,
        player: 0x58a6ff,
        obstacleGround: 0xff5d8f,
        obstacleAir: 0xffd166,
        grid: '#00e7ff',
        emissive: 0x0a3a7a,
        magnet: 0xffe066,
        boost: 0x00ffd0,
        shield: 0x8be9fd,
      };
    }
    if (theme === 'ink') {
      return {
        bgTop: '#1b1f2a',
        bgBot: '#090a0d',
        rail: 0x33d17a,
        player: 0x6e59ff,
        obstacleGround: 0x33d17a,
        obstacleAir: 0xffe066,
        grid: '#6e59ff',
        emissive: 0x281e66,
        magnet: 0xffe066,
        boost: 0x33d17a,
        shield: 0xb3e5ff,
      };
    }
    return {
      bgTop: '#2f296a',
      bgBot: '#0a0a0a',
      rail: 0x6e59ff,
      player: 0x9b59ff,
      obstacleGround: 0x33d17a,
      obstacleAir: 0xffe066,
      grid: '#6e59ff',
      emissive: 0x281e66,
      magnet: 0xffe066,
      boost: 0x6e59ff,
      shield: 0xc9e6ff,
    };
  }, [theme]);

  // countdown
  const startCountdown = useCallback(() => setCountdown(countdownSeconds), [countdownSeconds]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      setPaused(false);
      setRunning(true);
    } else {
      const t = setTimeout(() => setCountdown(v => (v ?? 1) - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [countdown]);

  // focus -> pause protection
  useEffect(() => {
    const onBlur = () => setPaused(true);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  // make a neon grid texture
  function makeGridTexture(color = colors.grid, sizePx = 256, gap = 16) {
    const c = document.createElement('canvas');
    c.width = sizePx;
    c.height = sizePx;
    const g = c.getContext('2d')!;
    g.fillStyle = '#08080a';
    g.fillRect(0, 0, sizePx, sizePx);
    g.strokeStyle = color;
    g.globalAlpha = 0.55;
    g.lineWidth = 1;
    for (let y = 0; y < sizePx; y += gap) { g.beginPath(); g.moveTo(0, y); g.lineTo(sizePx, y); g.stroke(); }
    for (let x = 0; x < sizePx; x += gap) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, sizePx); g.stroke(); }
    g.globalAlpha = 1;
    return new THREE.CanvasTexture(c);
  }

  const startGame = useCallback(async () => {
    if (!mountRef.current) return;

    const W = size.w;
    const H = size.h;
    const mount = mountRef.current;

    // scene + camera + renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0a, 12, 120);

    const camera = new THREE.PerspectiveCamera(FIXED_FOV, W / H, 0.1, 500);
    camera.position.set(0, 2.1, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: quality >= 2, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality));
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = quality >= 2;
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    // --- sounds (WebAudio) ---
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    function beep(freq: number, durMs: number, type: OscillatorType = 'sine', gain = 0.06) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      setTimeout(() => { o.stop(); }, durMs);
    }
    function playJump()   { beep(420, 120, 'sine', 0.05); }
    function playPickup() { beep(880, 90,  'triangle', 0.05); }
    function playSlide()  { beep(220, 80,  'sawtooth', 0.03); }
    function playHit()    { beep(120, 140, 'square', 0.06); }

    // lights
    const hemi = new THREE.HemisphereLight(0xccddff, 0x221144, 0.8); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7); dir.position.set(6, 10, 6); dir.castShadow = true; scene.add(dir);

    // ground
    const gridTex = makeGridTexture();
    gridTex.wrapS = THREE.RepeatWrapping; gridTex.wrapT = THREE.RepeatWrapping; gridTex.repeat.set(1, 50);
    const groundGeo = new THREE.PlaneGeometry(16, 400);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 1, map: gridTex, transparent: true, opacity: 0.92 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2; ground.position.z = -160; ground.receiveShadow = true; scene.add(ground);

    // rails
    const railMat = new THREE.MeshStandardMaterial({ color: colors.rail, emissive: colors.emissive, emissiveIntensity: 0.6 });
    const railGeo = new THREE.BoxGeometry(0.1, 0.1, 120);
    const leftRail = new THREE.Mesh(railGeo, railMat); leftRail.position.set(-1.8, 0.55, -60);
    const rightRail = new THREE.Mesh(railGeo, railMat); rightRail.position.set(1.8, 0.55, -60);
    scene.add(leftRail, rightRail);

    // player
    const playerGeo = new THREE.SphereGeometry(PLAYER_RADIUS, 24, 24);
    const playerMat = new THREE.MeshStandardMaterial({ color: colors.player, roughness: 0.35, metalness: 0.1, emissive: colors.emissive, emissiveIntensity: 0.5 });
    const player = new THREE.Mesh(playerGeo, playerMat);
    player.castShadow = true; player.position.set(0, PLAYER_GROUND_Y, 0); scene.add(player);

    // shield visual
    const shieldGeo = new THREE.RingGeometry(0.52, 0.6, 32);
    const shieldMat = new THREE.MeshBasicMaterial({ color: colors.shield, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
    shieldMesh.rotation.x = Math.PI / 2;
    shieldMesh.visible = false;
    player.add(shieldMesh);

    // simple trail
    const trailCount = 24;
    const trailGeo = new THREE.SphereGeometry(0.08, 8, 8);
    const trailMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
    const trail = new THREE.InstancedMesh(trailGeo, trailMat, trailCount);
    const trailPositions: THREE.Vector3[] = Array.from({ length: trailCount }, () => new THREE.Vector3());
    const trailMatrix = new THREE.Matrix4();
    scene.add(trail);

    // --- particles (points) ---
    const MAX_PARTICLES = 400;
    const partGeo = new THREE.BufferGeometry();
    const pPositions = new Float32Array(MAX_PARTICLES * 3);
    const pVelocities = new Float32Array(MAX_PARTICLES * 3);
    const pLife = new Float32Array(MAX_PARTICLES);
    partGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
    // subtle brownish dust (not bright white)
    const partMat = new THREE.PointsMaterial({
      size: 0.06,
      transparent: true,
      opacity: 0.35,
      color: 0x5f5242,
    });
    const particles = new THREE.Points(partGeo, partMat);
    scene.add(particles);
    let pCursor = 0;

    function emitParticle(pos: THREE.Vector3, vel: THREE.Vector3, life = 600) {
      const i = pCursor % MAX_PARTICLES;
      pPositions[i*3+0] = pos.x; pPositions[i*3+1] = pos.y; pPositions[i*3+2] = pos.z;
      pVelocities[i*3+0] = vel.x; pVelocities[i*3+1] = vel.y; pVelocities[i*3+2] = vel.z;
      pLife[i] = life;
      pCursor++;
      partGeo.attributes.position.needsUpdate = true;
    }
    function burst(pos: THREE.Vector3, count = 14, speed = 0.06, life = 500) {
      for (let i=0;i<count;i++) {
        const a = Math.random() * Math.PI * 2;
        const v = new THREE.Vector3(Math.cos(a)*speed*(0.5+Math.random()), Math.random()*speed, Math.sin(a)*speed*(0.5+Math.random()));
        emitParticle(pos, v, life + Math.random()*200);
      }
    }

    // --- params (must be before spawners & diffFactor) ---
    let baseSpeed = 0.28;
    const accel = 0.00008;
    const gravity = 0.01;
    // animation frame counter; used by diffFactor()
    let t = 0;
    function diffFactor() {
      // ramps from 0 → 1 over ~90 seconds (adjust to taste)
      const seconds = t / 60;
      return Math.max(0, Math.min(1, seconds / 90));
    }

    // physics state
    let laneIndex = 1;
    let vy = 0;
    let y = PLAYER_GROUND_Y;
    let lastGroundedAt = 0;   // timestamp when we last touched ground
    let wasGrounded = true;   // previous grounded state

    // slide state
    let sliding = false;
    let slideStartAt = 0;
    let slideEndedAt = 0;

    // helper: end slide immediately (used when jump pressed during slide)
    const endSlideNow = () => {
      sliding = false;
      slideEndedAt = performance.now();
      // snap back toward standing; easing finishes it smoothly
      player.scale.y = Math.max(player.scale.y, 0.9);
      player.position.y = Math.max(player.position.y, PLAYER_GROUND_Y);
    };

    const beginSlide = () => {
      const now = performance.now();
      if (sliding) return;
      if (now - slideEndedAt < SLIDE_COOLDOWN_MS) return;
      sliding = true;
      slideStartAt = now;
      // subtle dust burst behind the player + sound
      burst(new THREE.Vector3(player.position.x, PLAYER_GROUND_Y + 0.02, player.position.z - 0.35), 10, 0.04, 360);
      playSlide();
    };

    const updateSlide = () => {
      if (!sliding) {
        // slightly faster stand-up easing
        player.scale.y += (1 - player.scale.y) * 0.35;
        player.position.y += (PLAYER_GROUND_Y - player.position.y) * 0.35;
        return;
      }
      const elapsed = performance.now() - slideStartAt;
      player.scale.y += (SLIDE_SCALE_Y - player.scale.y) * 0.35;
      const crouchOffset = (1 - player.scale.y) * PLAYER_RADIUS;
      const targetY = PLAYER_GROUND_Y - crouchOffset * 0.6;
      player.position.y += (targetY - player.position.y) * 0.35;

      // occasional dust while sliding (subtle)
      if (Math.random() < 0.08) {
        emitParticle(
          new THREE.Vector3(
            player.position.x + (Math.random()-0.5)*0.18,
            PLAYER_GROUND_Y + 0.01,
            player.position.z - 0.3
          ),
          new THREE.Vector3((Math.random()-0.5)*0.015, 0.015, -0.018),
          300
        );
      }
      if (elapsed >= SLIDE_DURATION_MS) {
        sliding = false;
        slideEndedAt = performance.now();
      }
    };

    // environment content
    const obstacles: Obs[] = [];
    const lanes = [-1.2, 0, 1.2];

    // shorter ground obstacles (more fair)
    const obsGroundGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const obsGroundMat = new THREE.MeshStandardMaterial({ color: colors.obstacleGround, roughness: 0.6 });
    const obsAirGeo = new THREE.BoxGeometry(0.9, 0.6, 0.9);
    const obsAirMat = new THREE.MeshStandardMaterial({ color: colors.obstacleAir, roughness: 0.5 });

    // pattern system
    type PatternPiece = { type: ObstacleType; dz: number; lane?: number }; // dz = distance from pattern start (positive)
    const patterns: PatternPiece[][] = [
      // simple intro: G - A - G (fixed lanes)
      [{type:'ground', dz:0, lane:0},{type:'air', dz:6, lane:1},{type:'ground', dz:12, lane:2}],
      // zigzag air: A A A
      [{type:'air', dz:0, lane:0},{type:'air', dz:5, lane:1},{type:'air', dz:10, lane:2}],
      // double ground then one air
      [{type:'ground', dz:0, lane:1},{type:'ground', dz:6, lane:1},{type:'air', dz:12, lane:2}],
      // random lanes mix
      [{type:'air', dz:0},{type:'ground', dz:4},{type:'air', dz:8},{type:'ground', dz:12}],
    ];

    let lastPatternEndZ = -40; // tracks where to place next pattern in Z
    function applyPattern(zStart: number) {
      const pick = patterns[Math.floor(Math.random() * patterns.length)];
      for (const p of pick) {
        const laneIdx = (typeof p.lane === 'number') ? p.lane : Math.floor(Math.random()*3);
        const zPos = zStart - p.dz;
        spawnObstacleWithType(zPos, laneIdx, p.type);
      }
      return zStart - (pick[pick.length-1]?.dz ?? 12) - 8; // suggested next start further back
    }

    function spawnObstacleWithType(zPos: number, laneIndexForced: number, type: ObstacleType) {
      const laneX = [-1.2, 0, 1.2][laneIndexForced];
      const geo = (type === 'air') ? obsAirGeo : obsGroundGeo;
      const mat = (type === 'air') ? obsAirMat : obsGroundMat;
      const m = new THREE.Mesh(geo, mat); m.castShadow = true;
// air low enough to require a slide (bottom ≈ 0.65)
m.position.set(laneX, type === 'air' ? 0.95 : 0.55, zPos);
      scene.add(m);
      const aabb = new THREE.Box3().setFromObject(m);
      obstacles.push({ mesh: m, aabb, active: true, type });
    }

    function spawnObstacle(zPos: number) {
      const laneX = lanes[Math.floor(Math.random() * lanes.length)];
      const isAir = Math.random() < (0.45 + 0.3 * diffFactor()); // more air over time
      const geo = isAir ? obsAirGeo : obsGroundGeo;
      const mat = isAir ? obsAirMat : obsGroundMat;
      const m = new THREE.Mesh(geo, mat); m.castShadow = true;
// match the lower air height
m.position.set(laneX, isAir ? 0.95 : 0.55, zPos);
      scene.add(m);
      const aabb = new THREE.Box3().setFromObject(m);
      obstacles.push({ mesh: m, aabb, active: true, type: isAir ? 'air' : 'ground' });
    }

    const orbs: Orb[] = [];
    const orbGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const orbMat = new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0xffb400, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.3 });
    function spawnOrb(zPos: number) {
      const laneX = lanes[Math.floor(Math.random() * lanes.length)];
      const m = new THREE.Mesh(orbGeo, orbMat);
      m.position.set(laneX, 0.8 + Math.random() * 0.4, zPos);
      scene.add(m);
      const sphere = new THREE.Sphere(m.position, 0.22);
      orbs.push({ mesh: m, aabb: sphere, active: true, z: zPos });
    }

    // power-ups
    const powers: Power[] = [];
    const ico = new THREE.IcosahedronGeometry(0.26, 0);
    const matMagnet = new THREE.MeshStandardMaterial({ color: colors.magnet, emissive: 0xffb400, emissiveIntensity: 0.7, roughness: 0.3 });
    const matBoost = new THREE.MeshStandardMaterial({ color: colors.boost, emissive: 0x00bfa5, emissiveIntensity: 0.8, roughness: 0.3 });
    const matShield = new THREE.MeshStandardMaterial({ color: colors.shield, emissive: 0x67d4ff, emissiveIntensity: 0.8, roughness: 0.3 });

    function spawnPower(zPos: number) {
      const laneX = lanes[Math.floor(Math.random() * lanes.length)];
      const r = Math.random();
      const kind: PowerKind = r < 0.4 ? 'magnet' : r < 0.7 ? 'boost' : 'shield';
      const mat = kind === 'magnet' ? matMagnet : kind === 'boost' ? matBoost : matShield;
      const m = new THREE.Mesh(ico, mat);
      m.position.set(laneX, 0.9, zPos);
      scene.add(m);
      const sphere = new THREE.Sphere(m.position, 0.28);
      powers.push({ mesh: m, aabb: sphere, active: true, kind });
    }

    // preload
    for (let i = 1; i <= 10; i++) spawnObstacle(-i * 12);
    for (let i = 1; i <= 12; i++) spawnOrb(-i * 9 - 4);
    for (let i = 1; i <= 3; i++) spawnPower(-i * 35 - 8);

    // active effects
    magnetUntilRef.current = 0;
    boostUntilRef.current = 0;
    shieldUntilRef.current = 0;

    // combo
    comboRef.current = 0;
    lastPickupAtRef.current = 0;

    // controls
    const onKey = (e: KeyboardEvent) => {
      if (dead || paused) return;
      if (e.key === 'ArrowLeft' || e.key === 'a') laneIndex = Math.max(0, laneIndex - 1);
      if (e.key === 'ArrowRight' || e.key === 'd') laneIndex = Math.min(2, laneIndex + 1);
      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') {
        // Jump cancels slide immediately
        if (sliding) endSlideNow();
        const now = performance.now();
        const grounded = y <= PLAYER_GROUND_Y + 0.01;
        // allow jump if on ground OR within coyote window
        if (grounded || now - lastGroundedAt <= COYOTE_MS) {
          vy = 0.18; // slightly higher jump
          playJump();
        }
      }
      if (e.key === 'ArrowDown' || e.key === 's') beginSlide();
      if (e.key === 'Escape') setPaused(p => !p);
    };
    window.addEventListener('keydown', onKey);

    const onPointer = (e: PointerEvent) => {
      if (dead || paused) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      if (x < -0.33) laneIndex = 0; else if (x > 0.33) laneIndex = 2; else laneIndex = 1;
    };
    window.addEventListener('pointerdown', onPointer);

    // touch slide
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => { lastY = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => { const dy = e.touches[0].clientY - lastY; if (dy > 32) beginSlide(); };
    renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: true });
    renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: true });

    let localScore = 0;
    let localDead = false;
    const playerAABB = new THREE.Box3();
    const tmpVec = new THREE.Vector3();

    const animate = () => {
      if (paused) {
        rafRef.current = requestAnimationFrame(animate);
        return renderer.render(scene, camera);
      }

      const now = performance.now();
      t += 1;

      // boost multiplier + difficulty scaler
      const speedMult = now < boostUntilRef.current ? BOOST_MULT : 1;
      const extra = 0.00004 * diffFactor(); // slightly more acceleration over time
      const speed = (baseSpeed + (t * (accel + extra))) * speedMult;
      if (t % Math.max(300, 600 - Math.floor(300 * diffFactor())) === 0) baseSpeed += 0.05;

      setSpeedView(Number(speed.toFixed(2)));

      // update particles
      for (let i=0;i<MAX_PARTICLES;i++) {
        if (pLife[i] > 0) {
          pLife[i] -= 16; // ~16ms per frame
          pVelocities[i*3+1] -= 0.0004; // gravity
          pPositions[i*3+0] += pVelocities[i*3+0];
          pPositions[i*3+1] += pVelocities[i*3+1];
          pPositions[i*3+2] += pVelocities[i*3+2] + speed * 0.3; // world scroll
        }
      }
      partGeo.attributes.position.needsUpdate = true;

      // lane smoothing
      const targetX = lanes[laneIndex];
      player.position.x += (targetX - player.position.x) * 0.15;

      // jump/grav or slide lock
      if (!sliding) {
        vy -= 0.01; y += vy; if (y < PLAYER_GROUND_Y) { y = PLAYER_GROUND_Y; vy = 0; }
      } else { y = PLAYER_GROUND_Y; vy = 0; }
      player.position.y = y;

      // grounded detection for coyote time
      const nowGrounded = y <= PLAYER_GROUND_Y + 0.0001;
      if (nowGrounded && !wasGrounded) {
        lastGroundedAt = performance.now(); // just landed
      }
      if (nowGrounded) {
        lastGroundedAt = performance.now(); // refresh while grounded
      }
      wasGrounded = nowGrounded;

      // slide animation
      updateSlide();

      // trail
      for (let i = trailCount - 1; i > 0; i--) trailPositions[i].copy(trailPositions[i - 1]);
      trailPositions[0].set(player.position.x, player.position.y, player.position.z);
      for (let i = 0; i < trailCount; i++) {
        const p = trailPositions[i];
        const alpha = (1 - i / trailCount) * 0.35 * (speedMult > 1 ? 1 : 0.8);
        (trail.material as THREE.MeshBasicMaterial).opacity = alpha;
        trailMatrix.makeTranslation(p.x, p.y, p.z - i * 0.02);
        trail.setMatrixAt(i, trailMatrix);
      }
      trail.instanceMatrix.needsUpdate = true;

      // scroll world
      ground.position.z += speed;
      (groundMat.map as THREE.CanvasTexture).offset.y += speed * 0.06;
      if (ground.position.z > -120) ground.position.z = -160;

      // obstacles
      for (const o of obstacles) {
        if (!o.active) continue;
        o.mesh.position.z += speed;
        o.aabb.setFromObject(o.mesh);
        if (o.mesh.position.z > 6) { o.active = false; scene.remove(o.mesh); }
      }
      if (obstacles.filter(o => o.active).length < 10) {
        const lastZ = obstacles.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
        const nextBase = Math.min(lastZ, -20);
        // 60% chance: schedule a pattern; else spawn a single
        if (Math.random() < 0.6) {
          lastPatternEndZ = applyPattern(nextBase - 10 - Math.random() * 10);
        } else {
          spawnObstacle(nextBase - 12 - Math.random() * 8);
        }
      }

      // orbs (magnet)
      for (const orb of orbs) {
        if (!orb.active) continue;
        orb.mesh.position.z += speed;
        orb.mesh.rotation.y += 0.05;
        if (now < magnetUntilRef.current) {
          const d = orb.mesh.position.distanceTo(player.position);
          if (d < MAGNET_RADIUS) {
            tmpVec.copy(player.position).sub(orb.mesh.position).multiplyScalar(MAGNET_PULL);
            orb.mesh.position.add(tmpVec);
          }
        }
        orb.aabb.center.copy(orb.mesh.position);
        if (orb.mesh.position.z > 6) { orb.active = false; scene.remove(orb.mesh); }
      }
      if (orbs.filter(o => o.active).length < 12) {
        const lastZ = orbs.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
        spawnOrb(Math.min(lastZ, -10) - 9 - Math.random() * 6);
      }

      // powers
      for (const p of powers) {
        if (!p.active) continue;
        p.mesh.position.z += speed;
        p.mesh.rotation.y += 0.04;
        p.aabb.center.copy(p.mesh.position);
        if (p.mesh.position.z > 6) { p.active = false; scene.remove(p.mesh); }
      }
      if (powers.filter(p => p.active).length < 4 && Math.random() < 0.02) {
        const lastZ = powers.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
        spawnPower(Math.min(lastZ, -25) - 20 - Math.random() * 20);
      }

      // player AABB (respects slide) — slightly smaller hitbox for fairness
      const playerHeight = PLAYER_RADIUS * 2 * player.scale.y;
      const playerAABBSize = new THREE.Vector3(PLAYER_RADIUS * 2 * 0.88, Math.max(playerHeight * 0.90, 0.24), 0.72);
      const playerCenter = new THREE.Vector3(player.position.x, player.position.y, player.position.z);
      playerAABB.setFromCenterAndSize(playerCenter, playerAABBSize);

      // obstacle collisions (shield check)
      for (const o of obstacles) {
        if (!o.active) continue;
        if (playerAABB.intersectsBox(o.aabb)) {
          if (now < shieldUntilRef.current) {
            o.active = false; scene.remove(o.mesh);
            camera.position.x += (Math.random() - 0.5) * 0.1;
            camera.position.y += (Math.random() - 0.5) * 0.1;
            // puff + sound on shield hit
            burst(o.mesh.position.clone(), 22, 0.05, 450);
            playHit();
            // brief grace
            shieldUntilRef.current = now + 400;
          } else {
            // death puff + sound
            burst(player.position.clone(), 28, 0.07, 650);
            playHit();
            localDead = true;
          }
          if (localDead) break;
        }
      }

      // orb pickups & combo
      for (const orb of orbs) {
        if (!orb.active) continue;
        const d = player.position.distanceTo(orb.mesh.position);
        if (d < 0.45) {
          // sparkle + sound on pickup
          burst(orb.mesh.position.clone(), 16, 0.06, 500);
          playPickup();

          orb.active = false; scene.remove(orb.mesh);
          if (now - lastPickupAtRef.current <= COMBO_WINDOW_MS) comboRef.current += 1;
          else comboRef.current = 1;
          comboRef.current = Math.min(COMBO_MAX, comboRef.current);
          lastPickupAtRef.current = now;
          localScore += Math.round(10 * (1 + comboRef.current * 0.2));
        }
      }

      // power-up pickups
      for (const p of powers) {
        if (!p.active) continue;
        const d = player.position.distanceTo(p.mesh.position);
        if (d < 0.5) {
          p.active = false; scene.remove(p.mesh);
          if (p.kind === 'magnet') magnetUntilRef.current = now + MAGNET_MS;
          if (p.kind === 'boost')  boostUntilRef.current  = now + BOOST_MS;
          if (p.kind === 'shield') shieldUntilRef.current = now + SHIELD_MS;
        }
      }
      shieldMesh.visible = now < shieldUntilRef.current;
      shieldMesh.rotation.z += 0.08;

      // derive HUD badge percentages (throttled ~10fps)
      if (t % 6 === 0) {
        setBadgePct({
          magnet: Math.max(0, Math.min(1, (magnetUntilRef.current - now) / MAGNET_MS)),
          boost:  Math.max(0, Math.min(1, (boostUntilRef.current  - now) / BOOST_MS)),
          shield: Math.max(0, Math.min(1, (shieldUntilRef.current - now) / SHIELD_MS)),
        });

        // combo UI decay % toward 0 when idle
        const timeSincePickup = now - lastPickupAtRef.current;
        const pct = 1 - Math.min(1, timeSincePickup / COMBO_WINDOW_MS);
        const mult = 1 + Math.min(COMBO_MAX, comboRef.current) * 0.2;
        setComboInfo({ mult: Number(mult.toFixed(2)), pct: Math.max(0, pct) });
      }

      // distance score baseline
      if (!localDead) localScore = Math.max(localScore, Math.floor(t * 0.05));
      renderer.render(scene, camera);

      if (!localDead) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDead(true);
        setRunning(false);
        setBest(b => Math.max(b, localScore));
        setScore(localScore);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    cleanupRef.current = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      renderer.domElement.removeEventListener('touchstart', onTouchStart);
      renderer.domElement.removeEventListener('touchmove', onTouchMove);
      renderer.dispose();
      mount.innerHTML = '';
    };
  }, [size, quality, colors, dead, paused]);

  useEffect(() => {
    if (!running) return;
    startGame();
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [running, startGame]);

  const handleStart = () => { setDead(false); setScore(0); setRunning(false); startCountdown(); };
  const handleRetry = () => { setDead(false); setScore(0); setRunning(false); startCountdown(); };
  const handleSubmit = async () => { if (onSubmitScore) await onSubmitScore(score); };

  // mobile tap controls
  const tapLeft  = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  const tapRight = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  const tapJump  = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
  const tapSlide = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

  return (
    <div ref={containerRef} style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
      <div style={{ position: 'relative' }}>
        <div
          ref={mountRef}
          style={{
            width: size.w,
            height: size.h,
            borderRadius: 16,
            border: '1px solid #222',
            background: `linear-gradient(${colors.bgTop}, ${colors.bgBot})`,
            overflow: 'hidden',
          }}
        />

        {/* HUD Top Row */}
        <div style={{ position: 'absolute', top: 8, left: 10, right: 10, display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: 700 }}>
          <span>Score {score}</span>
          <span>Best {best}</span>
          <span>Speed {speedView}</span>
        </div>

        {/* Power-up badges center-top */}
        <div style={{ position: 'absolute', top: 36, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 8 }}>
          <Badge color="#ffda6b" label="Magnet" pct={badgePct.magnet} />
          <Badge color="#00ffd0" label="Boost" pct={badgePct.boost} />
          <Badge color="#8be9fd" label="Shield" pct={badgePct.shield} />
        </div>

        {/* Start / Pause / Settings */}
        <div style={{ position: 'absolute', top: 8, right: 10, display: 'flex', gap: 8 }}>
          {running || paused ? (
            <>
              <button onClick={() => setPaused(p => !p)} style={chip}>
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button onClick={() => setShowSettings(true)} style={chip}>Settings</button>
            </>
          ) : (
            <>
              <button onClick={handleStart} style={chip}>Start</button>
              <button onClick={() => setShowSettings(true)} style={chip}>Settings</button>
            </>
          )}
        </div>

        {/* Combo meter bottom */}
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 12 }}>
          <ComboBar mult={comboInfo.mult} pct={comboInfo.pct} />
        </div>

        {/* Idle Play overlay */}
        {!running && !dead && countdown === null && (
          <div style={overlay}>
            <button onClick={handleStart} style={bigPlayBtn}>Play</button>
          </div>
        )}

        {/* Countdown */}
        {countdown !== null && (
          <div style={overlay}>
            <div style={bubble}>{countdown}</div>
          </div>
        )}

        {/* Game over */}
        {dead && (
          <div style={overlay}>
            <div style={panel}>
              <h3 style={{ margin: 0 }}>Game over</h3>
              <p style={{ margin: '6px 0 12px 0' }}>Score {score}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleRetry} style={btn}>Retry</button>
                <button onClick={handleSubmit} style={btn}>Submit</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile controls (only when running or paused) */}
      {(running || paused) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button onClick={tapLeft} style={btn}>Left</button>
          <button onClick={tapJump} style={btn}>Jump</button>
          <button onClick={tapSlide} style={btn}>Slide</button>
          <button onClick={tapRight} style={btn}>Right</button>
        </div>
      )}

      {/* Settings drawer */}
      {showSettings && (
        <div style={drawerOverlay} onClick={() => setShowSettings(false)}>
          <div style={drawer} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Settings</h3>
            <div style={row}>
              <label>Theme</label>
              <select value={theme} onChange={e => setTheme(e.target.value as any)} style={select}>
                <option value="purple">Purple</option>
                <option value="neon">Neon</option>
                <option value="ink">Ink</option>
              </select>
            </div>
            <div style={row}>
              <label>Quality</label>
              <select value={quality} onChange={e => setQuality(Number(e.target.value))} style={select}>
                <option value={1}>Low</option>
                <option value={2}>Medium</option>
                <option value={3}>High</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => setShowSettings(false)} style={btn}>Close</button>
              {!running && !dead && <button onClick={handleStart} style={btn}>Start</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------- Small UI components ------- */

function Badge({ color, label, pct }: { color: string; label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(1, pct || 0));
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto 120px',
      alignItems: 'center',
      gap: 6,
      padding: '4px 8px',
      borderRadius: 10,
      border: '1px solid #333',
      background: '#111',
      color: '#fff',
      fontSize: 12,
    }}>
      <span style={{ width: 10, height: 10, borderRadius: 999, background: color }} />
      <div style={{ width: 120, height: 8, borderRadius: 6, background: '#222', overflow: 'hidden' }}>
        <div style={{ width: `${clamped * 100}%`, height: '100%', background: color }} />
      </div>
      <span style={{ marginLeft: 6, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

function ComboBar({ mult, pct }: { mult: number; pct: number }) {
  const w = Math.max(0, Math.min(1, pct || 0)) * 100;
  return (
    <div style={{
      display: 'grid',
      gap: 6,
      color: '#fff',
      fontWeight: 700,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span>Combo</span>
        <span>x{mult.toFixed(2)}</span>
      </div>
      <div style={{ width: '100%', height: 10, background: '#222', borderRadius: 8, overflow: 'hidden', border: '1px solid #333' }}>
        <div style={{ width: `${w}%`, height: '100%', background: 'linear-gradient(90deg, #ffe066, #6e59ff)' }} />
      </div>
    </div>
  );
}

/* ------- Styles ------- */
const chip: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 10,
  border: '1px solid #444',
  background: '#1a1a1a',
  color: '#fff',
  fontWeight: 700,
};

const btn: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid #444',
  background: '#1a1a1a',
  color: '#fff',
};

const bigPlayBtn: React.CSSProperties = {
  padding: '14px 28px',
  borderRadius: 16,
  border: '1px solid #444',
  background: '#1a1a1a',
  color: '#fff',
  fontSize: 20,
  fontWeight: 800,
};

const overlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(0,0,0,0.35)',
};

const bubble: React.CSSProperties = {
  width: 140,
  height: 140,
  display: 'grid',
  placeItems: 'center',
  fontSize: 64,
  borderRadius: 999,
  background: '#0008',
  border: '1px solid #333',
  color: '#fff',
};

const panel: React.CSSProperties = {
  background: '#111',
  border: '1px solid #222',
  borderRadius: 16,
  padding: 16,
  minWidth: 220,
  textAlign: 'center',
};

const drawerOverlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: '#0008',
  display: 'grid',
  placeItems: 'end center',
  zIndex: 40,
};

const drawer: React.CSSProperties = {
  width: 'min(420px, 92vw)',
  background: '#0f0f10',
  border: '1px solid #222',
  borderRadius: 16,
  padding: 16,
  margin: 12,
  color: '#fff',
};

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'center',
  gap: 10,
  marginTop: 10,
};

const select: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #444',
  color: '#fff',
  borderRadius: 8,
  padding: '6px 8px',
};
