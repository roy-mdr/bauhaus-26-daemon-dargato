// The tutorial between the lobby and the journey: one card per sense with who plays it,
// the phone sensor it uses, what it does to Dargato, and a small live picture of that
// effect that answers the players' phones right away. A last panel shows what home looks like.
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/protocol';
import { SENSE_ORDER, roleInfo, type RoleInfo } from '../../shared/roles';
import type { SenseId } from '../../shared/types';
import { connect, hello } from '../net';
import { pushSnapshot, seesClearly, serverNow, store } from './store';

const C = { offwhite: '#efede8', pale: '#d6d4ce', mid: '#8f8d89', charcoal: '#383735', black: '#131313', red: '#c3221c' };

const SENSOR: Record<RoleInfo['sensor'], string> = {
  camera: 'Camera: point it at light or into shade',
  motion: 'Motion: shake the phone',
  orientation: 'Tilt: hold the phone flat, tilt it left or right',
  microphone: 'Microphone: blow, whisper or speak into it',
  touch: 'Touch screen',
};

/** what changes along the way, or what this sense depends on */
const NOTE: Record<SenseId, string> = {
  sight: 'Far from home a little light is enough and more blinds him. Near home he needs a lot of light.',
  speed: 'Without paths (MEMORY) his paws find nothing to walk on.',
  direction: 'He follows the streets; your tilt chooses where to turn.',
  memory: 'Far from home a whisper holds the paths. Near home he needs it loud.',
  instinct: 'He only sees the red way while SIGHT keeps his eyes clear.',
  heartbeat: 'A few seconds off the beat, too slow or too fast, and the night is over.',
};

/** the live values each card draws, eased per frame */
interface Live {
  sight: number;
  light: number;
  glare: number;
  band: [number, number];
  paws: number;
  turn: number;
  cohesion: number;
  loud: number;
  sound: [number, number];
  instinct: number;
  sees: number;
  heart: number;
  zone: number;
  /** distance the speed card's ground has scrolled */
  roll: number;
}

const rand = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export function Tutorial({ snap }: { snap: Snapshot | null }) {
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => {
    const L: Live = { sight: 0.5, light: 1, glare: 0, band: [0.3, 0.7], paws: 0, turn: 0, cohesion: 1, loud: 0, sound: [0.1, 0.4], instinct: 0, sees: 1, heart: 0, zone: 0.3, roll: 0 };
    let raf = 0;
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = store.latest;
      if (s) {
        const I = s.inner;
        const k = 1 - Math.exp(-dt * 6);
        const e = (cur: number, to: number) => cur + (to - cur) * k;
        L.sight = e(L.sight, I.sight);
        L.light = e(L.light, I.light);
        L.glare = e(L.glare, I.glare);
        L.band = [e(L.band[0], s.targets.sight[0]), e(L.band[1], s.targets.sight[1])];
        L.paws = e(L.paws, I.paws);
        L.turn = e(L.turn, I.turn);
        L.cohesion = e(L.cohesion, I.cohesion);
        L.loud = e(L.loud, s.loudness);
        L.sound = [e(L.sound[0], s.targets.sound[0]), e(L.sound[1], s.targets.sound[1])];
        L.instinct = e(L.instinct, I.instinct);
        L.sees = e(L.sees, seesClearly(I));
        L.heart = e(L.heart, I.heart);
        L.zone = e(L.zone, s.targets.heart);
        L.roll += L.paws * dt * 90;
        const beat = Math.pow(Math.max(0, Math.cos(((((serverNow() / 1000) * s.heartBpm) / 60) % 1) * Math.PI * 2)), 14);
        for (const [key, cv] of canvases.current) {
          const ctx = fit(cv);
          if (ctx) draw(key, ctx, cv.width / devicePixelRatio, cv.height / devicePixelRatio, L, now / 1000, beat);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  const reg = (key: string) => (el: HTMLCanvasElement | null) => {
    if (el) canvases.current.set(key, el);
    else canvases.current.delete(key);
  };

  const players = snap?.players ?? [];
  const footer =
    snap?.phase !== 'tutorial'
      ? 'The tutorial opens when the host starts the journey.'
      : snap.tutorialIn >= 0
        ? `The journey begins in ${snap.tutorialIn}s`
        : snap.render.keyboard
          ? 'Press Enter to begin the journey'
          : 'Waiting for the host';

  return (
    <div className="tutorial">
      <header className="tutorial-head">
        <h1>How to bring Dargato home</h1>
        <p>Every phone is one of his senses. Find yours below and try it now: the picture answers your phone.</p>
      </header>
      <div className="tutorial-grid">
        {SENSE_ORDER.map((sense) => {
          const info = roleInfo({ sense });
          const mine = players.filter((p) => p.role.sense === sense && !p.sim);
          return (
            <section key={sense} className="tutorial-card">
              <div className="tutorial-card-head">
                <h2>{info.name}</h2>
                <div className="tutorial-players">
                  {mine.length ? mine.map((p) => <span key={p.id} className={'chip' + (p.connected ? '' : ' off')}>{p.nickname}</span>) : <span className="chip ghost">dreamed by Dargato</span>}
                </div>
              </div>
              <canvas ref={reg(sense)} className="tutorial-viz" />
              <p className="tutorial-sensor">{SENSOR[info.sensor]}</p>
              <p>{info.instruction}</p>
              <p className="dim">{NOTE[sense]}</p>
            </section>
          );
        })}
        <section className="tutorial-card home">
          <canvas ref={reg('home')} className="tutorial-viz" />
          <div>
            <h2>HOME</h2>
            <p>An open field of red dots where other cats wait, with a column of dots rising from its heart. You can see it from far away.</p>
            <p>Bring Dargato into the field before the night ends. Nobody can do it alone: without SPEED he stands still, without MEMORY there are no paths, without HEARTBEAT the night ends.</p>
            <p className="dim">Each of you also has a secret wish. Look at your phone.</p>
          </div>
        </section>
      </div>
      <footer className="tutorial-foot">{footer}</footer>
    </div>
  );
}

/** the tutorial on its own page (/tutorial), e.g. on a second screen or to preview it */
export default function TutorialPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const socket = connect();
    socket.on('connect', () => {
      setConnected(true);
      hello(socket, 'display');
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('snap', (s: Snapshot) => pushSnapshot(s));
    const t = setInterval(() => setSnap(store.latest), 250);
    return () => {
      clearInterval(t);
      socket.disconnect();
    };
  }, []);
  return (
    <div className="display">
      <Tutorial snap={snap} />
      {!connected && <div className="offline">connecting to the game server...</div>}
    </div>
  );
}

/** sizes the canvas to its box (and the screen's pixel ratio) */
function fit(cv: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr);
  const h = Math.round(cv.clientHeight * dpr);
  if (!w || !h) return null;
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const ctx = cv.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** the meter under each picture, like the ones on the main screen: a target zone and a mark (or a fill) */
function meter(ctx: CanvasRenderingContext2D, w: number, h: number, o: { pos: number; zone?: [number, number]; ramp?: boolean; fill?: string; off?: boolean }) {
  const y = h - 10;
  const x0 = 6;
  const W = w - 12;
  ctx.fillStyle = 'rgba(150, 148, 143, 0.35)';
  ctx.fillRect(x0, y, W, 5);
  if (o.zone) {
    const [a, b] = o.zone;
    if (o.ramp) {
      const g = ctx.createLinearGradient(x0 + a * W, 0, x0 + b * W, 0);
      g.addColorStop(0, 'rgba(56, 55, 53, 0)');
      g.addColorStop(1, 'rgba(56, 55, 53, 0.4)');
      ctx.fillStyle = g;
      ctx.fillRect(x0 + a * W, y, (1 - a) * W, 5);
    } else {
      ctx.fillStyle = 'rgba(56, 55, 53, 0.4)';
      ctx.fillRect(x0 + a * W, y, (b - a) * W, 5);
    }
  }
  if (o.fill) {
    ctx.fillStyle = o.fill;
    ctx.fillRect(x0, y, Math.max(0, Math.min(1, o.pos)) * W, 5);
  } else {
    ctx.fillStyle = o.off ? C.red : C.black;
    ctx.fillRect(x0 + Math.max(0, Math.min(1, o.pos)) * W - 2, y - 5, 4, 15);
  }
}

function draw(key: string, ctx: CanvasRenderingContext2D, w: number, h: number, L: Live, t: number, beat: number) {
  ctx.clearRect(0, 0, w, h);
  const vh = h - 22; // the picture sits above the meter
  switch (key) {
    case 'sight': {
      // a street between buildings: dark below the band, swallowed by glare above it
      ctx.fillStyle = C.offwhite;
      ctx.fillRect(0, 0, w, vh);
      ctx.fillStyle = C.pale;
      ctx.fillRect(0, vh * 0.72, w, vh * 0.28);
      const blocks = [0.04, 0.2, 0.62, 0.8];
      blocks.forEach((bx, i) => {
        ctx.fillStyle = i % 2 ? C.mid : C.charcoal;
        const bh = vh * (0.45 + 0.25 * rand(i));
        ctx.fillRect(bx * w, vh * 0.72 - bh, w * 0.15, bh);
      });
      dot(ctx, w * 0.5, vh * 0.66, 5, C.black);
      ctx.fillStyle = `rgba(19, 19, 19, ${(1 - L.light) * 0.94})`;
      ctx.fillRect(0, 0, w, vh);
      ctx.fillStyle = `rgba(255, 255, 255, ${L.glare * 0.95})`;
      ctx.fillRect(0, 0, w, vh);
      meter(ctx, w, h, { pos: L.sight, zone: L.band, off: L.light < 0.5 || L.glare > 0.4 });
      break;
    }
    case 'speed': {
      // the ground rolls under him as the paws move; his body bobs with each step
      const gy = vh * 0.72;
      ctx.fillStyle = C.pale;
      ctx.fillRect(0, gy, w, 2);
      for (let i = 0; i < 24; i++) {
        const x = (((i * 37 - L.roll) % (w + 40)) + w + 40) % (w + 40) - 20;
        dot(ctx, x, gy + 8 + rand(i) * (vh - gy - 10), 1.6, C.mid, 0.7);
      }
      const step = t * (2 + L.paws * 10);
      const bob = Math.abs(Math.sin(step)) * 4 * L.paws;
      const cx = w * 0.5;
      ctx.fillStyle = C.black;
      ctx.beginPath();
      ctx.moveTo(cx - 22, gy - 8 - bob);
      ctx.lineTo(cx + 22, gy - 14 - bob);
      ctx.lineTo(cx + 4, gy - 26 - bob);
      ctx.closePath();
      ctx.fill();
      for (let p = 0; p < 4; p++) {
        const lift = Math.max(0, Math.sin(step + p * Math.PI * 0.5)) * 6 * L.paws;
        dot(ctx, cx - 16 + p * 10, gy - 2 - lift, 2.4, C.black);
      }
      meter(ctx, w, h, { pos: L.paws, fill: C.charcoal });
      break;
    }
    case 'direction': {
      // a crossing seen from above: he turns where the phone tilts
      const cx = w / 2;
      const cy = vh / 2 + 4;
      ctx.fillStyle = C.pale;
      ctx.fillRect(cx - 14, 0, 28, vh);
      ctx.fillRect(0, cy - 14, w, 28);
      const a = L.turn * 1.2;
      ctx.strokeStyle = C.mid;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, 34, -Math.PI / 2, -Math.PI / 2 + a, a < 0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a);
      ctx.fillStyle = C.black;
      ctx.beginPath();
      ctx.moveTo(0, -24);
      ctx.lineTo(11, 12);
      ctx.lineTo(-11, 12);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      meter(ctx, w, h, { pos: 0.5 + L.turn / 2 });
      break;
    }
    case 'memory': {
      // sound pulls the dots into a path; in silence they drift apart
      const n = 56;
      const c = L.cohesion;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const px = 10 + u * (w - 20);
        const py = vh * 0.55 + Math.sin(u * Math.PI * 2) * vh * 0.18 + (rand(i + 9) - 0.5) * 8;
        const sx = rand(i) * w;
        const sy = rand(i + 50) * vh;
        const drift = (1 - c) * 6;
        const x = sx + (px - sx) * c + Math.sin(t * 0.9 + i) * drift;
        const y = sy + (py - sy) * c + Math.cos(t * 0.7 + i * 1.3) * drift;
        dot(ctx, x, y, 2.2, C.charcoal, 0.35 + 0.6 * c);
      }
      meter(ctx, w, h, { pos: L.loud, zone: L.sound, ramp: true, off: L.cohesion < 0.3 });
      break;
    }
    case 'instinct': {
      // a few streets of dots; the shortest way home glows red (only if his eyes are clear)
      const cols = 7;
      const rows = 3;
      const gx = (i: number) => 16 + (i / (cols - 1)) * (w - 32);
      const gy = (j: number) => 14 + (j / (rows - 1)) * (vh - 28);
      const glow = L.instinct * L.sees;
      const onRoute = (i: number, j: number) => (j === rows - 1 && i <= 3) || (i === 3 && j >= 0) || (j === 0 && i >= 3);
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++)
          for (let s = 0; s < 4; s++) {
            const x = gx(i) + (s / 4) * (gx(1) - gx(0));
            if (i < cols - 1) {
              const red = onRoute(i, j) && onRoute(i + 1, j) ? glow : 0;
              dot(ctx, x, gy(j), 1.8, red > 0.05 ? C.red : C.mid, red > 0.05 ? 0.3 + 0.7 * red : 0.55);
            }
            const y = gy(j) + (s / 4) * (gy(1) - gy(0));
            if (j < rows - 1) {
              const red = i === 3 ? glow : 0;
              dot(ctx, gx(i), y, 1.8, red > 0.05 ? C.red : C.mid, red > 0.05 ? 0.3 + 0.7 * red : 0.55);
            }
          }
      dot(ctx, gx(0), gy(rows - 1), 5, C.black);
      for (let i = 0; i < 10; i++) dot(ctx, gx(cols - 1) + (rand(i) - 0.5) * 16, gy(0) + (rand(i + 3) - 0.5) * 12, 2, C.red, 0.8);
      if (L.instinct > 0.15 && L.sees < 0.5) {
        const msg = 'his eyes cannot see it';
        ctx.font = '11px Helvetica Neue, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(msg).width + 14;
        const ty = (gy(1) + gy(2)) / 2;
        ctx.fillStyle = 'rgba(239, 237, 232, 0.92)';
        ctx.fillRect(w / 2 - tw / 2, ty - 9, tw, 18);
        ctx.fillStyle = C.charcoal;
        ctx.fillText(msg, w / 2, ty);
      }
      meter(ctx, w, h, { pos: L.instinct, fill: C.red });
      break;
    }
    case 'heartbeat': {
      // the pulse to tap along with, and the slider of how the hearts keep up
      const off = Math.abs(L.heart) > L.zone;
      dot(ctx, w / 2, vh / 2 + 2, 14 + beat * 10, C.red, 0.35 + beat * 0.65);
      meter(ctx, w, h, { pos: 0.5 + L.heart / 2, zone: [0.5 - L.zone / 2, 0.5 + L.zone / 2], off });
      break;
    }
    case 'home': {
      // the field of red dots, densest at its heart, and the column rising out of it
      const cx = w * 0.5;
      const cy = h * 0.72;
      for (let i = 0; i < 220; i++) {
        const a = rand(i) * Math.PI * 2;
        const r = Math.pow(rand(i + 400), 1.6) * w * 0.45;
        dot(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.28, 1.6 + rand(i + 7), C.red, 0.85 - (r / (w * 0.45)) * 0.6);
      }
      for (let i = 0; i < 70; i++) {
        const f = (rand(i + 90) + t * 0.08 * (0.5 + rand(i + 30))) % 1;
        dot(ctx, cx + (rand(i + 60) - 0.5) * 14, cy - f * cy * 0.95, 1.6, C.red, 0.9 * (1 - f));
      }
      const pulse = (t * 0.25) % 1;
      ctx.strokeStyle = `rgba(195, 34, 28, ${0.4 * (1 - pulse)})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, pulse * w * 0.45, pulse * w * 0.45 * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }
}
