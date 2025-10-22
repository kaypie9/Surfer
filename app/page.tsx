'use client';

import { useEffect, useRef, useState } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';
import ConnectWallet from '@/components/ConnectWallet';

import { useAccount, useSendTransaction } from 'wagmi';
import { base } from 'wagmi/chains';

/* ----------------- utils ----------------- */
const ri = (a: number, b: number) => Math.floor(Math.random() * (b - a + 1)) + a;
const rf = (a: number, b: number) => Math.random() * (b - a) + a;

type LeaderRow = { username: string; score: number };

/* ----------------- page ----------------- */
export default function Page() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // UI
  const [scoreText, setScoreText] = useState('0');
  const [hint, setHint] = useState('Tap Play, then Space or tap to flap');
  const [leader, setLeader] = useState<LeaderRow[]>([]);
  const [viewer, setViewer] = useState<{ username: string; fid?: number }>({ username: 'guest' });

  // Wallet
  const { address, isConnected } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();

  // Game state
  const state = useRef<'start' | 'countdown' | 'playing' | 'over'>('start');
  const score = useRef(0);
  const frames = useRef(0);
  const safeFrames = useRef(0);
  const pipes = useRef<Pipe[]>([]);
  const nextSpawnAt = useRef(60);

  // Countdown
  const [countdown, setCountdown] = useState<number>(0);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Responsive world
  const W = useRef(640);
  const H = useRef(480);
  const GROUND_H = useRef(60);
  const ASPECT = 9 / 16; // portrait width/height

  // Difficulty knobs (balanced/fair)
  const GAP_RANGE: [number, number] = [170, 230];
  const WIDTH_RANGE: [number, number] = [50, 80];
  const SPEED_BASE = 2.2;
  const SPEED_JITTER: [number, number] = [-0.1, 0.2];
  const SPAWN_BASE = 110;
  const SPAWN_JITTER: [number, number] = [0, 30];
  const CLUSTER_PROB = 0.25;
  const CLUSTER_OFFSET: [number, number] = [140, 210];
  const VERTICAL_DRIFT = 25;
  const MIN_H_SPACING = 100;

  // Bird physics
  const GRAVITY = 0.17;
  const JUMP = -5.8;
  const MAX_UP = -9;
  const MAX_DOWN = 8;
  const FLAP_CD = 10;

  const bird = useRef({ x: 120, y: 180, v: 0, r: 18 });
  const flapCd = useRef(0);

  /* ---------- Mini App context ---------- */
  useEffect(() => {
    sdk.actions.ready();
    try { (sdk.actions as any)?.setTitle?.('Flappy Mini'); } catch {}
    document.title = 'Flappy Mini';
    (async () => {
      try {
        const inMini = await sdk.isInMiniApp();
        if (inMini) {
          const ctx = await sdk.context;
          const u = ctx?.user;
          if (u?.username) setViewer({ username: u.username, fid: u.fid });
        }
      } catch {}
    })();
  }, []);

  /* ---------- Canvas, loop, resize ---------- */
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    ctxRef.current = ctx;

    function resize() {
      const wrap = wrapperRef.current || document.body;
      const maxW = Math.max(1, Math.floor(wrap.clientWidth));
      let w = maxW;
      let h = Math.floor(w / ASPECT);

      const maxH = Math.floor(window.innerHeight);
      if (h > maxH) { h = maxH; w = Math.floor(h * ASPECT); }

      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const prevW = W.current, prevH = H.current;
      W.current = w; H.current = h;
      GROUND_H.current = Math.max(48, Math.round(h * 0.12));

      // scale bird
      const sx = w / prevW, sy = h / prevH;
      bird.current.x *= sx;
      bird.current.y *= sy;
      bird.current.r = Math.max(12, Math.round(w * 0.03));

      // update pipes world height/ground
      for (const p of pipes.current) { p.H = H.current; p.ground = GROUND_H.current; }
    }

    resize();
    window.addEventListener('resize', resize);

    const drawBG = () => {
      const _W = W.current, _H = H.current, _G = GROUND_H.current;
      const g = ctx.createLinearGradient(0, 0, 0, _H);
      g.addColorStop(0, '#6ea0ff'); g.addColorStop(1, '#7b57c7');
      ctx.fillStyle = g; ctx.fillRect(0, 0, _W, _H);
      ctx.fillStyle = '#45308b';
      ctx.fillRect(0, _H - _G, _W, _G);
      ctx.strokeStyle = '#2e1f63'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(0, _H - _G); ctx.lineTo(_W, _H - _G); ctx.stroke();
    };

    const drawBird = () => {
      const b = bird.current;
      ctx.fillStyle = '#FFD700';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x + 8, b.y - 5, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(b.x + 10, b.y - 5, 3, 0, Math.PI * 2); ctx.fill();
    };

    const step = () => {
      frames.current++;
      if (safeFrames.current > 0) safeFrames.current--;
      if (flapCd.current > 0) flapCd.current--;

      drawBG();

      // Only move the world in 'playing' state
      if (state.current === 'playing') {
        const b = bird.current;
        const _H = H.current, _G = GROUND_H.current, _W = W.current;

        // physics
        b.v += GRAVITY; b.v *= 0.995;
        if (b.v > MAX_DOWN) b.v = MAX_DOWN;
        if (b.v < MAX_UP) b.v = MAX_UP;
        b.y += b.v;

        // spawn
        if (frames.current >= nextSpawnAt.current) { spawnPipe(_W); scheduleNextSpawn(); }

        // pipes
        for (let i = pipes.current.length - 1; i >= 0; i--) {
          const p = pipes.current[i];
          p.update(score.current);
          p.draw(ctx);

          if (!p.scored && b.x > p.x + p.width) {
            p.scored = true;
            score.current++; setScoreText(String(score.current));
          }
          if (p.x + p.width < 0) { pipes.current.splice(i, 1); continue; }
          if (safeFrames.current <= 0 && p.collidesWith(b)) endGame();
        }

        // bounds
        if (b.y - b.r <= 0 && safeFrames.current <= 0) endGame();
        const groundY = _H - _G - b.r;
        if (b.y > groundY && safeFrames.current <= 0) endGame();
      } else {
        // In 'start', 'countdown', or 'over', just draw pipes without moving them
        pipes.current.forEach(p => p.draw(ctx));
      }

      drawBird();

      // Draw countdown overlay if active
      if (state.current === 'countdown' && countdown > 0) {
        const _W = W.current, _H = H.current;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, 0, _W, _H);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(_W * 0.2)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(countdown), _W / 2, _H / 2);
      }

      requestAnimationFrame(step);
    };

    function flap() {
      // Disable flapping until the game is actually playing
      if (state.current !== 'playing') return;
      if (flapCd.current > 0) return;
      bird.current.v = JUMP;
      flapCd.current = FLAP_CD;
    }
    const onClick = () => flap();
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); flap(); }
    };

    canvas.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);

    step();
    return () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [countdown]);

  /* ---------- request transaction before starting ---------- */
  async function requestGameTx(action: 'play' | 'restart'): Promise<boolean> {
    if (!isConnected || !address) {
      setHint('Connect wallet first.'); return false;
    }
    try {
      // Minimal on-chain ping: 0 ETH to self on Base (gas only).
      await sendTransactionAsync({
        to: address,
        // value: BigInt(0), // not required; defaults to 0
        chainId: base.id,
      });
      return true;
    } catch {
      setHint('Transaction canceled.');
      return false;
    }
  }

  /* ---------- countdown helpers ---------- */
  function stopCountdown() {
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    setCountdown(0);
  }

  function startCountdownThenPlay() {
    // Prepare bird, world, and UI, but DO NOT move yet.
    state.current = 'countdown';
    setHint('Get ready…');
    pipes.current = [];
    score.current = 0;
    frames.current = 0;
    safeFrames.current = 90; // grace will apply after countdown ends
    flapCd.current = 0;
    setScoreText('0');
    bird.current.x = Math.round(W.current * 0.18);
    bird.current.y = H.current * 0.4;
    bird.current.v = 0;
    bird.current.r = Math.max(12, Math.round(W.current * 0.03));
    nextSpawnAt.current = frames.current + 55; // first pipe appears ~1s into the run

    // Start 3 -> 2 -> 1 countdown
    setCountdown(3);
    stopCountdown();
    countdownTimer.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          // done
          stopCountdown();
          // Now actually start playing
          state.current = 'playing';
          setHint(`Fly, @${viewer.username}!`);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  /* ---------- spawning ---------- */
  function spawnPipe(startX = W.current) {
    const _H = H.current, _G = GROUND_H.current;

    // enforce horizontal spacing vs the last pipe
    const last = pipes.current[pipes.current.length - 1];
    if (last) {
      const minAllowedX = last.x + last.width + MIN_H_SPACING;
      if (startX < minAllowedX) startX = minAllowedX;
    }

    const base = SPEED_BASE + rf(SPEED_JITTER[0], SPEED_JITTER[1]);
    const p = new Pipe(startX, _H, _G, {
      gap: ri(GAP_RANGE[0], GAP_RANGE[1]),
      width: ri(WIDTH_RANGE[0], WIDTH_RANGE[1]),
      speed: base
    });

    // small vertical drift vs previous pipe
    if (last) {
      const drift = ri(-VERTICAL_DRIFT, VERTICAL_DRIFT);
      const topMin = 40;
      const topMax = Math.max(topMin, _H - _G - p.gap - 40);
      p.top = Math.min(topMax, Math.max(topMin, p.top + drift));
    }
    pipes.current.push(p);

    // optional close buddy, but honor spacing
    if (Math.random() < CLUSTER_PROB) {
      let buddyX = startX + ri(CLUSTER_OFFSET[0], CLUSTER_OFFSET[1]);
      const minBuddyX = p.x + p.width + MIN_H_SPACING;
      if (buddyX < minBuddyX) buddyX = minBuddyX;

      const buddy = new Pipe(buddyX, _H, _G, {
        gap: ri(GAP_RANGE[0], GAP_RANGE[1]),
        width: ri(WIDTH_RANGE[0], WIDTH_RANGE[1]),
        speed: base
      });
      const topMin = 40;
      const topMax = Math.max(topMin, _H - _G - buddy.gap - 40);
      buddy.top = Math.min(topMax, Math.max(topMin, p.top + ri(-10, 10)));
      pipes.current.push(buddy);
    }
  }

  function scheduleNextSpawn() {
    const jitter = ri(SPAWN_JITTER[0], SPAWN_JITTER[1]);
    nextSpawnAt.current += SPAWN_BASE + jitter;
  }

  /* ---------- API helpers ---------- */
  async function sendScore(username: string, s: number) {
    try { await fetch('/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, score: s }) }); } catch {}
  }
  async function loadLeaderboard() {
    try { const r = await fetch('/api/leaderboard'); if (!r.ok) return;
      const data = (await r.json()) as LeaderRow[]; setLeader(data); } catch {}
  }

  /* ---------- controls (tx → countdown → play) ---------- */
  async function startGame() {
    const ok = await requestGameTx('play');
    if (!ok) return;
    startCountdownThenPlay();
  }

  async function restartGame() {
    const ok = await requestGameTx('restart');
    if (!ok) return;
    startCountdownThenPlay();
  }

  function endGame() {
    if (state.current !== 'playing') return;
    state.current = 'over';
    setHint('game over. press Restart');
    void sendScore(viewer.username, score.current).then(loadLeaderboard);
  }

  useEffect(() => { void loadLeaderboard(); }, []);

  /* ---------- UI (overlays) ---------- */
  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%',
        height: '100dvh',
        overflow: 'hidden',
        position: 'relative',
        background: '#0a0713',
      }}
    >
      {/* Canvas fills frame */}
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {/* Top-left controls + Connect */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={startGame} style={btn}>Play</button>
        <button onClick={restartGame} style={{ ...btn, background: '#2a1f3b' }}>Restart</button>
        <div style={{ marginLeft: 8 }}>
          <ConnectWallet />
        </div>
      </div>

      {/* Top-right score */}
      <div style={{ position: 'absolute', top: 12, right: 12, fontWeight: 800 }}>{scoreText}</div>

      {/* Bottom hint */}
      {hint && (
        <div style={{ position: 'absolute', left: 10, bottom: 10, color: '#b8a7d9', fontSize: 12 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/* ----------------- styles ----------------- */
const btn: React.CSSProperties = {
  background: '#8e44ad',
  color: '#fff',
  border: 'none',
  padding: '10px 14px',
  borderRadius: 12,
  fontWeight: 700,
  cursor: 'pointer'
};

/* ----------------- Pipe ----------------- */
class Pipe {
  x: number; width: number; gap: number; top: number; speed: number;
  H: number; ground: number; scored = false;

  constructor(startX: number, H: number, GROUND_H: number, opts?: {
    gap?: number; width?: number; speed?: number; top?: number;
  }) {
    this.x = startX; this.H = H; this.ground = GROUND_H;
    this.gap   = opts?.gap   ?? ri(170, 230);
    this.width = opts?.width ?? ri(50, 80);
    this.speed = opts?.speed ?? 2.2;

    const topMin = 40;
    const topMax = Math.max(topMin, H - GROUND_H - this.gap - 40);
    this.top = opts?.top ?? ri(topMin, topMax);
  }

  update(score: number) {
    const scale = Math.min(1.5, 1 + score * 0.012); // gentler ramp
    this.x -= this.speed * scale;
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#00C853'; ctx.strokeStyle = '#006E2E'; ctx.lineWidth = 4;
    ctx.fillRect(this.x, 0, this.width, this.top);
    ctx.strokeRect(this.x, 0, this.width, this.top);
    const bottomY = this.top + this.gap;
    const bottomH = this.H - this.ground - bottomY;
    ctx.fillRect(this.x, bottomY, this.width, bottomH);
    ctx.strokeRect(this.x, bottomY, this.width, bottomH);
  }

  collidesWith(b: { x: number; y: number; r: number }) {
    if (b.x + b.r > this.x && b.x - b.r < this.x + this.width) {
      const gapTop = this.top, gapBot = this.top + this.gap;
      if (b.y - b.r < gapTop || b.y + b.r > gapBot) return true;
    }
    return false;
  }
}