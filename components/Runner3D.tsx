// components/Runner3D.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { Howl, Howler } from 'howler';

// RNG seeded by daily seed / world seed
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function hsl(h: number, s: number, l: number) { return `hsl(${h} ${s}% ${l}%)`; }
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
const JUMP_STRENGTH_BASE = 0.2;
const GRAVITY = 0.01;

// Air obstacle tuning (harder to clear with single jump)
const AIR_OBS_H = 1.2;   // was ~0.9
const AIR_OBS_Y = 1.35;  // was ~1.0–1.05

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

// 🔮 risk / reward
const RISK_MS = 10_000;         // double points + +25% speed for 10s
// camera FX
const BOOST_FOV_DELTA = 6;      // extra FOV during boost
const SHAKE_MAG = 0.06;         // small shake on pickups/hits

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
type PowerKind = 'magnet' | 'boost' | 'shield' | 'double' | 'risk' | 'wings' | 'heart';
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
const startedRef = useRef(false); // ← prevents double start
const flyNextZRef = useRef(-4); // next sky row z; -4 is near the camera

  // game state
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [dead, setDead] = useState(false);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [speedView, setSpeedView] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [showTitle, setShowTitle] = useState(true);

// Audio (init on user gesture only)
const audioReadyRef = useRef(false);
const sfxRef = useRef<{
  jump?: Howl; pickup?: Howl; slide?: Howl; hit?: Howl; boost?: Howl; music?: Howl;
} | null>(null);

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
const [showBoard, setShowBoard] = useState(false);
const [board, setBoard] = useState<{score:number; at:number}[]>([]);

function loadBoard() {
  try {
    const raw = localStorage.getItem('hyper-board');
    const arr = raw ? JSON.parse(raw) as {score:number; at:number}[] : [];
    setBoard(arr.sort((a,b)=>b.score-a.score).slice(0, 20));
  } catch {}
}
function saveScoreLocal(score:number) {
  try {
    const raw = localStorage.getItem('hyper-board');
    const arr = raw ? JSON.parse(raw) as {score:number; at:number}[] : [];
    arr.push({ score, at: Date.now() });
    localStorage.setItem('hyper-board', JSON.stringify(arr));
  } catch {}
}
useEffect(() => { loadBoard(); }, []);

  // Beat clock
  const beatRef = useRef(0);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [quality, setQuality] = useState<number>(2);
const SHOW_SETTINGS = false; // 👈 hide Settings UI in modes

  // idle-preload lightweight audio files so first play is snappy
useEffect(() => {
  const idle = (window as any).requestIdleCallback || ((cb: any) => setTimeout(cb, 400));
  const cancel = (window as any).cancelIdleCallback || clearTimeout;
  const id = idle(() => {
    ['/sounds/jump.mp3','/sounds/pickup.mp3','/sounds/slide.mp3','/sounds/hit.mp3','/sounds/boost.mp3','/sounds/theme.mp3']
      .forEach(src => { const a = new Audio(); a.preload = 'auto'; a.src = src; a.load(); });
  });
  return () => cancel(id);
}, []);

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
const riskUntilRef   = useRef(0); 
const flyUntilRef    = useRef(0);

// flight coin control
const flyRowsLeftRef = useRef(0);       // how many rows we still may spawn this flight
const flySpawnCooldownRef = useRef(0);  // small delay between sky rows
const invincibleUntilRef = useRef(0); // post-hit grace window
const wasFlyingRef = useRef(false);
const [lives, setLives] = useState(3);
const livesRef = useRef(3);
useEffect(() => { livesRef.current = lives; }, [lives]);

  const lastPickupAtRef = useRef(0);
  const comboRef = useRef(0);
  const lastSpeedRef = useRef(0);

// --- Subway Surfers chase-cam helpers ---
const camBobRef     = useRef(0);
const lookTargetRef = useRef(new THREE.Vector3(0, 1.2, -8));
const prevXRef      = useRef(0);

// live flags for handlers/loop (avoid stale closures)
const pausedRef = useRef(false);
const deadRef   = useRef(false);

useEffect(() => { pausedRef.current = paused; }, [paused]);
useEffect(() => { deadRef.current   = dead;   }, [dead]);


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

  function pickRandomWorld(exclude?: WorldTheme): WorldTheme {
  const worlds: WorldTheme[] = ['neonCity', 'inkVoid', 'frostCavern', 'desertDusk'];
  const pool = exclude ? worlds.filter(w => w !== exclude) : worlds;
  return pool[Math.floor(Math.random() * pool.length)];
}

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
}, []); // ← run once, not when running flips

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

// safer pause: only pause when the tab is hidden
useEffect(() => {
  const onVis = () => {
    if (document.hidden) setPaused(true);
  };
  document.addEventListener('visibilitychange', onVis);
  return () => document.removeEventListener('visibilitychange', onVis);
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

  // prevent starting twice
  if (startedRef.current) return;
  startedRef.current = true;

  const W = size.w;
  const H = size.h;
  const mount = mountRef.current;

// Hybrid mode RNG — mix dailySeed with a per-run salt
const runSalt = (Date.now() >>> 0);
const rand = mulberry32((dailySeed ^ 0xB055) ^ runSalt);


  // (keep the rest of your startGame code after this line unchanged…)


  // (keep the rest of your startGame code after this line unchanged…)

    // scene/camera/renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(colors.fog[0], colors.fog[1], colors.fog[2]);

const camera = new THREE.PerspectiveCamera(FIXED_FOV, W / H, 0.1, 500);
// Subway Surfers–style starting pose: slightly higher + behind
camera.position.set(0, 3.2, 7.2);
camera.rotation.set(0, 0, 0);
camera.fov = 62;
camera.updateProjectionMatrix();



    const renderer = new THREE.WebGLRenderer({ antialias: quality >= 2, alpha: true });
renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1), quality, 2));
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = quality >= 2;
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    // --- WebAudio micro fx ---
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    // guard for autoplay policies
// ---- SFX stubs (actual Howl instances are created on first Start click) ----
const playJump   = () => sfxRef.current?.jump?.play();
const playPickup = () => sfxRef.current?.pickup?.play();
const playSlide  = () => sfxRef.current?.slide?.play();
const playHit    = () => sfxRef.current?.hit?.play();
const playBoost  = () => sfxRef.current?.boost?.play();


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
  const c = Math.min(5, comboMult);
  const boosting = speedMult > 1.01;

  // bass / pads follow overall intensity
  const intensity = Math.min(1.6, (boosting ? 1.0 : 0.7) + c * 0.15);
  tracks[0].volume = 0.22 + 0.22 * intensity;          // bass
  tracks[1].volume = 0.18 + 0.14 * intensity;          // pads

  // arps come up from combo 3+
  tracks[2].volume = c >= 3 ? Math.min(0.55, 0.15 + c * 0.08) : 0.0;

  // drums punch on boost
  tracks[3].volume = boosting ? 0.55 : 0.20;
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
    const partGeo = new THREE.BufferGeometry();
    // performance-scaled particle/weather counts
const DPR = Math.min(window.devicePixelRatio || 1, 2); // cap at 2
const QUALITY = quality; // from your state (1=low,2=med,3=high)

// Particles
const MAX_PARTICLES = Math.floor((QUALITY === 1 ? 180 : QUALITY === 2 ? 320 : 400) / DPR);

// Weather
const WEATHER_COUNT = Math.floor((QUALITY === 1 ? 220 : QUALITY === 2 ? 360 : 500) / DPR);
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
        // --- Hybrid boss-burst scheduler ---
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

const comboBoost = comboRef.current >= 2 ? 1.2 : 1.0; // longer crouch window on combo
const slideDur = SLIDE_DURATION_MS * (1 + upg.slide * 0.06) * comboBoost;
      if (elapsed >= slideDur) {
        sliding = false;
        slideEndedAt = performance.now();
      }
    };

    // content: obstacles/orbs/powers/crystals
    const obstacles: Obs[] = [];
const obsGroundGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
const obsGroundMat = new THREE.MeshStandardMaterial({ color: colors.obstacleGround, roughness: 0.6 });
const obsAirGeo = new THREE.BoxGeometry(0.9, AIR_OBS_H, 0.9); // ↑ taller
const obsAirMat = new THREE.MeshStandardMaterial({ color: colors.obstacleAir, roughness: 0.5 });

// mix of shapes
const groundShapes = [
  obsGroundGeo,
  new THREE.ConeGeometry(0.55, 1.0, 6),
  new THREE.CylinderGeometry(0.45, 0.45, 0.9, 10),
];
const airShapes = [
  obsAirGeo,
  new THREE.CylinderGeometry(0.45, 0.45, AIR_OBS_H, 10),
  new THREE.OctahedronGeometry(0.62, 0),
];

// --- Air obstacle visual aids (outline + ground marker + pole) ---
const airOutlineMat = new THREE.LineBasicMaterial({
  color: 0xfff07a,
  transparent: true,
  opacity: 0.9
});
const airMarkerGeo = new THREE.CircleGeometry(0.62, 48);
const airMarkerMat = new THREE.MeshBasicMaterial({
  color: 0xffd166,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});
const airPoleMat = new THREE.MeshBasicMaterial({
  color: 0xffe9a3,
  transparent: true,
  opacity: 0.55,
});

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

function spawnObstacleWithType(zPos: number, forcingLaneIdx: number, type: ObstacleType) {
  const laneX = [-1.2, 0, 1.2][forcingLaneIdx];
  const isAir = type === 'air';
  const geo = isAir ? obsAirGeo : obsGroundGeo;
  const mat = isAir ? obsAirMat : obsGroundMat;

  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.position.set(laneX, isAir ? AIR_OBS_Y : 0.55, zPos);
  scene.add(m);

  // Attach special visuals for AIR obstacles
  if (isAir) {
    // 1) glowing outline
    const edges = new THREE.EdgesGeometry(geo);
    const outline = new THREE.LineSegments(edges, airOutlineMat);
    outline.userData = { pulse: (Math.random() * Math.PI * 2) };
    m.add(outline);

    // 2) ground marker disk (independent mesh at Y≈ground)
    const marker = new THREE.Mesh(airMarkerGeo, airMarkerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(laneX, 0.02, zPos);
    scene.add(marker);

    // 3) slim pole from ground → bottom of obstacle
    const poleHeight = Math.max(0.2, m.position.y - 0.05);
    const poleGeo = new THREE.CylinderGeometry(0.02, 0.02, poleHeight, 8);
    const pole = new THREE.Mesh(poleGeo, airPoleMat);
    pole.position.set(laneX, poleHeight / 2, zPos);
    scene.add(pole);

    // keep references for updates/removal
    (m.userData as any).outline = outline;
    (m.userData as any).marker = marker;
    (m.userData as any).pole = pole;
  }

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
const pool = isAir ? airShapes : groundShapes;
const geo = pool[Math.floor(rand() * pool.length)];
  const mat = isAir ? obsAirMat : obsGroundMat;

  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.position.set(laneX, isAir ? AIR_OBS_Y : 0.55, zPos);
  scene.add(m);

  // --- add the same helper visuals for AIR obstacles ---
  if (isAir) {
    // 1) glowing outline
    const edges = new THREE.EdgesGeometry(geo);
    const outline = new THREE.LineSegments(edges, airOutlineMat);
    outline.userData = { pulse: (Math.random() * Math.PI * 2) };
    m.add(outline);

    // 2) ground marker disk
    const marker = new THREE.Mesh(airMarkerGeo, airMarkerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(laneX, 0.02, zPos);
    scene.add(marker);

    // 3) slim pole from ground to obstacle
    const poleHeight = Math.max(0.2, m.position.y - 0.05);
    const poleGeo = new THREE.CylinderGeometry(0.02, 0.02, poleHeight, 8);
    const pole = new THREE.Mesh(poleGeo, airPoleMat);
    pole.position.set(laneX, poleHeight / 2, zPos);
    scene.add(pole);

    // store refs so our existing update/cleanup code works
    (m.userData as any).outline = outline;
    (m.userData as any).marker = marker;
    (m.userData as any).pole   = pole;
  }

  // optional movement/rotation
  (m.userData as any).move = rand() < 0.25;
  (m.userData as any).rot  = rand() < 0.20;
  (m.userData as any).amp  = 0.35 + rand()*0.35;
  (m.userData as any).spd  = 0.6 + rand()*0.8;

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

function spawnSkyRow(zPos: number) {
  const ySky = 2.5;
  const lanes = [-1.2, 0, 1.2];

  // choose 1 or 2 random lanes (never all 3)
  const shuffled = lanes.sort(() => Math.random() - 0.5);
  const count = Math.random() < 0.55 ? 1 : 2; // 55% one coin, 45% two coins

  for (let i = 0; i < count; i++) {
    const x = shuffled[i];
    const m = new THREE.Mesh(orbGeo, orbMat);
    m.position.set(x, ySky, zPos);
    scene.add(m);
    const sphere = new THREE.Sphere(m.position, 0.22);
    orbs.push({ mesh: m, aabb: sphere, active: true, z: zPos });
  }
}


// Start a 3s flight and pre-spawn rows right by the camera
// Start a 5s flight; sky coins begin 1.5s after liftoff
function startFlight(now: number) {
  flyUntilRef.current = now + 5000;       // 5 seconds
  flyRowsLeftRef.current = 14;            // limit rows per flight
  flySpawnCooldownRef.current = now + 1500; // first sky row 1.5s after liftoff

  flyNextZRef.current = -4;               // spawn first row right near the camera
}



    const powers: Power[] = [];
// ---- Power geo + materials (must be before spawnPower) ----
const ico = new THREE.IcosahedronGeometry(0.26, 0);

const matMagnet = new THREE.MeshStandardMaterial({
  color: colors.magnet, emissive: 0xffb400, emissiveIntensity: 0.7, roughness: 0.3
});
const matBoost = new THREE.MeshStandardMaterial({
  color: colors.boost, emissive: 0x00bfa5, emissiveIntensity: 0.8, roughness: 0.3
});
const matShield = new THREE.MeshStandardMaterial({
  color: colors.shield, emissive: 0x67d4ff, emissiveIntensity: 0.8, roughness: 0.3
});
const matDouble = new THREE.MeshStandardMaterial({
  color: 0xff66d9, emissive: 0xff66d9, emissiveIntensity: 0.8, roughness: 0.3
});
const matRisk = new THREE.MeshStandardMaterial({
  color: 0x9b59ff, emissive: 0x9b59ff, emissiveIntensity: 0.9, roughness: 0.25
});
const matWings = new THREE.MeshStandardMaterial({
  color: 0xfff7a9, emissive: 0xfff7a9, emissiveIntensity: 0.9, roughness: 0.25
});
const matHeart = new THREE.MeshStandardMaterial({
  color: 0xff4d6d, emissive: 0xff4d6d, emissiveIntensity: 0.9, roughness: 0.25
});

// ---- Spawner (uses the materials above) ----
function spawnPower(zPos: number) {
  const laneX = lanes[Math.floor(rand() * lanes.length)];
  const r = rand();

// TEMP: force wings to test
const FORCE_WINGS = true; // ← set to false when done testing

  // 8% risk, 6% wings, 3% heart, rest distributed across the classics
  const kind: PowerKind = FORCE_WINGS ? 'wings' :
    r < 0.26 ? 'magnet' :
    r < 0.52 ? 'boost'  :
    r < 0.74 ? 'shield' :
    r < 0.89 ? 'double' :
    r < 0.82 ? 'wings'  :
    r < 0.98 ? 'heart'  : 'risk';

  const mat =
    kind === 'magnet' ? matMagnet :
    kind === 'boost'  ? matBoost  :
    kind === 'shield' ? matShield :
    kind === 'double' ? matDouble :
    kind === 'wings'  ? matWings  :
    kind === 'heart'  ? matHeart  : matRisk;

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

// preload some random obstacles at start
for (let i = 1; i <= 10; i++) spawnObstacle(-i * 12);

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
if (deadRef.current || pausedRef.current) return;
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
  if (deadRef.current || pausedRef.current) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  if (x < -0.33) laneIndex = 0;
  else if (x > 0.33) laneIndex = 2;
  else laneIndex = 1;
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

  let nextBossAtScore = 250; // first burst at 250 pts, then +350…

  const spawnBossBurst = (zStart: number) => {
    // a quick alternating lane wave
    let z = zStart;
    for (let i = 0; i < 28; i++) {
      const type: ObstacleType = i % 2 === 0 ? 'air' : 'ground';
      const lane = i % 3;
      spawnObstacleWithType(z, lane, type);
      z -= 6;
    }
  };

    const animate = () => {
  try {
    // --- timing & fps smoothing ---
    if (fpsSmoothed < 45 && quality > 1) setQuality(q => Math.max(1, q - 1));

if (pausedRef.current) {
  rafRef.current = requestAnimationFrame(animate);
  renderer.render(scene, camera);
  return;
}


    const now = performance.now();
    const dt = Math.max(1, now - lastFrameTime);
    const instantFPS = 1000 / dt;
    fpsSmoothed = fpsSmoothed * 0.9 + instantFPS * 0.1;
    lastFrameTime = now;
const inSky = now < flyUntilRef.current;
if (inSky) {
  wasFlyingRef.current = true;
} else if (wasFlyingRef.current) {
  // just landed — cancel any pending sky rows
flyRowsLeftRef.current = 0;
flySpawnCooldownRef.current = 0;
wasFlyingRef.current = false;
  // optional: remove any sky coins that are still around
  for (const orb of orbs) {
    if (orb.active && orb.mesh.position.y > 1.5) {
      orb.active = false;
      scene.remove(orb.mesh);
    }
  }
}

    if (fpsSmoothed < TARGET_FPS - 8) {
      renderer.shadowMap.enabled = false;
      (weatherMat as THREE.PointsMaterial).opacity *= 0.98;
      (partMat as THREE.PointsMaterial).opacity *= 0.99;
      (slMat as THREE.LineBasicMaterial).opacity *= 0.98;
    }

    t += 1;

    // --- speeds & intensity ---
    const speedMult = now < boostUntilRef.current ? BOOST_MULT : 1;
    const extra = 0.00004 * diffFactor();
    const slowmo = now < timeWarpUntilRef.current ? 0.45 : 1;
const riskSpeedMult = now < riskUntilRef.current ? 1.25 : 1.0;
const scrollSpeedBase = (baseSpeed + (t * (accel + extra))) * speedMult * riskSpeedMult;
    const scrollSpeed = scrollSpeedBase * slowmo * (assist ? 0.92 : 1);
    // --- Subway Surfers style chase camera ---

// Tunables
const baseY = 3.2;           // base camera height
const baseZ = 7.2;           // distance behind player
const xFollow = 0.60;        // how much cam X follows player X
const lagPos = 0.12;         // damping for X
const lagY   = 0.10;         // damping for Y
const lagZ   = 0.08;         // damping for Z
const lookAheadZ = -8.0;     // look target depth (ahead on track)
const lookAheadX = 0.75;     // look target follows player X
const bobAmp = 0.05;         // vertical bob amplitude
const bankScale = 1.6;       // roll intensity on lane change
const bankClamp = 0.20;      // max roll (radians)

// subtle bob
camBobRef.current += Math.max(0.001, dt / 1000) * 6; // ~6 Hz
const bob = Math.sin(camBobRef.current * Math.PI * 2) * bobAmp;

// desired pose
const desiredX = player.position.x * xFollow;
const desiredY = baseY + bob + Math.min(0.7, scrollSpeed * 0.9);
const desiredZ = baseZ;

// damped move
camera.position.x += (desiredX - camera.position.x) * lagPos;
camera.position.y += (desiredY - camera.position.y) * lagY;
camera.position.z += (desiredZ - camera.position.z) * lagZ;

// look ahead down the lane
lookTargetRef.current.set(player.position.x * lookAheadX, 1.2, lookAheadZ);
camera.lookAt(lookTargetRef.current);

// bank (roll) from lateral velocity
const vx = player.position.x - prevXRef.current;
prevXRef.current = player.position.x;
const targetBank = THREE.MathUtils.clamp(-vx * bankScale, -bankClamp, bankClamp);
camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, targetBank, 0.12);

// mild pitch, mostly stable
const targetPitch = -0.26 - Math.min(0.06, scrollSpeed * 0.10);
camera.rotation.x = THREE.MathUtils.lerp(camera.rotation.x, targetPitch, 0.08);

// boost FOV effect (keep your BOOST_FOV_DELTA)
const baseFov = 62;
const targetFovCam = baseFov + (now < boostUntilRef.current ? BOOST_FOV_DELTA : 0);
camera.fov += (targetFovCam - camera.fov) * 0.06;
camera.updateProjectionMatrix();
    lastSpeedRef.current = scrollSpeed;
// --- background sky transition based on speed & combo ---
if (mountRef.current) {
  // base hues per world
  const baseHue =
    world === 'neonCity'   ? 210 :
    world === 'inkVoid'    ? 260 :
    world === 'frostCavern'? 210 :
    /* desertDusk */         28;

  // intensity pulls hue toward “hot” as you go faster / combo up
  const comboHot = Math.min(1, comboRef.current / 5);
  const speedHot = Math.min(1, scrollSpeed / 1.4);
  const hotT = Math.max(comboHot * 0.6, speedHot * 0.8);

  const topHue = lerp(baseHue, 320, hotT); // blend toward magenta at high intensity
  const botHue = lerp(baseHue - 20, 12,  hotT); // warm lower horizon
  const top = hsl(topHue, 65, 12 + hotT * 6);
  const bot = hsl(botHue, 80,  4  + hotT * 8);

  (mountRef.current as HTMLDivElement).style.background =
    `linear-gradient(180deg, ${top} 0%, ${bot} 100%)`;
}

    // ⭐ combo perks
if (!inSky && comboRef.current >= 3) {
  magnetUntilRef.current = Math.max(magnetUntilRef.current, now + 180);
}
if (comboRef.current >= 4) {
  // tiny time warp pulses when near obstacles
  timeWarpUntilRef.current = Math.max(timeWarpUntilRef.current, now + 120);
}


// FOV zoom while boosting
const targetFov = FIXED_FOV + (now < boostUntilRef.current ? BOOST_FOV_DELTA : 0);
camera.fov += (targetFov - camera.fov) * 0.08;
camera.updateProjectionMatrix();

// micro camera shake on pickup/hit (decays automatically)
if (lastPickupAtRef.current > now - 140) {
  camera.position.x += (Math.random() - 0.5) * SHAKE_MAG;
  camera.position.y += (Math.random() - 0.5) * SHAKE_MAG * 0.5;
}

    updateMusic(speedMult, comboRef.current);
    if (t % Math.max(300, 600 - Math.floor(300 * diffFactor())) === 0) baseSpeed += 0.05;
    if (t % 6 === 0) setSpeedView(Number(scrollSpeed.toFixed(2)));

    // occasional lightning flash (not in inkVoid)
    if (Math.random() < 0.002 && colors.weather !== 'snow' && world !== 'inkVoid') {
      const flash = 0.25 + Math.random()*0.35;
      (renderer.domElement.style as any).filter = `brightness(${1+flash})`;
      setTimeout(() => { (renderer.domElement.style as any).filter = ''; }, 120);
    }

    // --- particles (dust) ---
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

    // --- speed lines during boost ---
    (slMat as THREE.LineBasicMaterial).opacity = speedMult > 1 ? 0.38 : 0.0;
    if (speedMult > 1) {
      const attr = slGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < SPEEDLINE_COUNT; i++) {
        const idx = i * 6;
        slPos[idx+2] += scrollSpeed * 1.8;
        slPos[idx+5] += scrollSpeed * 1.8;
        if (slPos[idx+2] > 4) {
          const x = -1.6 + Math.random()*3.2;
          const y = 0.4 + Math.random()*1.6;
          const z = -2 - Math.random()*18;
          slPos[idx+0]=x; slPos[idx+1]=y; slPos[idx+2]=z;
          slPos[idx+3]=x; slPos[idx+4]=y; slPos[idx+5]=z-0.7;
        }
      }
      attr.needsUpdate = true;
    }

    // --- weather drift ---
    const wAttr = weatherGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < WEATHER_COUNT; i++) {
      wPos[i*3+1] += wVel[i*3+1];
      wPos[i*3+2] += wVel[i*3+2] + scrollSpeed * 0.4;
      if (wPos[i*3+1] < 0.2 || wPos[i*3+2] > 6) {
        wPos[i*3+0] = -2.2 + Math.random()*4.4;
        wPos[i*3+1] = 2 + Math.random()*3.5;
        wPos[i*3+2] = -20 - Math.random()*40;
      }
    }
    wAttr.needsUpdate = true;
// fade weather stronger over time
const weatherTarget = 0.4 + 0.4 * diffFactor();
(weatherMat as THREE.PointsMaterial).opacity += (weatherTarget - (weatherMat as any).opacity) * 0.02;

    // --- lane tweening ---
    const lanesArr = [-1.2, 0, 1.2];
    const targetX = lanesArr[laneIndex];
    const dx = targetX - player.position.x;
    const dtSec = Math.max(0.001, dt / 1000);
    const maxSpeed = 6.0;
    const maxStep = maxSpeed * dtSec;
    const step = Math.sign(dx) * Math.min(Math.abs(dx), maxStep);
    player.position.x += step;
    if (Math.abs(targetX - player.position.x) < maxStep) player.position.x = targetX;

 // --- jump / gravity / slide ---
const grounded = y <= PLAYER_GROUND_Y + 0.0001;

if (inSky) {
  // lock to sky lane
  sliding = false;
  vy = 0;
  const targetY = 2.5;
  y += (targetY - y) * 0.18;
} else {
  if (grounded && !wasGrounded) {
    jumpsSinceAir = 0;
    lastGroundedAt = now;
    if (now <= jumpBufferUntil) {
      const speedScale = 1 + Math.min(0.3, scrollSpeed * 0.02);
      const jumpUp = 1 + upg.jump * 0.05;
      vy = JUMP_STRENGTH_BASE * speedScale * jumpUp;
      (sfxRef.current?.jump)?.play?.();
      jumpBufferUntil = 0;
    }
  }

  if (grounded && jumpBufferUntil) {
    const speedScale = 1 + Math.min(0.3, scrollSpeed * 0.02);
    const jumpUp = 1 + upg.jump * 0.05;
    vy = JUMP_STRENGTH_BASE * speedScale * jumpUp;
    (sfxRef.current?.jump)?.play?.();
    jumpBufferUntil = 0;
  }

  if (!sliding) { vy -= GRAVITY; y += vy; if (y < PLAYER_GROUND_Y) { y = PLAYER_GROUND_Y; vy = 0; } }
  else { y = PLAYER_GROUND_Y; vy = 0; }
  updateSlide();
}

player.position.y = y;
if (!inSky && grounded) lastGroundedAt = now;
wasGrounded = grounded || inSky;


    // --- glow trail ---
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

    // --- ground scroll ---
    ground.position.z += scrollSpeed;
    (groundMat.map as THREE.CanvasTexture).offset.y += scrollSpeed * 0.06;
    if (ground.position.z > -120) ground.position.z = -160;

    // --- obstacles ---
    for (const o of obstacles) {
      if (!o.active) continue;

      // move forward
      o.mesh.position.z += scrollSpeed;

      const ud: any = o.mesh.userData || {};
      if (ud.move) {
        o.mesh.position.x += Math.sin((t * 0.03) + (beatRef.current * 0.6)) * 0.006 * (ud.spd || 1);
        o.mesh.position.x = THREE.MathUtils.clamp(o.mesh.position.x, -1.8, 1.8);
      }
      if (ud.rot) o.mesh.rotation.y += 0.01 * (ud.spd || 1);

      // pulse outline + keep marker/pole aligned for air blocks
      if (o.type === 'air') {
        const outline = ud.outline as THREE.LineSegments | undefined;
        if (outline) {
          const pulse = (outline.userData?.pulse || 0) + 0.08;
          outline.userData.pulse = pulse;
          (outline.material as THREE.LineBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(pulse);
        }
        const marker = ud.marker as THREE.Mesh | undefined;
        if (marker) { marker.position.z = o.mesh.position.z; marker.position.x = o.mesh.position.x; }
        const pole = ud.pole as THREE.Mesh | undefined;
        if (pole)   { pole.position.z   = o.mesh.position.z; pole.position.x   = o.mesh.position.x; }
      }

      o.aabb.setFromObject(o.mesh);
      if (o.mesh.position.z > 6) {
        o.active = false;
        if (o.type === 'air') {
          const ud2: any = o.mesh.userData || {};
          if (ud2.marker) scene.remove(ud2.marker);
          if (ud2.pole)   scene.remove(ud2.pole);
        }
        scene.remove(o.mesh);
      }
    }

    // spawn more obstacles
    if (obstacles.filter(o => o.active).length < 10) {
      const lastZ = obstacles.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
      const nextBase = Math.min(lastZ, -20);
      if (Math.random() < 0.6 + 0.2 * diffFactor()) {
        lastPatternEndZ = applyPattern(nextBase - 9 - Math.random() * (8 - 4 * diffFactor()));
      } else {
        spawnObstacle(nextBase - 10 - Math.random() * (9 - 4 * diffFactor()));
      }
    }

// --- orbs (move + magnet + pickup) ---
for (const orb of orbs) {
  if (!orb.active) continue;

  // movement/rotation
  orb.mesh.position.z += scrollSpeed;
  orb.mesh.rotation.y += 0.05;

  // soft magnet
if (!inSky && now < magnetUntilRef.current) {
    const dMag = orb.mesh.position.distanceTo(player.position);
    const magnetRadius = MAGNET_RADIUS * (1 + upg.magnet * 0.06);
    if (dMag < magnetRadius) {
      tmpVec.copy(player.position).sub(orb.mesh.position).multiplyScalar(MAGNET_PULL);
      orb.mesh.position.add(tmpVec);
    }
  }

  // pickup collision
const d = player.position.distanceTo(orb.mesh.position);
const eatR = 0.45;
if (d < eatR) {
    orb.active = false;
    scene.remove(orb.mesh);

    // fx + sfx
    burst(orb.mesh.position.clone(), 12, 0.06, 420);
    (sfxRef.current?.pickup)?.play?.();
    lastPickupAtRef.current = now;

    // combo
    comboRef.current = Math.min(COMBO_MAX, comboRef.current + 1);

    // scoring (risk + combo multipliers)
    const riskMult = now < riskUntilRef.current ? 2 : 1;
    const comboMult = 1 + Math.min(COMBO_MAX, comboRef.current) * 0.2;
    const add = Math.round(10 * comboMult * riskMult);
    localScore += add;

    continue; // done with this orb
  }

  // maintain aabb & cleanup
  orb.aabb.center.copy(orb.mesh.position);
  if (orb.mesh.position.z > 6) { orb.active = false; scene.remove(orb.mesh); }
}

// keep about ~12 orbs in play
if (orbs.filter(o => o.active).length < 12) {
  const lastZ = orbs.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
  spawnOrb(Math.min(lastZ, -10) - 9 - Math.random() * 6);
}

// Extra gold rows in the sky while flying (near-camera, capped, paced)
if (inSky) {
  if (now >= flyUntilRef.current) {
    flyRowsLeftRef.current = 0;
  } else if (flyRowsLeftRef.current > 0 && now >= flySpawnCooldownRef.current) {
    // spawn at the cursor near the camera, then march forward
    const nextZ = flyNextZRef.current;
    spawnSkyRow(nextZ);
    flyNextZRef.current -= 3.6;            // spacing between rows
    flyRowsLeftRef.current--;
    flySpawnCooldownRef.current = now + 150; // pace: ~6-7 rows/sec
  }
}


    // --- powers ---
    for (const pwr of powers) {
      if (!pwr.active) continue;
      pwr.mesh.position.z += scrollSpeed; pwr.mesh.rotation.y += 0.04;
      pwr.aabb.center.copy(pwr.mesh.position);
      if (pwr.mesh.position.z > 6) { pwr.active = false; scene.remove(pwr.mesh); }
    }
    if (powers.filter(p => p.active).length < 4 && Math.random() < 0.02) {
      const lastZ = powers.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), 0);
      spawnPower(Math.min(lastZ, -25) - 20 - Math.random() * 20);
      
    }

    // --- crystals ---
    for (const c of crystals) {
      if (!c.active) continue;
      c.mesh.position.z += scrollSpeed;
      c.mesh.rotation.y += 0.02;
      if (player.position.distanceTo(c.mesh.position) < 0.46) {
        c.active = false; scene.remove(c.mesh);
        setUpg(u => ({ ...u, jump: Math.min(5, u.jump + 1) }));
        burst(c.mesh.position.clone(), 16, 0.06, 500);
      }
      if (c.mesh.position.z > 6) { c.active = false; scene.remove(c.mesh); }
    }

    // --- near-miss slow-mo ---
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

    // --- collisions ---
    const pHeight = PLAYER_RADIUS * 2 * player.scale.y;
    const isSlidingNow = sliding;
    const widthFactor  = isSlidingNow ? 0.78 : 0.88;
    const heightFactor = isSlidingNow ? 0.75 : 0.98;
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

    for (const o of obstacles) {
      if (!o.active) continue;
if (expandedAABB.intersectsBox(o.aabb)) {
  // skip collisions while flying or invincible
  if (inSky || now < invincibleUntilRef.current) continue;

  if (now < shieldUntilRef.current) {
    o.active = false; scene.remove(o.mesh);
    camera.position.x += (Math.random() - 0.5) * 0.1;
    camera.position.y += (Math.random() - 0.5) * 0.1;
    burst(o.mesh.position.clone(), 22, 0.05, 450);
    (sfxRef.current?.hit)?.play?.();
    shieldUntilRef.current = now + 400;
  } else {
const nextLives = Math.max(0, livesRef.current - 1);
setLives(nextLives);
livesRef.current = nextLives;

invincibleUntilRef.current = now + 1000; // 1s immunity
burst(player.position.clone(), 28, 0.07, 650);
(sfxRef.current?.hit)?.play?.();

if (nextLives <= 0) { localDead = true; break; }

// tiny slow-mo nudge & camera shake ...
timeWarpUntilRef.current = Math.max(timeWarpUntilRef.current, now + 220);
camera.position.x += (Math.random() - 0.5) * 0.2;
camera.position.y += (Math.random() - 0.5) * 0.2;

// only die if no lives left
if (nextLives <= 0) {
  localDead = true;
  break;
}

  }
}
    }

    // --- power touches ---
    for (const pwr of powers) {
      if (!pwr.active) continue;
      if (player.position.distanceTo(pwr.mesh.position) < 0.5) {
        pwr.active = false; scene.remove(pwr.mesh);
if (pwr.kind === 'magnet') magnetUntilRef.current = now + MAGNET_MS;
if (pwr.kind === 'boost')  { boostUntilRef.current = now + BOOST_MS; playBoost(); }
if (pwr.kind === 'shield') shieldUntilRef.current = now + SHIELD_MS;
if (pwr.kind === 'double') doubleUntilRef.current = now + DOUBLE_MS;
if (pwr.kind === 'risk')   riskUntilRef.current   = now + RISK_MS;
if (pwr.kind === 'wings')  { startFlight(now); }
if (pwr.kind === 'heart')  { setLives(v => Math.min(3, v + 1)); }

      }
    }
shieldMesh.visible = (now < shieldUntilRef.current) || (now < invincibleUntilRef.current);
    shieldMesh.rotation.z += 0.08;

    // --- HUD & score ---
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

// Boss bursts at score milestones
if (localScore >= nextBossAtScore) {
  // start just ahead of the furthest obstacle
  const farZ = obstacles.reduce((min, o) => (o.active ? Math.min(min, o.mesh.position.z) : min), -10);
  spawnBossBurst(Math.min(farZ, -20) - 16);
  nextBossAtScore += 350;
}

    // --- draw ---
    renderer.render(scene, camera);

    if (!localDead) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
stopMusic();
setDead(true); setRunning(false);
setBest(b => Math.max(b, localScore));
setScore(localScore);
saveScoreLocal(localScore);
loadBoard();
    }
  } catch (err) {
    console.error('Frame error:', err);
    setPaused(true);
    rafRef.current = requestAnimationFrame(animate);
  }
};


    rafRef.current = requestAnimationFrame(animate);

cleanupRef.current = () => {
  startedRef.current = false; // allow next start

  stopMusic();
  if (rafRef.current) cancelAnimationFrame(rafRef.current);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('pointerdown', onPointer);
  renderer.domElement.removeEventListener('touchstart', onTouchStart as any);
  renderer.domElement.removeEventListener('touchmove', onTouchMove as any);
  renderer.dispose();
  mount.innerHTML = '';
};

  }, [size, quality, colors, world, dailySeed, assist, upg.jump, upg.magnet, upg.slide]);

useEffect(() => {
  if (!running) return;
  startGame();
  return () => { if (cleanupRef.current) cleanupRef.current(); };
}, [running]); // ← removed startGame from deps


const handleStart = async () => {
  setShowTitle(false);
  // make sure the WebAudio context is unlocked on the user click
  try { await (Howler as any).ctx?.resume?.(); } catch {}
  if (!audioReadyRef.current) {
    Howler.mute(false);
    Howler.volume(1.0);

    // helper to build sfx with preload + html5 fallback + error logs
    const makeSfx = (file: string, vol = 0.4) => {
      let h!: Howl;
      h = new Howl({
        src: [`/sounds/${file}`],   // put files in /public/sounds/
        volume: vol,
        preload: true,
        html5: true,                 // more forgiving on mobile
        onloaderror: (_id, err) => console.warn('SFX load error:', file, err),
        onplayerror: (_id, err) => {
          console.warn('SFX play error (retry on unlock):', file, err);
          h.once('unlock', () => h.play());
        },
      });
      return h;
    };

    sfxRef.current = {
      jump:   makeSfx('jump.mp3',   0.45),
      pickup: makeSfx('pickup.mp3', 0.35),
      slide:  makeSfx('slide.mp3',  0.30),
      hit:    makeSfx('hit.mp3',    0.45),
      boost:  makeSfx('boost.mp3',  0.35),
      music:  new Howl({
        src: ['/sounds/theme.mp3'],
        loop: true,
        volume: 0.45,
        preload: true,
        html5: true,
        onloaderror: (_id, err) => console.warn('Music load error:', err),
      }),
    };

    setLives(3);
    livesRef.current = 3;
invincibleUntilRef.current = 0;
flyUntilRef.current = 0;

    // quick sanity check so you hear *something* immediately
    sfxRef.current.jump?.play();

    sfxRef.current.music?.play();
    audioReadyRef.current = true;
  }

  setWorld(prev => pickRandomWorld(prev)); // new world each run

  // reset & start countdown
  setDead(false); setScore(0);
  setRunning(false); setPaused(false);
  setCountdown(null);
  setTimeout(() => setCountdown(countdownSeconds), 0);
};

const handleRetry = () => {
  // pick a new world for the next run
  setWorld(prev => pickRandomWorld(prev));

  setDead(false);
  setScore(0);
  setRunning(false);
  setPaused(false);
  setCountdown(null);

  // fresh run state
  setLives(3);
  livesRef.current = 3;

  invincibleUntilRef.current = 0;
  flyUntilRef.current = 0;

  magnetUntilRef.current = 0;
  boostUntilRef.current  = 0;
  shieldUntilRef.current = 0;
  doubleUntilRef.current = 0;
  riskUntilRef.current   = 0;

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
  <span>Lives {'❤'.repeat(lives)}{Array.from({length: Math.max(0, 3 - lives)}).map((_,i)=>'♡')}</span>
</div>

<div style={{ position: 'absolute', top: 24, left: 10, fontSize: 12, opacity: 0.8 }}>
  <span style={{ display: 'inline-block', marginRight: 10 }}>
    ▢ with glow = Air obstacle
  </span>
  <span>● on ground = Air marker</span>
</div>

        {/* Power-up badges */}
        <div style={{ position: 'absolute', top: 36, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 8 }}>
          <Badge color="#ffda6b" label="Magnet" pct={badgePct.magnet} />
          <Badge color="#00ffd0" label="Boost" pct={badgePct.boost} />
          <Badge color="#8be9fd" label="Shield" pct={badgePct.shield} />
          <Badge color="#ff66d9" label="Double" pct={badgePct.dbl} />
        </div>

{/* Start / Pause / (no Settings in modes) */}
<div style={{ position: 'absolute', top: 8, right: 10, display: 'flex', gap: 8 }}>
  {running || paused ? (
    <>
      <button onClick={() => setPaused(p => !p)} style={chip}>{paused ? 'Resume' : 'Pause'}</button>
      <button onClick={() => { setShowBoard(true); }} style={chip}>Leaderboard</button>
    </>
  ) : (
    <>
      <button onClick={handleStart} style={chip}>Start</button>
      <button onClick={() => { setShowBoard(true); }} style={chip}>Leaderboard</button>
    </>
  )}
</div>

        {/* Combo meter */}
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 12 }}>
          <ComboBar mult={comboInfo.mult} pct={comboInfo.pct} />
        </div>

{/* Title / Start Screen */}
{showTitle && !running && !dead && countdown === null && (
  <StartScreen onStart={handleStart} />
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
  <button onClick={handleRetry} style={btn}>Replay</button>
  <button onClick={handleSubmit} style={btn}>Submit</button>
  <button onClick={() => setShowBoard(true)} style={btn}>Leaderboard</button>
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

{SHOW_SETTINGS && showSettings && (
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
              <label>Assist Mode</label>
              <input type="checkbox" checked={assist} onChange={e => setAssist(e.target.checked)} />
            </div>

            <div style={{marginTop:10, fontSize:12, opacity:0.8}}>
              Upgrades — Jump: {upg.jump} • Magnet: {upg.magnet} • Slide: {upg.slide} • Streak: {streak}d
            </div>

<div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
  <button
    onClick={() => { setShowSettings(false); if (running) setPaused(false); }}
    style={btn}
  >
    Close
  </button>
  {!running && !dead && <button onClick={handleStart} style={btn}>Start</button>}
</div>

          </div>
        </div>
      )}
      {showBoard && (
  <div style={drawerOverlay} onClick={() => setShowBoard(false)}>
    <div style={drawer} onClick={e => e.stopPropagation()}>
      <h3 style={{ marginTop: 0 }}>Leaderboard (Local)</h3>
      <div style={{ maxHeight: 260, overflow: 'auto', paddingRight: 6 }}>
        {board.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No scores yet — play a run!</div>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {board.map((r, i) => (
              <li key={i} style={{ margin: '6px 0', display: 'flex', justifyContent: 'space-between' }}>
                <span>Score {r.score}</span>
                <span style={{ opacity: 0.7, fontSize: 12 }}>
                  {new Date(r.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={() => setShowBoard(false)} style={btn}>Close</button>
        <button onClick={() => { localStorage.removeItem('hyper-board'); loadBoard(); }} style={btn}>Clear</button>
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

function StartScreen({ onStart }: { onStart: () => void }) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'grid',
      placeItems: 'center',
      background: 'linear-gradient(180deg, #0b0b12 0%, #0a0a0a 100%)'
    }}>
      <div style={{
        textAlign: 'center',
        padding: 20,
        borderRadius: 16,
        border: '1px solid #222',
        background: '#0f0f12aa',
        color: '#fff',
        minWidth: 260
      }}>
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 1, marginBottom: 6 }}>
          HYPER RUN
        </div>
        <div style={{ opacity: 0.8, marginBottom: 16 }}>
          Dodge • Jump • Slide — chain combos for speed
        </div>
        <button onClick={onStart} style={{
          padding: '14px 28px',
          borderRadius: 16,
          border: '1px solid #444',
          background: '#1a1a1a',
          color: '#fff',
          fontSize: 20,
          fontWeight: 800
        }}>
          Tap / Click to Start
        </button>
        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
          Press ←/→ to switch lanes • Space to jump • ↓ to slide
        </div>
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
