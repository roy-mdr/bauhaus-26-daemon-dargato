import { Canvas, useFrame } from '@react-three/fiber';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { HEART_ZONE } from '../../shared/config';
import type { DevInput, EndCause, Snapshot } from '../../shared/protocol';
import { roleInfo } from '../../shared/roles';
import type { World, WorldEvent } from '../../shared/types';
import { connect, hello, joinUrl } from '../net';
import { DisplayAudio } from './audio';
import { Home } from './Home';
import { Atmosphere, CameraRig, Dargato, DebugOverlay, SenseFx } from './Scene';
import { Events } from './Signs';
import { pushSnapshot, store } from './store';
import { Thoughts } from './Thoughts';
import { WorldMesh } from './WorldMesh';

const audio = new DisplayAudio();

const ENDING: Record<EndCause, string> = {
  home: 'Dargato is home.',
  slow: 'His heart grew too quiet. Not tonight.',
  fast: 'His heart raced too hard. Not tonight.',
  time: 'Not tonight. The street will keep his place.',
};

/** keys held on the main display, and the sense (and value) each one holds */
const HOLD_KEYS: Record<string, DevInput & { hold: number }> = {
  arrowleft: { sense: 'direction', hold: -1 },
  arrowright: { sense: 'direction', hold: 1 },
  arrowup: { sense: 'speed', hold: 0.8 },
  m: { sense: 'memory', hold: 0.7 },
  i: { sense: 'instinct', hold: 1 },
};

function AudioPump() {
  useFrame((_, dt) => audio.update(Math.min(0.1, dt)));
  return null;
}

export default function DisplayApp() {
  const [world, setWorld] = useState<World | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [info, setInfo] = useState<{ code?: string; lanUrls?: string[]; publicUrl?: string }>({});
  const [qr, setQr] = useState('');
  const [connected, setConnected] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [debug, setDebug] = useState(false);
  const [whispers, setWhispers] = useState<WorldEvent[]>([]);
  const socketRef = useRef<ReturnType<typeof connect> | null>(null);

  useEffect(() => {
    const socket = connect();
    socketRef.current = socket;
    socket.on('connect', async () => {
      setConnected(true);
      const r = await hello(socket, 'display');
      setInfo(r);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('world', (w: World) => {
      store.world = w;
      store.events = [];
      setWorld(w);
    });
    socket.on('snap', (s: Snapshot) => pushSnapshot(s));
    socket.on('ev', (ev: WorldEvent) => {
      if (store.events.some((e) => e.id === ev.id && e.t0 === ev.t0)) return;
      store.events.push(ev);
      if (store.events.length > 40) store.events.shift();
      audio.onEvent(ev);
      if (ev.text) setWhispers((w) => [...w.slice(-2), ev]);
    });
    socket.on('session', (code: string) => setInfo((i) => ({ ...i, code })));
    socket.on('debugOverlay', (on: boolean) => {
      store.debug = on;
      setDebug(on);
    });
    // React state for overlays at a calm rate
    const t = setInterval(() => setSnap(store.latest), 250);
    return () => {
      clearInterval(t);
      socket.disconnect();
    };
  }, []);

  const code = snap?.code ?? info.code ?? '';
  const url = code ? joinUrl(code, info) : '';
  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#141414', light: '#efede8' } }).then(setQr);
  }, [url]);

  // whispers fade on their own
  useEffect(() => {
    if (!whispers.length) return;
    const t = setTimeout(() => setWhispers((w) => w.slice(1)), 6500);
    return () => clearTimeout(t);
  }, [whispers]);

  // keyboard test controls (development / no phones)
  useEffect(() => {
    const send = (d: DevInput) => socketRef.current?.emit('dev', d);
    const held = new Set<string>();
    const sight = { v: 0.5 };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'enter') {
        audio.start().then(() => setAudioOn(audio.enabled));
        socketRef.current?.emit('displayStart');
      }
      if (k === 'g') {
        store.debug = !store.debug;
        setDebug(store.debug);
      }
      if (k === 'f') document.documentElement.requestFullscreen?.().catch(() => {});
      if (!store.latest?.render.keyboard) return;
      if (k === ' ') e.preventDefault();
      if (held.has(k)) return;
      held.add(k);
      if (HOLD_KEYS[k]) send(HOLD_KEYS[k]);
      else if (k === 'w' || k === 's') {
        sight.v = Math.max(0, Math.min(1, sight.v + (k === 'w' ? 0.15 : -0.15)));
        send({ sense: 'sight', hold: sight.v });
      } else if (k === ' ' || k === 'k') send({ sense: 'heartbeat', input: { t: 'tap' } });
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      held.delete(k);
      if (!store.latest?.render.keyboard) return;
      if (HOLD_KEYS[k]) send({ sense: HOLD_KEYS[k].sense, hold: null });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const enableAudio = () => {
    audio.start().then(() => setAudioOn(audio.enabled));
  };

  const phase = snap?.phase ?? 'lobby';
  const realPlayers = snap?.players.filter((p) => !p.sim || p.nickname !== 'simulated') ?? [];

  return (
    <div className="display" onPointerDown={enableAudio}>
      {world && (
        <Canvas
          shadows
          dpr={[1, 1.75]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ fov: 50, near: 0.1, far: 400, position: [0, 30, 30] }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.05;
            gl.shadowMap.type = THREE.PCFSoftShadowMap;
          }}
        >
          <SenseFx />
          <Atmosphere world={world} />
          <WorldMesh world={world} />
          <Home world={world} />
          <Events />
          <Dargato />
          <Thoughts />
          <CameraRig />
          <DebugOverlay world={world} />
          <AudioPump />
        </Canvas>
      )}

      <Vignette snap={snap} />
      <HeartMeter />

      {phase === 'lobby' && (
        <div className="lobby">
          <div className="lobby-title">
            <h1>DARGATO</h1>
            <p>A cat knows the way home. He does not remember why he was away.</p>
            <p className="dim">Become one of his senses. Scan the code with your phone.</p>
          </div>
          <div className="lobby-join">
            {qr && <img src={qr} alt="QR code to join" />}
            <div className="code">{code}</div>
            <div className="url">{url.replace(/^https?:\/\//, '')}</div>
          </div>
          <div className="lobby-players">
            {realPlayers.filter((p) => p.nickname !== 'simulated').map((p) => (
              <span key={p.id} className={'chip' + (p.connected ? '' : ' off')}>
                {p.nickname} <b>{p.roleName}</b>
              </span>
            ))}
            {snap && snap.realPlayers < 6 && <span className="chip ghost">missing senses are dreamed by Dargato himself</span>}
            <span className="chip ghost">HEARTBEAT: tap with the pulse below</span>
          </div>
          <div className="lobby-hint">
            {snap && snap.autoStartIn >= 0 ? `The journey begins in ${snap.autoStartIn}s` : snap?.render.keyboard ? 'Press Enter to begin the journey' : 'Waiting for the host'}
          </div>
        </div>
      )}

      {phase === 'intro' && <div className="center-text fade-in-out">Dargato wants to go home.</div>}

      {(phase === 'journey' || phase === 'intro') && qr && (
        <div className="corner-join">
          <img src={qr} alt="" />
          <span>{code}</span>
        </div>
      )}

      <div className="whispers">
        {whispers.map((w) => (
          <div key={w.id + ':' + w.t0} className="whisper">
            {w.text}
          </div>
        ))}
      </div>

      {(phase === 'arrival' || phase === 'sleep') && (
        <div className="center-text slow">{ENDING[snap?.endCause ?? (phase === 'arrival' ? 'home' : 'time')]}</div>
      )}

      {phase === 'summary' && <Summary snap={snap!} />}

      {snap?.paused && <div className="paused">paused</div>}
      {!connected && <div className="offline">connecting to the game server...</div>}
      {!audioOn && <div className="audio-hint">click for sound</div>}
      {debug && snap && <DebugPanel snap={snap} />}
    </div>
  );
}

function Vignette({ snap }: { snap: Snapshot | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = store.latest;
      if (ref.current && s) {
        // the edges close in and redden with the heart's strain, throbbing with the pulse
        const fx = store.fx;
        ref.current.style.opacity = String(Math.min(1, 0.35 + fx.strain * 0.5 + (s.overtime ? 0.25 : 0)));
        ref.current.style.setProperty('--red', String(fx.strain * (0.25 + 0.35 * fx.beat)));
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div ref={ref} className="vignette" data-phase={snap?.phase} />;
}

/** HEARTBEAT: the pulse to tap along with, and the slider of how the hearts are doing */
function HeartMeter() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const s = store.latest;
      const el = ref.current;
      if (el && s) {
        const show = s.phase === 'lobby' || s.phase === 'intro' || s.phase === 'journey';
        el.style.opacity = show ? '1' : '0';
        el.style.setProperty('--beat', String(store.fx.beat));
        el.style.setProperty('--pos', String(s.inner.heart));
        el.style.setProperty('--strain', String(store.fx.strain));
        el.dataset.off = Math.abs(s.inner.heart) > HEART_ZONE ? '1' : '0';
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={ref} className="heart-meter">
      <div className="heart-pulse" />
      <div className="heart-track">
        <div className="heart-zone" />
        <div className="heart-mark" />
      </div>
      <div className="heart-labels">
        <span>too slow</span>
        <span>too fast</span>
      </div>
    </div>
  );
}

function Summary({ snap }: { snap: Snapshot }) {
  const sum = snap.summary;
  const t = sum?.durationSec ?? Math.round(snap.journeyT);
  const time = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  return (
    <div className="summary">
      <h2>{snap.ending === 'home' ? 'Dargato is home.' : snap.endCause === 'fast' ? 'Dargato hides in a doorway until morning.' : 'Dargato sleeps in the street.'}</h2>
      {sum && (
        <p className="dim">
          {time} through the streets · {sum.distance} paces · {sum.streets} street{sum.streets === 1 ? '' : 's'} · {sum.detours} detour{sum.detours === 1 ? '' : 's'} · {sum.discoveries} discover{sum.discoveries === 1 ? 'y' : 'ies'} · {sum.landmarks} red sign{sum.landmarks === 1 ? '' : 's'}
        </p>
      )}
      <div className="summary-players">
        {(sum?.players ?? []).map((p, i) => (
          <div key={i} className="summary-player">
            <span>{p.nickname}</span>
            <b>{p.roleName}</b>
            <i>{p.done ? 'secret wish fulfilled' : ''}</i>
          </div>
        ))}
      </div>
      <p className="dim">The next journey begins soon.</p>
    </div>
  );
}

function DebugPanel({ snap }: { snap: Snapshot }) {
  const i = snap.inner;
  const fmt = (v: number) => v.toFixed(2);
  const rows = useMemo(() => Object.entries(i).map(([k, v]) => [k, fmt(v as number)]), [i]);
  return (
    <div className="debug-panel">
      <div>
        <b>{snap.phase}</b> t={snap.journeyT.toFixed(0)}s rem={snap.remaining.toFixed(0)} hard={snap.hardRemaining.toFixed(0)} cat={snap.cat.state} node={snap.cat.node} edge={snap.cat.edge}
      </div>
      <div className="grid2">
        {rows.map(([k, v]) => (
          <span key={k}>
            {k} {v}
          </span>
        ))}
      </div>
      <div className="dim">
        keys: ←/→ direction · ↑ speed (hold) · W/S sight · M memory (hold) · I instinct (hold) · space/K heartbeat · G debug · F fullscreen · Enter start
      </div>
      <div className="dim">players: {snap.players.map((p) => `${p.nickname}:${roleInfo(p.role).name}`).join(', ')}</div>
    </div>
  );
}
