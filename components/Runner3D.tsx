// components/Runner3D.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';

// RNG seeded by daily seed / world seed
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// 🌍 THEME WORLDS (auto-rotating biomes)
type WorldTheme = 'neonCity' | 'inkVoid' | 'frostCavern' | 'desertDusk';

const WORLD_THEMES: Record<WorldTheme, any> = {
  neonCity: {
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
    trail: 0x00e7ff,
    fog: [0x0a0a1a, 10, 90],
    weather: 'rain',
  },
  inkVoid: {
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
    trail: 0x6e59ff,
    fog: [0x0a0a0a, 12, 120],
    weather: 'snow',
  },
  frostCavern: {
    bgTop: '#b7d2ff',
    bgBot: '#6fa3ff',
    rail: 0xffffff,
    player: 0x96e0ff,
    obstacleGround: 0xc8e7ff,
    obstacleAir: 0x7dc7ff,
    grid: '#b7d2ff',
    emissive: 0x184c80,
    magnet: 0xffffff,
    boost: 0x88e0ff,
    shield: 0xc8e7ff,
    trail: 0xb7d2ff,
    fog: [0x6fa3ff, 6, 80],
    weather: 'snow',
  },
  desertDusk: {
    bgTop: '#ffbb66',
    bgBot: '#ff7733',
    rail: 0xffcc88,
    player: 0xffe066,
    obstacleGround: 0xcc6622,
    obstacleAir: 0xffaa44,
    grid: '#ffcc88',
    emissive: 0x552200,
    magnet: 0xffee99,
    boost: 0xffcc44,
    shield: 0xffeecc,
    trail: 0xffaa33,
    fog: [0xff9944, 8, 100],
    weather: 'sand',
  },
};

// player + movement
const PLAYER_RADIUS = 0.36;
const PLAYER_GROUND_Y = 0.5;
const JUMP_STRENGTH_BASE = 0.22;
const GRAVITY = 0.01;

// slide (manual; ends after duration)
const SLIDE_COOLDOWN_MS = 200;
const SLIDE_SCALE_Y = 0.4;
const SLIDE_DURATION_MS = 600;

// forgiveness + buffering
const COYOTE_MS = 120;
const JUMP_BUFFER_MS = 120;

// combo
const COMBO_WINDOW_MS = 2500;
const COMBO_MAX = 5;

// power-up durations
const MAGNET_MS = 10_000;
const BOOST_MS = 6_000;
const SHIELD_MS = 12_000;
const DOUBLE_MS = 8_000;

// magnet + boost params
const MAGNET_RADIUS = 2.2;
const MAGNET_PULL = 0.06;
const BOOST_MULT = 1.55;

// chain auto-boost
const CHAIN_WINDOW_MS = 1200;
const CHAIN_NEEDED = 3;
const CHAIN_BOOST_MS = 1600;

// perf target
const TARGET_FPS = 58;

type ObstacleType = 'ground' | 'air';
type Obs = { mesh: THREE.Mesh; aabb: THREE.Box3; active: boolean; type: ObstacleType };
type Orb = { mesh: THREE.Mesh; aabb: THREE.Sphere; active: boolean; z: number };
type PowerKind = 'magnet' | 'boost' | 'shield' | 'double';
type Power = { mesh: THREE.Mesh; aabb: THREE.Sphere; active: boolean; kind: PowerKind };
type Crystal = { mesh: THREE.Mesh; active: boolean };

export default function Runner3D({
  width = BASE_W,
  height = BASE_H,
  onSubmitScore,
  countdownSeconds = 2,
}: Props) {
  // mounts & raf
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const rafRef = useRef<RAF>(null);

  // game mode
  const [mode, setMode] = useState<'endless' | 'boss' | 'daily'>('endless');

  // game state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [dead, setDead] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [speedView, setSpeedView] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);

  // assists + upgrades
  const [assist, setAssist] = useState(false);
  const [upg, setUpg] = useState({ jump: 0, magnet: 0, slide: 0 });

  // Dash / Blink
  const dashCooldownRef = useRef(0);
  const [dashReady, setDashReady] = useState(true);

  // Perfect Chains
  const perfectChainRef = useRef(0);

  // Time Warp (slow-mo)
  const timeWarpUntilRef = useRef(0);

  // Daily seed + streak
  const [dailySeed, setDailySeed] = useState<number>(0);
  const [streak, setStreak] = useState<number>(0);

  // Share replay toggle
  const [canShare, setCanShare] = useState(false);

  // Beat clock
  const beatRef = useRef(0);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [quality, setQuality] = useState<number>(2);

  // worlds
  const [world, setWorld] = useState<WorldTheme>('neonCity');

  // HUD power badges + combo meter
  const [badgePct, setBadgePct] = useState({ magnet: 0, boost: 0, shield: 0, dbl: 0 });
  const [comboInfo, setComboInfo] = useState<{ mult: number; pct: number }>({ mult: 1, pct: 0 });

  // timers for HUD
  const magnetUntilRef = useRef(0);
  const boostUntilRef = useRef(0);
  const shieldUntilRef = useRef(0);
  const doubleUntilRef = useRef(0);

  const lastPickupAtRef = useRef(0);
  const comboRef = useRef(0);
  const lastSpeedRef = useRef(0);

  // chain boost tracking
  const chainTimesRef = useRef<number[]>([]);

  // responsive size
  const size = useMemo(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : width;
    const targetW = Math.min(width, vw - 24);
    const aspect = height / width;
    const targetH = Math.min(height, Math.floor(targetW * aspect));
    return { w: targetW, h: targetH };
  }, [width, height]);

  // theme colors
  const colors = useMemo(() => WORLD_THEMES[world], [world]);

  // Daily seed & streak once on mount
  useEffect(() => {
    const today = new Date();
    const key = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
    setDailySeed(
      (today.getFullYear() * 73856093) ^
        ((today.getMonth() + 1) * 19349663) ^
        (today.getDate() * 83492791)
    );

    const last = localStorage.getItem('last-play-day');
    const prev = Number(localStorage.getItem('streak') || 0);
    if (last === key) {
      setStreak(prev || 1);
    } else {
      const yday = new Date(Date.now() - 86400000);
      const ykey = `${yday.getFullYear()}-${yday.getMonth() + 1}-${yday.getDate()}`;
      const next = last === ykey ? prev + 1 : 1;
      localStorage.setItem('last-play-day', key);
      localStorage.setItem('streak', String(next));
      setStreak(next);
    }
  }, []);

  // Simple beat clock tied to world
  useEffect(() => {
    let bpm = 100;
    if (world === 'neonCity') bpm = 116;
    if (world === 'inkVoid') bpm = 96;
    if (world === 'frostCavern') bpm = 88;
    if (world === 'desertDusk') bpm = 104;
    const ms = Math.max(250, Math.round(60000 / bpm));
    const id = setInterval(() => {
      beatRef.current++;
    }, ms);
    return () => clearInterval(id);
  }, [world]);

  // auto-rotate worlds on mount
  useEffect(() => {
    const worlds: WorldTheme[] = ['neonCity', 'inkVoid', 'frostCavern', 'desertDusk'];
    const next = worlds[Math.floor(Math.random() * worlds.length)];
    setWorld(next);
  }, []);

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

  // pause on blur
  useEffect(() => {
    const onBlur = () => setPaused(true);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  // helpers
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
    for (let y = 0; y < sizePx; y += gap) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(sizePx, y);
      g.stroke();
    }
    for (let x = 0; x < sizePx; x += gap) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, sizePx);
      g.stroke();
    }
    g.globalAlpha = 1;
    return new THREE.CanvasTexture(c);
  }

  const startGame = useCallback(() => {
    if (!mountRef.current) return;

    const W = size.w;
    const H = size.h;
    const mount = mountRef.current;

    // seeded RNG (daily or endless/boss)
    const rand = mulberry32(
      mode === 'endless'
        ? (Date.now() >>> 0)
        : mode === 'boss'
        ? (dailySeed ^ 0xB055)
        : dailySeed
    );

    // scene/camera/renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(colors.fog[0], colors.fog[1], colors.fog[2]);

    const camera = new THREE.PerspectiveCamera(FIXED_FOV, W / H, 0.1, 500);
    camera.position.set(0, 2.1, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: quality >= 2, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality));
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = quality >= 2;
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    // --- WebAudio micro fx ---
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    // guard for autoplay policies
    let audioCtx: AudioContext | null = null;
    try { audioCtx = new AudioCtx(); } catch {}
    function beep(freq: number, durMs: number, type: OscillatorType, gainVal: number) {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type; osc.frequency.value = freq;
      gain.gain.value = gainVal;
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); } catch {} }, durMs);
    }
    const playJump   = () => beep(420, 120, 'sine', 0.05);
    const playPickup = () => beep(880, 90, 'triangle', 0.05);
    const playSlide  = () => beep(220, 80, 'sawtooth', 0.03);
    const playHit    = () => beep(120, 140, 'square', 0.06);
    const playBoost  = () => beep(600, 300, 'sawtooth', 0.05);

    // Minimal layered music without Howler
    const musicFiles = ['bass.mp3', 'pads.mp3', 'arps.mp3', 'drums.mp3'];
    const tracks: HTMLAudioElement[] = musicFiles.map(f => {
      const a = new Audio(`/audio/${f}`);
      a.loop = true;
      a.volume = 0;
      a.playbackRate = 1;
      return a;
    });
    function startMusic() {
      tracks.forEach(a => a.play().catch(()=>{}));
    }
    function stopMusic() {
      tracks.forEach(a => { a.pause(); a.currentTime = 0; });
    }
    function updateMusic(speedMult: number, comboMult: number) {
      const intensity = Math.min(1.5, speedMult + comboMult * 0.1);
      tracks[0].volume = 0.25 + 0.2 * intensity; // bass
      tracks[1].volume = 0.2 + 0.12 * intensity; // pads
      tracks[2].volume = Math.min(0.45, 0.08 + comboMult * 0.05); // arps
      tracks[3].volume = speedMult > 1 ? 0.5 : 0.18; // drums
    }
    setCanShare(true);
    startMusic();

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
    const playerMat = new THREE.MeshStandardMaterial({
      color: colors.player, roughness: 0.35, metalness: 0.1,
      emissive: colors.emissive, emissiveIntensity: 0.5
    });
    const player = new THREE.Mesh(playerGeo, playerMat);
    player.castShadow = true; player.position.set(0, PLAYER_GROUND_Y, 0); scene.add(player);

    // shield visual
    const shieldGeo = new THREE.RingGeometry(0.52, 0.6, 32);
    const shieldMat = new THREE.MeshBasicMaterial({ color: colors.shield, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
    shieldMesh.rotation.x = Math.PI / 2; shieldMesh.visible = false; player.add(shieldMesh);

    // glow trail
    const trailCount = 28;
    const trailGeo = new THREE.SphereGeometry(0.08, 8, 8);
    const trailMat = new THREE.MeshBasicMaterial({
      color: colors.trail, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const trail = new THREE.InstancedMesh(trailGeo, trailMat, trailCount);
    const trailPositions: THREE.Vector3[] = Array.from({ length: trailCount }, () => new THREE.Vector3());
    const trailMatrix = new THREE.Matrix4();
    scene.add(trail);

    // dust particles
    const MAX_PARTICLES = 400;
    const partGeo = new THREE.BufferGeometry();
    const pPositions = new Float32Array(MAX_PARTICLES * 3);
    const pVelocities = new Float32Array(MAX_PARTICLES * 3);
    const pLife = new Float32Array(MAX_PARTICLES);
    partGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
    const partMat = new THREE.PointsMaterial({
      size: 0.06, transparent: true, opacity: 0.35, color: 0x5f5242
    });
    const particles = new THREE.Points(partGeo, partMat);
    scene.add(particles);
    let pCursor = 0;

    function emitParticle(pos: THREE.Vector3, vel: THREE.Vector3, life: number = 600) {
      const i = pCursor % MAX_PARTICLES;
      pPositions[i*3+0] = pos.x; pPositions[i*3+1] = pos.y; pPositions[i*3+2] = pos.z;
      pVelocities[i*3+0] = vel.x; pVelocities[i*3+1] = vel.y; pVelocities[i*3+2] = vel.z;
      pLife[i] = life;
      pCursor++;
      partGeo.attributes.position.needsUpdate = true;
    }

    function burst(pos: THREE.Vector3, count: number = 14, speedAmt: number = 0.06, life: number = 500) {
      for (let i = 0; i < count; i++) {
        const a = rand() * Math.PI * 2;
        const v = new THREE.Vector3(
          Math.cos(a) * speedAmt * (0.5 + rand()),
          rand() * speedAmt,
          Math.sin(a) * speedAmt * (0.5 + rand())
        );
        emitParticle(pos, v, life + rand() * 200);
      }
    }

    // speed lines (during boost)
    const SPEEDLINE_COUNT = 120;
    const slGeo = new THREE.BufferGeometry();
    const slPos = new Float32Array(SPEEDLINE_COUNT * 6);
    slGeo.setAttribute('position', new THREE.BufferAttribute(slPos, 3));
    const slMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending });
    const speedLines = new THREE.LineSegments(slGeo, slMat);
    scene.add(speedLines);
    function resetSpeedLines() {
      for (let i = 0; i < SPEEDLINE_COUNT; i++) {
        const idx = i * 6;
        const x = -1.6 + rand() * 3.2;
        const y = 0.4 + rand() * 1.6;
        const z = -2 - rand() * 18;
        slPos[idx+0] = x; slPos[idx+1] = y; slPos[idx+2] = z;
        slPos[idx+3] = x; slPos[idx+4] = y; slPos[idx+5] = z - 0.7;
      }
      (slGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
    resetSpeedLines();

    // weather FX
    const WEATHER = colors.weather; // from world
    const WEATHER_COUNT = 500;
    const wPos = new Float32Array(WEATHER_COUNT * 3);
    const wVel = new Float32Array(WEATHER_COUNT * 3);
    for (let i = 0; i < WEATHER_COUNT; i++) {
      wPos[i*3+0] = -2.2 + rand()*4.4;
      wPos[i*3+1] = 2 + rand()*3.5;
      wPos[i*3+2] = -2 - rand()*60;
      wVel[i*3+0] = 0;
      wVel[i*3+1] = (WEATHER === 'snow' ? -0.01 : -0.08) - rand()* (WEATHER === 'snow' ? 0.02 : 0.06);
      wVel[i*3+2] = 0.15 + rand()*0.2;
    }
    const weatherGeo = new THREE.BufferGeometry();
    weatherGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3));
    const weatherMat = new THREE.PointsMaterial({
      size: WEATHER === 'snow' ? 0.035 : 0.02,
      transparent: true,
      opacity: WEATHER === 'snow' ? 0.9 : 0.6,
      color: WEATHER === 'snow' ? 0xffffff : 0x86a6ff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const weatherPoints = new THREE.Points(weatherGeo, weatherMat);
    scene.add(weatherPoints);

    // params & difficulty
    let baseSpeed = 0.28;
    const accel = 0.00008;

    // animation tick counter
    let t = 0;
    function diffFactor(): number {
      const seconds = t / 60;
      const adapt = Math.min(1, (seconds > 10 ? (localScore / (seconds * 12 + 1)) : 0) * 0.15);
      const val = Math.max(0, Math.min(1, seconds / 90 + adapt));
      return val;
    }

    // physics state
    const lanes = [-1.2, 0, 1.2];
    let laneIndex = 1;
    let vy = 0;
    let y = PLAYER_GROUND_Y;

    // landing/coyote/buffer/double jump
    let lastGroundedAt = 0;
    let wasGrounded = true;
    let jumpBufferUntil = 0;
    let jumpsSinceAir = 0;
    const hasDouble = () => performance.now() < doubleUntilRef.current;

    // slide (toggle)
    let sliding = false;
    let slideStartAt = 0;
    let slideEndedAt = 0;

    const endSlideNow = () => {
      sliding = false;
      slideEndedAt = performance.now();
      player.scale.y = Math.max(player.scale.y, 0.9);
      player.position.y = Math.max(player.position.y, PLAYER_GROUND_Y);
    };
    const beginSlide = () => {
      sliding = true;
      slideStartAt = performance.now();
      playSlide();
    };
    const updateSlide = () => {
      if (!sliding) {
        player.scale.y += (1 - player.scale.y) * 0.35;
        player.position.y += (PLAYER_GROUND_Y - player.position.y) * 0.35;
        return;
      }
      const elapsed = performance.now() - slideStartAt;
      player.scale.y += (SLIDE_SCALE_Y - player.scale.y) * 0.35;
      const crouchOffset = (1 - player.scale.y) * PLAYER_RADIUS;
      const targetY = PLAYER_GROUND_Y - crouchOffset * 0.85;
      player.position.y += (targetY - player.position.y) * 0.35;

      const slideDur = SLIDE_DURATION_MS * (1 + upg.slide * 0.06);
      if (elapsed >= slideDur) {
        sliding = false;
        slideEndedAt = performance.now();
      }
    };

    // content: obstacles/orbs/powers/crystals
    const obstacles: Obs[] = [];
    const obsGroundGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const obsGroundMat = new THREE.MeshStandardMaterial({ color: colors.obstacleGround, roughness: 0.6 });
    const obsAirGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const obsAirMat = new THREE.MeshStandardMaterial({ color: colors.obstacleAir, roughness: 0.5 });

    type PatternPiece = { type: 'ground' | 'air'; dz: number; lane?: number; };
    const patterns: PatternPiece[][] = [
      [
        { type: 'ground', dz: 0, lane: 0 },
        { type: 'air', dz: 6, lane: 1 },
        { type: 'ground', dz: 12, lane: 2 },
      ],
      [
        { type: 'air', dz: 0, lane: 0 },
        { type: 'air', dz: 5, lane: 1 },
        { type: 'air', dz: 10, lane: 2 },
      ],
      [
        { type: 'ground', dz: 0, lane: 1 },
        { type: 'ground', dz: 6, lane: 1 },
        { type: 'air', dz: 12, lane: 2 },
      ],
      [
        { type: 'air', dz: 0 },
        { type: 'ground', dz: 4 },
        { type: 'air', dz: 8 },
        { type: 'ground', dz: 12 },
      ],
    ];

    function spawnObstacleWithType(zPos: number, laneIdx: number, type: 'ground' | 'air') {
      const laneX = [-1.2, 0, 1.2][laneIdx];
      const geo = type === 'air' ? obsAirGeo : obsGroundGeo;
      const mat = type === 'air' ? obsAirMat : obsGroundMat;
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.position.set(laneX, type === 'air' ? 1.05 : 0.55, zPos);

      // moving/rotating hazards
      (m.userData as any).move = rand() < 0.25;
      (m.userData as any).rot  = rand() < 0.20;
      (m.userData as any).amp  = 0.35 + rand()*0.35;
      (m.userData as any).spd  = 0.6 + rand()*0.8;

      scene.add(m);
      const aabb = new THREE.Box3().setFromObject(m);
      obstacles.push({ mesh: m, aabb, active: true, type });
    }

    function applyPattern(zStart: number) {
      const pick = patterns[Math.floor(rand() * patterns.length)];
      for (const p of pick) {
        const laneIdx = typeof p.lane === 'number' ? p.lane : Math.floor(rand() * 3);
        spawnObstacleWithType(zStart - p.dz, laneIdx, p.type);
      }
      return zStart - (pick[pick.length - 1]?.dz ?? 12) - 8;
    }

    let lastPatternEndZ = -40;

    function spawnObstacle(zPos: number) {
      const laneX = lanes[Math.floor(rand() * lanes.length)];
      const isAir = rand() < (0.45 + 0.3 * diffFactor());
      const geo = isAir ? obsAirGeo : obsGroundGeo;
      const mat = isAir ? obsAirMat : obsGroundMat;
      const m = new THREE.Mesh(geo, mat); m.castShadow = true;
      m.position.set(laneX, isAir ? 1.08 : 0.55, zPos);

      // moving/rotating hazards
      (m.userData as any).move = rand() < 0.25;
      (m.userData as any).rot  = rand() < 0.20;
      (m.userData as any).amp  = 0.35 + rand()*0.35;
      (m.userData as any).spd  = 0.6 + rand()*0.8;

      scene.add(m);
      const aabb = new THREE.Box3().setFromObject(m);
      obstacles.push({ mesh: m, aabb, active: true, type: isAir ? 'air' : 'ground' });
    }

    const orbs: Orb[] = [];
    const orbGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const orbMat = new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0xffb400, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.3 });
    function spawnOrb(zPos: number) {
      const laneX = lanes[Math.floor(rand() * lanes.length)];
      const m = new THREE.Mesh(orbGeo, orbMat);
      m.position.set(laneX, 0.8 + rand() * 0.4, zPos);
      scene.add(m);
      const sphere = new THREE.Sphere(m.position, 0.22);
      orbs.push({ mesh: m, aabb: sphere, active: true, z: zPos });
    }

    const powers: Power[] = [];
    const ico = new THREE.IcosahedronGeometry(0.26, 0);
    const matMagnet = new THREE.MeshStandardMaterial({ color: colors.magnet, emissive: 0xffb400, emissiveIntensity: 0.7, roughness: 0.3 });
    const matBoost = new THREE.MeshStandardMaterial({ color: colors.boost, emissive: 0x00bfa5, emissiveIntensity: 0.8, roughness: 0.3 });
    const matShield = new THREE.MeshStandardMaterial({ color: colors.shield, emissive: 0x67d4ff, emissiveIntensity: 0.8, roughness: 0.3 });
    const matDouble = new THREE.MeshStandardMaterial({ color: 0xff66d9, emissive: 0xff66d9, emissiveIntensity: 0.8, roughness: 0.3 });

    function spawnPower(zPos: number) {
      const laneX = lanes[Math.floor(rand() * lanes.length)];
      const r = rand();
      const kind: PowerKind = r < 0.32 ? 'magnet' : r < 0.62 ? 'boost' : r < 0.86 ? 'shield' : 'double';
      const mat = kind === 'magnet' ? matMagnet : kind === 'boost' ? matBoost : kind === 'shield' ? matShield : matDouble;
      const m = new THREE.Mesh(ico, mat);
      m.position.set(laneX, 0.9, zPos);
      scene.add(m);
      const sphere = new THREE.Sphere(m.position, 0.28);
      powers.push({ mesh: m, aabb: sphere, active: true, kind });
    }

    // crystals (upgrade currency)
    const crystals: Crystal[] = [];
    const cryGeo = new THREE.OctahedronGeometry(0.18, 0);
    const cryMat = new THREE.MeshStandardMaterial({ color: 0x88e1ff, emissive: 0x2277bb, emissiveIntensity: 0.9, roughness: 0.25 });
    function spawnCrystal(zPos: number) {
      const laneX = lanes[Math.floor(rand() * lanes.length)];
      const m = new THREE.Mesh(cryGeo, cryMat);
      m.position.set(laneX, 0.95 + rand()*0.4, zPos);
      m.rotation.y = rand()*Math.PI;
      crystals.push({ mesh: m, active: true });
      scene.add(m);
    }

    // preload obstacles or boss wave depending on mode
    if (mode === 'boss') {
      for (let i = 0; i < 50; i++) {
        const pattern = i % 2 === 0 ? 'air' : 'ground';
        spawnObstacleWithType(-i * 8, i % 3, pattern as ObstacleType);
      }
    } else {
      for (let i = 1; i <= 10; i++) spawnObstacle(-i * 12);
    }
    // preload crystals
    for (let i = 1; i <= 6; i++) spawnCrystal(-i * 22 - 10);

    // reset timers
    magnetUntilRef.current = 0;
    boostUntilRef.current = 0;
    shieldUntilRef.current = 0;
    doubleUntilRef.current = 0;

    comboRef.current = 0;
    lastPickupAtRef.current = 0;

    // input
    const onKey = (e: KeyboardEvent) => {
      if (dead || paused) return;
      const now = performance.now();

      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') {
        jumpBufferUntil = now + JUMP_BUFFER_MS;

        const grounded = y <= PLAYER_GROUND_Y + 0.0001;
        const withinCoyote = now - lastGroundedAt <= (assist ? COYOTE_MS + 100 : COYOTE_MS);
        const canDouble = hasDouble() && jumpsSinceAir < 1;

        if (sliding) endSlideNow();

        if (grounded || withinCoyote || canDouble) {
          const currentSpeed = lastSpeedRef.current;
          const speedScale = 1 + Math.min(0.3, currentSpeed * 0.02);
          const jumpUp = 1 + upg.jump * 0.05;
          vy = JUMP_STRENGTH_BASE * speedScale * jumpUp;

          // perfect chain window
          if (grounded || withinCoyote) {
            const delta = now - lastGroundedAt;
            if (delta < 40) {
              perfectChainRef.current++;
              burst(player.position.clone(), 10, 0.07, 350);
            } else {
              perfectChainRef.current = 0;
            }
          }

          if (!grounded && !withinCoyote) {
            jumpsSinceAir += 1; // true mid-air double
          }
          playJump();
          jumpBufferUntil = 0;
        }
      }

      if (e.key === 'Shift') {
        if (now > dashCooldownRef.current) {
          const lanesArr = [-1.2, 0, 1.2];
          const target = lanesArr[laneIndex];
          camera.position.x += (rand()-0.5)*0.2;
          camera.position.y += (rand()-0.5)*0.1;
          player.position.x = target;
          dashCooldownRef.current = now + 1200;
          setDashReady(false);
          setTimeout(() => setDashReady(true), 1200);
        }
      }

      if (e.key === 'ArrowLeft' || e.key === 'a') { laneIndex = Math.max(0, laneIndex - 1); }
      if (e.key === 'ArrowRight' || e.key === 'd') { laneIndex = Math.min(2, laneIndex + 1); }

      // crouch toggle
      if (e.key === 'ArrowDown' || e.key === 's') {
        vy = Math.min(vy, 0);
        beginSlide();
      }

      if (e.key === 'Escape') setPaused(p => !p);
    };
    window.addEventListener('keydown', onKey);

    const onPointer = (e: PointerEvent) => {
      if (dead || paused) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      if (x < -0.33) { laneIndex = 0; }
      else if (x > 0.33) { laneIndex = 2; }
      else { laneIndex = 1; }
    };
    window.addEventListener('pointerdown', onPointer);

    // touch slide
    let lastY = 0;
    const onTouchStart = (e: TouchEvent) => { lastY = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - lastY;
      if (dy > 32) { if (sliding) endSlideNow(); else beginSlide(); }
    };
    renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: true });
    renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: true });

    // fps tracking for dynamic quality
    let lastFrameTime = performance.now();
    let fpsSmoothed = TARGET_FPS;

    // locals
    let localScore = 0;
    let localDead = false;
    const playerAABB = new THREE.Box3();
    const tmpVec = new THREE.Vector3();

    const animate = () => {
      if (fpsSmoothed < 45 && quality > 1) setQuality(q => Math.max(1, q - 1));
      if (paused) {
        rafRef.current = requestAnimationFrame(animate);
        return renderer.render(scene, camera);
      }

      const now = performance.now();
      const dt = Math.max(1, now - lastFrameTime);
      const instantFPS = 1000 / dt;
      fpsSmoothed = fpsSmoothed * 0.9 + instantFPS * 0.1;
      lastFrameTime = now;

      // dynamic quality fade when needed
      if (fpsSmoothed < TARGET_FPS - 8) {
        renderer.shadowMap.enabled = false;
        (weatherMat as THREE.PointsMaterial).opacity *= 0.98;
        (partMat as THREE.PointsMaterial).opacity *= 0.99;
        (slMat as THREE.LineBasicMaterial).opacity *= 0.98;
      }

      t += 1;

      // speed
      const speedMult = now < boostUntilRef.current ? BOOST_MULT : 1;
      const extra = 0.00004 * diffFactor();

      // near-miss slow-mo
      const slowmo = performance.now() < timeWarpUntilRef.current ? 0.45 : 1;

      const scrollSpeedBase = (baseSpeed + (t * (accel + extra))) * speedMult;
      const scrollSpeed = scrollSpeedBase * slowmo * (assist ? 0.92 : 1);
      lastSpeedRef.current = scrollSpeed;

      // music layers follow intensity
      updateMusic(speedMult, comboRef.current);

      if (t % Math.max(300, 600 - Math.floor(300 * diffFactor())) === 0) baseSpeed += 0.05;

      // HUD throttle
      if (t % 6 === 0) setSpeedView(Number(scrollSpeed.toFixed(2)));

      // occasional lightning flash (not in inkVoid)
      if (rand() < 0.002 && world !== 'inkVoid') {
        const flash = 0.25 + rand()*0.35;
        (renderer.domElement.style as any).filter = `brightness(${1+flash})`;
        setTimeout(() => { (renderer.domElement.style as any).filter = ''; }, 120);
      }

      // particles update
      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (pLife[i] > 0) {
          pLife[i] -= dt;
          pVelocities[i*3+1] -= 0.0004;
          pPositions[i*3+0] += pVelocities[i*3+0];
          pPositions[i*3+1] += pVelocities[i*3+1];
          pPositions[i*3+2] += pVelocities[i*3+2] + scrollSpeed * 0.3;
        }
      }
      partGeo.attributes.position.needsUpdate = true;

      // speed lines
      (speedLines.material as THREE.LineBasicMaterial).opacity = speedMult > 1 ? 0.38 : 0.0;
      if (speedMult > 1) {
        const attr = slGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < SPEEDLINE_COUNT; i++) {
          const idx = i * 6;
          slPos[idx+2] += scrollSpeed * 1.8;
          slPos[idx+5] += scrollSpeed * 1.8;
          if (slPos[idx+2] > 4) {
            const x = -1.6 + rand()*3.2;
            const y = 0.4 + rand()*1.6;
            const z = -2 - rand()*18;
            slPos[idx+0]=x; slPos[idx+1]=y; slPos[idx+2]=z;
            slPos[idx+3]=x; slPos[idx+4]=y; slPos[idx+5]=z-0.7;
          }
        }
        attr.needsUpdate = true;
      }

      // weather update
      const wAttr = weatherGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < WEATHER_COUNT; i++) {
        wPos[i*3+1] += wVel[i*3+1];
        wPos[i*3+2] += wVel[i*3+2] + scrollSpeed * 0.4;
        if (wPos[i*3+1] < 0.2 || wPos[i*3+2] > 6) {
          wPos[i*3+0] = -2.2 + rand()*4.4;
          wPos[i*3+1] = 2 + rand()*3.5;
          wPos[i*3+2] = -20 - rand()*40;
        }
      }
      wAttr.needsUpdate = true;

      // lane movement dt-aware
      const lanesArr = [-1.2, 0, 1.2];
      const targetX = lanesArr[laneIndex];
      const dx = targetX - player.position.x;
      const dtSec = Math.max(0.001, dt / 1000);
      const maxSpeed = 6.0;
      const maxStep = maxSpeed * dtSec;
      const step = Math.sign(dx) * Math.min(Math.abs(dx), maxStep);
      player.position.x += step;
      camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, -step * 0.9, 0.25);
      if (Math.abs(targetX - player.position.x) < maxStep) player.position.x = targetX;

      // jump/grav + buffer/double
      const grounded = y <= PLAYER_GROUND_Y + 0.0001;

      if (grounded && !wasGrounded) {
        jumpsSinceAir = 0;
        lastGroundedAt = now;
        if (now <= jumpBufferUntil) {
          const speedScale = 1 + Math.min(0.3, scrollSpeed * 0.02);
          const jumpUp = 1 + upg.jump * 0.05;
          vy = JUMP_STRENGTH_BASE * speedScale * jumpUp;
          playJump();
          jumpBufferUntil = 0;
        }
      }

      // allow jump buffer while steadily grounded
      if (grounded && jumpBufferUntil) {
        const speedScale = 1 + Math.min(0.3, scrollSpeed * 0.02);
        const jumpUp = 1 + upg.jump * 0.05;
        vy = JUMP_STRENGTH_BASE * speedScale * jumpUp;
        playJump();
        jumpBufferUntil = 0;
      }

      if (!sliding) {
        vy -= GRAVITY; y += vy; if (y < PLAYER_GROUND_Y) { y = PLAYER_GROUND_Y; vy = 0; }
      } else { y = PLAYER_GROUND_Y; vy = 0; }
      player.position.y = y;
      if (grounded) lastGroundedAt = now;
      wasGrounded = grounded;

      // slide animation
      updateSlide();

      // glow trail
      for (let i = trailCount - 1; i > 0; i--) trailPositions[i].copy(trailPositions[i - 1]);
      trailPositions[0].set(player.position.x, player.position.y, player.position.z);
      for (let i = 0; i < trailCount; i++) {
        const p = trailPositions[i];
        const alpha = (1 - i / trailCount) * 0.35 * (speedMult > 1 ? 1.2 : 0.9);
        (trail.material as THREE.MeshBasicMaterial).opacity = alpha;
        trailMatrix.makeTranslation(p.x, p.y, p.z - i * 0.02);
        trail.setMatrixAt(i, trailMatrix);
      }
      trail.instanceMatrix.needsUpdate = true;

      // world scroll
      ground.position.z += scrollSpeed;
      (groundMat.map as THREE.CanvasTexture).offset.y += scrollSpeed * 0.06;
      if (ground.position.z > -120) ground.position.z = -160;

      // obstacles move and animate
      for (const o of obstacles) {
        if (!o.active) continue;

        const ud = o.mesh.userData as any;
        if (ud.move) {
          o.mesh.position.x += Math.sin((t*0.03) + (beatRef.current*0.6)) * 0.006 * ud.spd;
          o.mesh.position.x = THREE.MathUtils.clamp(o.mesh.position.x, -1.8, 1.8);
        }
        if (ud.rot) {
          o.mesh.rotation.y += 0.01 * ud.spd;
        }

        o.mesh.position.z += scrollSpeed;
        o.aabb.setFromObject(o.mesh);
        if (o.mesh.position.z > 6) { o.active = false; scene.remove(o.mesh); }
      }
      if (obstacles.filter(o => o.active).length < 10) {
        const lastZ = obstacles.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
        const nextBase = Math.min(lastZ, -20);
        if (rand() < 0.6 + 0.2 * diffFactor()) {
          lastPatternEndZ = applyPattern(nextBase - 9 - rand() * (8 - 4 * diffFactor()));
        } else {
          spawnObstacle(nextBase - 10 - rand() * (9 - 4 * diffFactor()));
        }
      }

      // orbs
      for (const orb of orbs) {
        if (!orb.active) continue;
        orb.mesh.position.z += scrollSpeed; orb.mesh.rotation.y += 0.05;
        if (now < magnetUntilRef.current) {
          const d = orb.mesh.position.distanceTo(player.position);
          const magnetRadius = MAGNET_RADIUS * (1 + upg.magnet * 0.06);
          if (d < magnetRadius) {
            tmpVec.copy(player.position).sub(orb.mesh.position).multiplyScalar(MAGNET_PULL);
            orb.mesh.position.add(tmpVec);
          }
        }
        orb.aabb.center.copy(orb.mesh.position);
        if (orb.mesh.position.z > 6) { orb.active = false; scene.remove(orb.mesh); }
      }
      if (orbs.filter(o => o.active).length < 12) {
        const lastZ = orbs.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
        spawnOrb(Math.min(lastZ, -10) - 9 - rand() * 6);
      }

      // powers
      for (const pwr of powers) {
        if (!pwr.active) continue;
        pwr.mesh.position.z += scrollSpeed; pwr.mesh.rotation.y += 0.04;
        pwr.aabb.center.copy(pwr.mesh.position);
        if (pwr.mesh.position.z > 6) { pwr.active = false; scene.remove(pwr.mesh); }
      }
      if (powers.filter(p => p.active).length < 4 && rand() < 0.02) {
        const lastZ = powers.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
        spawnPower(Math.min(lastZ, -25) - 20 - rand() * 20);
      }

      // crystals
      for (const c of crystals) {
        if (!c.active) continue;
        c.mesh.position.z += scrollSpeed;
        c.mesh.rotation.y += 0.02;
        if (player.position.distanceTo(c.mesh.position) < 0.46) {
          c.active = false;
          scene.remove(c.mesh);
          setUpg(u => ({ ...u, jump: Math.min(5, u.jump + 1) })); // +1 jump upgrade point
          burst(c.mesh.position.clone(), 16, 0.06, 500);
        }
        if (c.mesh.position.z > 6) { c.active = false; scene.remove(c.mesh); }
      }
      if (crystals.filter(c => c.active).length < 6 && rand() < 0.03) {
        spawnCrystal(Math.min(-24, -20 - rand()*20));
      }

      // collisions (expand AABB in Z)
      const pHeight = PLAYER_RADIUS * 2 * player.scale.y;
      const isSlidingNow = sliding;
      const widthFactor  = isSlidingNow ? 0.78 : 0.88;
      const heightFactor = isSlidingNow ? 0.62 : (assist ? 0.90 : 0.95);
      const minHeight    = isSlidingNow ? 0.16 : 0.24;
      const pSize = new THREE.Vector3(
        PLAYER_RADIUS * 2 * widthFactor,
        Math.max(pHeight * heightFactor, minHeight),
        0.72
      );
      playerAABB.setFromCenterAndSize(player.position.clone(), pSize);

      const expandedAABB = playerAABB.clone();
      const zPad = scrollSpeed * 0.25;
      expandedAABB.min.z -= zPad; expandedAABB.max.z += zPad;
      const xPad = 0.03;
      expandedAABB.min.x -= xPad; expandedAABB.max.x += xPad;

      // near-miss time warp
      for (const o of obstacles) {
        if (!o.active) continue;
        const dz = Math.abs(o.mesh.position.z - player.position.z);
        const dx = Math.abs(o.mesh.position.x - player.position.x);
        const dy = Math.abs(o.mesh.position.y - player.position.y);
        if (dz < 0.20 && dx < 0.45 && dy < 0.55) {
          if (now > timeWarpUntilRef.current) timeWarpUntilRef.current = now + 700;
          break;
        }
      }

      for (const o of obstacles) {
        if (!o.active) continue;
        if (expandedAABB.intersectsBox(o.aabb)) {
          if (now < shieldUntilRef.current) {
            o.active = false; scene.remove(o.mesh);
            camera.position.x += (rand() - 0.5) * 0.1;
            camera.position.y += (rand() - 0.5) * 0.1;
            burst(o.mesh.position.clone(), 22, 0.05, 450);
            playHit();
            shieldUntilRef.current = now + 400;
          } else {
            burst(player.position.clone(), 28, 0.07, 650);
            playHit();
            localDead = true;
            break;
          }
        }
      }

      // pickups + combo + chain boost
      for (const orb of orbs) {
        if (!orb.active) continue;
        if (player.position.distanceTo(orb.mesh.position) < 0.45) {
          burst(orb.mesh.position.clone(), 16, 0.06, 500);
          playPickup();
          orb.active = false; scene.remove(orb.mesh);

          if (now - lastPickupAtRef.current <= COMBO_WINDOW_MS) comboRef.current += 1;
          else comboRef.current = 1;
          comboRef.current = Math.min(COMBO_MAX, comboRef.current);
          lastPickupAtRef.current = now;
          localScore += Math.round(10 * (1 + Math.min(COMBO_MAX, comboRef.current) * 0.2));

          chainTimesRef.current.push(now);
          chainTimesRef.current = chainTimesRef.current.filter(ts => now - ts <= CHAIN_WINDOW_MS);
          if (chainTimesRef.current.length >= CHAIN_NEEDED) {
            boostUntilRef.current = Math.max(boostUntilRef.current, now + CHAIN_BOOST_MS);
            chainTimesRef.current.length = 0;
            playBoost();
          }
        }
      }

      // power-up touches
      for (const pwr of powers) {
        if (!pwr.active) continue;
        if (player.position.distanceTo(pwr.mesh.position) < 0.5) {
          pwr.active = false; scene.remove(pwr.mesh);
          if (pwr.kind === 'magnet') magnetUntilRef.current = now + MAGNET_MS;
          if (pwr.kind === 'boost')  { boostUntilRef.current = now + BOOST_MS; playBoost(); }
          if (pwr.kind === 'shield') shieldUntilRef.current = now + SHIELD_MS;
          if (pwr.kind === 'double') doubleUntilRef.current = now + DOUBLE_MS;
        }
      }
      shieldMesh.visible = now < shieldUntilRef.current;
      shieldMesh.rotation.z += 0.08;

      // HUD badge & combo decay (10fps)
      if (t % 6 === 0) {
        setBadgePct({
          magnet: Math.max(0, Math.min(1, (magnetUntilRef.current - now) / MAGNET_MS)),
          boost:  Math.max(0, Math.min(1, (boostUntilRef.current  - now) / BOOST_MS)),
          shield: Math.max(0, Math.min(1, (shieldUntilRef.current - now) / SHIELD_MS)),
          dbl:    Math.max(0, Math.min(1, (doubleUntilRef.current - now) / DOUBLE_MS)),
        });
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
        stopMusic();
        setDead(true); setRunning(false);
        setBest(b => Math.max(b, localScore));
        setScore(localScore);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    cleanupRef.current = () => {
      stopMusic();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      renderer.domElement.removeEventListener('touchstart', onTouchStart as any);
      renderer.domElement.removeEventListener('touchmove', onTouchMove as any);
      renderer.dispose();
      mount.innerHTML = '';
    };
  }, [size, quality, colors, world, mode, dailySeed, assist, upg.jump, upg.magnet, upg.slide]);

  useEffect(() => {
    if (!running) return;
    startGame();
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [running, startGame]);

  const handleStart = () => {
    setDead(false); setScore(0); setRunning(false); setPaused(false); setCountdown(null);
    setTimeout(() => setCountdown(countdownSeconds), 0);
  };
  const handleRetry = () => {
    setDead(false); setScore(0); setRunning(false); setPaused(false); setCountdown(null);
    setTimeout(() => setCountdown(countdownSeconds), 0);
  };
  const handleSubmit = async () => { if (onSubmitScore) await onSubmitScore(score); };

  const handleShare = () => {
    const cnv = mountRef.current?.querySelector('canvas');
    if (!cnv) return;
    const png = cnv.toDataURL('image/png');
    const w = window.open();
    if (w) {
      w.document.write(`<img src="${png}" style="width:100%;height:auto;background:#000"/>`);
    }
  };

  // mobile taps
  const tapLeft  = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  const tapRight = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  const tapJump  = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
  const tapSlide = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

  // pause blur
  const pausedBlur: React.CSSProperties | undefined = paused ? { filter: 'blur(4px)' } : undefined;

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
            ...pausedBlur,
          }}
        />

        {/* HUD Top Row */}
        <div style={{ position: 'absolute', top: 8, left: 10, right: 10, display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: 700 }}>
          <span>Score {score}</span>
          <span>Best {best}</span>
          <span>Speed {speedView}</span>
        </div>

        {/* Power-up badges */}
        <div style={{ position: 'absolute', top: 36, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 8 }}>
          <Badge color="#ffda6b" label="Magnet" pct={badgePct.magnet} />
          <Badge color="#00ffd0" label="Boost" pct={badgePct.boost} />
          <Badge color="#8be9fd" label="Shield" pct={badgePct.shield} />
          <Badge color="#ff66d9" label="Double" pct={badgePct.dbl} />
        </div>

        {/* Start / Pause / Settings */}
        <div style={{ position: 'absolute', top: 8, right: 10, display: 'flex', gap: 8 }}>
          {running || paused ? (
            <>
              <button onClick={() => setPaused(p => !p)} style={chip}>{paused ? 'Resume' : 'Pause'}</button>
              <button onClick={() => setShowSettings(true)} style={chip}>Settings</button>
            </>
          ) : (
            <>
              <button onClick={handleStart} style={chip}>Start</button>
              <button onClick={() => setShowSettings(true)} style={chip}>Settings</button>
            </>
          )}
        </div>

        {/* Combo meter */}
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 12 }}>
          <ComboBar mult={comboInfo.mult} pct={comboInfo.pct} />
        </div>

        {/* Idle Play overlay */}
        {!running && !dead && countdown === null && (
          <div style={overlay}><button onClick={handleStart} style={bigPlayBtn}>Play</button></div>
        )}

        {/* Countdown */}
        {countdown !== null && (<div style={overlay}><div style={bubble}>{countdown}</div></div>)}

        {/* Game over */}
        {dead && (
          <div style={overlay}>
            <div style={panel}>
              <h3 style={{ margin: 0 }}>Game over</h3>
              <p style={{ margin: '6px 0 12px 0' }}>Score {score}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button onClick={handleRetry} style={btn}>Retry</button>
                <button onClick={handleSubmit} style={btn}>Submit</button>
                <button onClick={handleShare} style={btn} disabled={!canShare}>Share</button>
              </div>
            </div>
          </div>
        )}

        {/* Pause overlay */}
        {paused && (
          <div style={overlay}>
            <div style={{ ...panel, backdropFilter: 'blur(6px)' as any }}>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Paused</h3>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={() => setPaused(false)} style={btn}>Resume</button>
                <button onClick={() => setShowSettings(true)} style={btn}>Settings</button>
              </div>
              <p style={{ opacity: 0.7, marginTop: 10, fontSize: 12 }}>
                Press <kbd>Esc</kbd> to resume
              </p>
            </div>
          </div>
        )}
      </div>

      {(running || paused) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button onClick={tapLeft} style={btn}>Left</button>
          <button onClick={tapJump} style={btn}>Jump</button>
          <button onClick={tapSlide} style={btn}>Crouch</button>
          <button onClick={tapRight} style={btn}>Right</button>
        </div>
      )}

      {showSettings && (
        <div style={drawerOverlay} onClick={() => setShowSettings(false)}>
          <div style={drawer} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Settings</h3>

            <div style={row}>
              <label>World</label>
              <select value={world} onChange={e => setWorld(e.target.value as WorldTheme)} style={select}>
                <option value="neonCity">Neon City</option>
                <option value="inkVoid">Ink Void</option>
                <option value="frostCavern">Frost Cavern</option>
                <option value="desertDusk">Desert Dusk</option>
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

            <div style={row}>
              <label>Mode</label>
              <select value={mode} onChange={e => setMode(e.target.value as any)} style={select}>
                <option value="endless">Endless</option>
                <option value="boss">Boss Run</option>
                <option value="daily">Daily Run</option>
              </select>
            </div>

            <div style={row}>
              <label>Assist Mode</label>
              <input type="checkbox" checked={assist} onChange={e => setAssist(e.target.checked)} />
            </div>

            <div style={{marginTop:10, fontSize:12, opacity:0.8}}>
              Upgrades — Jump: {upg.jump} • Magnet: {upg.magnet} • Slide: {upg.slide} • Streak: {streak}d
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

/* ------------ Small UI bits ------------ */

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
    <div style={{ display: 'grid', gap: 6, color: '#fff', fontWeight: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span>Combo</span><span>x{mult.toFixed(2)}</span>
      </div>
      <div style={{ width: '100%', height: 10, background: '#222', borderRadius: 8, overflow: 'hidden', border: '1px solid #333' }}>
        <div style={{ width: `${w}%`, height: '100%', background: 'linear-gradient(90deg, #ffe066, #6e59ff)' }} />
      </div>
    </div>
  );
}

/* ------------ Styles ------------ */
const chip: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 10, border: '1px solid #444', background: '#1a1a1a', color: '#fff', fontWeight: 700,
};
const btn: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 10, border: '1px solid #444', background: '#1a1a1a', color: '#fff',
};
const bigPlayBtn: React.CSSProperties = {
  padding: '14px 28px', borderRadius: 16, border: '1px solid #444', background: '#1a1a1a', color: '#fff', fontSize: 20, fontWeight: 800,
};
const overlay: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.35)',
};
const bubble: React.CSSProperties = {
  width: 140, height: 140, display: 'grid', placeItems: 'center', fontSize: 64, borderRadius: 999, background: '#0008', border: '1px solid #333', color: '#fff',
};
const panel: React.CSSProperties = {
  background: '#111', border: '1px solid #222', borderRadius: 16, padding: 16, minWidth: 220, textAlign: 'center',
};
const drawerOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: '#0008', display: 'grid', placeItems: 'end center', zIndex: 40,
};
const drawer: React.CSSProperties = {
  width: 'min(420px, 92vw)', background: '#0f0f10', border: '1px solid #222', borderRadius: 16, padding: 16, margin: 12, color: '#fff',
};
const row: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 10, marginTop: 10,
};
const select: React.CSSProperties = {
  background: '#1a1a1a', border: '1px solid #444', color: '#fff', borderRadius: 8, padding: '6px 8px',
};
