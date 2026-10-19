import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { PhoneInput, PhoneState, SensorStatus } from '../../shared/protocol';
import { connect, hello } from '../net';
import { DirectionControl, EmotionControl, HearingControl, HeartbeatControl, InstinctControl, MemoryControl, VisionControl, type ControlProps } from './controls';
import { keepAwake, secureContext } from './sensors';

const STORE_KEY = 'dargato:player';

function loadSaved(): { code: string; token: string; nickname: string } | null {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function save(v: { code: string; token: string; nickname: string }) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

export default function PhoneApp() {
  const params = new URLSearchParams(window.location.search);
  const saved = loadSaved();
  const [code, setCode] = useState((params.get('c') ?? saved?.code ?? '').toUpperCase());
  const [nickname, setNickname] = useState(saved?.nickname ?? '');
  const [state, setState] = useState<PhoneState | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [kicked, setKicked] = useState('');
  const [showHelp, setShowHelp] = useState(true);
  const socketRef = useRef<Socket | null>(null);
  const joinedRef = useRef<{ code: string; nickname: string; token?: string } | null>(null);

  const doJoin = useCallback(async (c: string, nick: string, token?: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    const r = await new Promise<{ ok: boolean; error?: string; state?: PhoneState }>((resolve) => socket.emit('join', { code: c, nickname: nick, token }, resolve));
    if (!r.ok || !r.state) {
      setError(r.error ?? 'Could not join.');
      joinedRef.current = null;
      return;
    }
    setError('');
    setKicked('');
    setState(r.state);
    joinedRef.current = { code: c, nickname: nick, token: r.state.token };
    save({ code: c, token: r.state.token, nickname: nick });
  }, []);

  useEffect(() => {
    const socket = connect();
    socketRef.current = socket;
    socket.on('connect', async () => {
      setConnected(true);
      await hello(socket, 'phone');
      // reconnect: resume the same player slot
      const j = joinedRef.current;
      if (j) doJoin(j.code, j.nickname, j.token);
      else if (saved && saved.code === code && saved.token) doJoin(saved.code, saved.nickname, saved.token);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('phone', (s: PhoneState) => setState(s));
    socket.on('ping2', (t: number) => socket.emit('pong2', t));
    socket.on('kicked', (msg: string) => {
      setKicked(msg);
      setState(null);
      joinedRef.current = null;
    });
    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the screen awake while playing
  useEffect(() => {
    if (!state) return;
    let release = () => {};
    keepAwake().then((r) => (release = r));
    const onVis = () => document.visibilityState === 'visible' && keepAwake().then((r) => (release = r));
    document.addEventListener('visibilitychange', onVis);
    return () => {
      release();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [!!state]);

  const send = useCallback((i: PhoneInput) => socketRef.current?.emit('input', i), []);
  const lastValue = useRef({ v: NaN, t: 0 });
  const sendValue = useCallback(
    (v: number) => {
      const now = performance.now();
      const l = lastValue.current;
      // max 10 Hz, only when changed (plus a slow keep-alive)
      if (now - l.t < 100) return;
      if (Math.abs(v - l.v) < 0.01 && now - l.t < 1000) return;
      lastValue.current = { v, t: now };
      send({ t: 'value', v: Math.round(v * 1000) / 1000 });
    },
    [send],
  );
  const setSensor = useCallback((s: SensorStatus) => socketRef.current?.emit('sensor', s), []);

  if (kicked)
    return (
      <div className="phone center">
        <h1 className="logo">DARGATO</h1>
        <p>{kicked}</p>
        <button className="primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );

  if (!state)
    return (
      <div className="phone center">
        <h1 className="logo">DARGATO</h1>
        <p className="dim">Become one of the senses of a cat on his way home.</p>
        <form
          className="join"
          onSubmit={(e) => {
            e.preventDefault();
            if (!code || !nickname.trim()) return;
            doJoin(code.trim().toUpperCase(), nickname.trim());
          }}
        >
          <label>
            journey code
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={6} autoCapitalize="characters" autoComplete="off" />
          </label>
          <label>
            your name
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={16} autoComplete="nickname" placeholder="a name" />
          </label>
          <button className="primary" type="submit" disabled={!connected || !code || !nickname.trim()}>
            {connected ? 'Join' : 'Connecting...'}
          </button>
          {error && <p className="error">{error}</p>}
          {!secureContext && <p className="note">This page is not served over HTTPS: camera, microphone and motion may be unavailable. Manual controls always work.</p>}
        </form>
      </div>
    );

  const props: ControlProps = { state, send, sendValue, setSensor };
  const sense = state.role.sense;
  const Control =
    sense === 'vision'
      ? VisionControl
      : sense === 'direction'
        ? DirectionControl
        : sense === 'memory'
          ? MemoryControl
          : sense === 'instinct'
            ? InstinctControl
            : sense === 'hearing'
              ? HearingControl
              : sense === 'emotion'
                ? EmotionControl
                : HeartbeatControl;
  const ended = state.phase === 'summary' || state.phase === 'arrival' || state.phase === 'sleep';

  return (
    <div className="phone">
      <header>
        <div>
          <div className="role">{state.roleName}</div>
          <div className="dim small">
            {state.nickname} · {state.players} sense{state.players === 1 ? '' : 's'}
          </div>
        </div>
        <span className={'dot' + (connected ? ' on' : '')} title={connected ? 'connected' : 'reconnecting'} />
      </header>
      {showHelp && (
        <div className="instruction" onClick={() => setShowHelp(false)}>
          {state.instruction}
        </div>
      )}
      {state.phase === 'lobby' && <div className="phase-note">Try your sense. The journey begins soon.</div>}
      {state.paused && <div className="phase-note">paused</div>}
      {ended && state.summary ? (
        <div className="summary-card">
          <h2>{state.phase === 'sleep' ? 'The night is over.' : 'Dargato is home.'}</h2>
          <p>{state.summary.line}</p>
          <p className={state.summary.done ? 'wish done' : 'wish'}>
            Your secret wish: {state.summary.objective} {state.summary.done ? '- fulfilled' : '- not this time'}
          </p>
          <p className="dim">Stay for the next journey.</p>
        </div>
      ) : (
        <Control key={sense + String(state.role.variant)} {...props} />
      )}
      <div className="feedback">{state.feedback}</div>
      {!ended && (
        <div className={'objective' + (state.objective.done ? ' done' : '')}>
          <span>secret wish</span>
          {state.objective.text}
          {state.objective.target > 1 && !state.objective.done && (
            <em>
              {Math.floor(state.objective.progress)}/{state.objective.target}
            </em>
          )}
          {state.objective.done && <em>fulfilled</em>}
        </div>
      )}
      {!connected && <div className="reconnecting">reconnecting...</div>}
    </div>
  );
}
