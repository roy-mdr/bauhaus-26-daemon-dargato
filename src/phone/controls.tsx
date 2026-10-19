import { useEffect, useRef, useState } from 'react';
import type { PhoneInput, PhoneState, SensorStatus } from '../../shared/protocol';
import { CameraLuminance, MicListener, TiltSensor, vibrate, type SensorState } from './sensors';

export interface ControlProps {
  state: PhoneState;
  send: (i: PhoneInput) => void;
  sendValue: (v: number) => void;
  setSensor: (s: SensorStatus) => void;
}

function Meter({ value, min = 0, max = 1, label, red }: { value: number; min?: number; max?: number; label?: string; red?: boolean }) {
  const k = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const centered = min < 0;
  return (
    <div className="meter">
      {label && <span className="meter-label">{label}</span>}
      <div className="meter-track">
        {centered ? (
          <div className={'meter-fill' + (red ? ' red' : '')} style={{ left: `${Math.min(50, k * 100)}%`, width: `${Math.abs(k - 0.5) * 100}%` }} />
        ) : (
          <div className={'meter-fill' + (red ? ' red' : '')} style={{ width: `${k * 100}%` }} />
        )}
        {centered && <div className="meter-center" />}
      </div>
    </div>
  );
}

function SensorBar({ state, onEnable, onFallback, fallback, label }: { state: SensorState; onEnable: () => void; onFallback: () => void; fallback: boolean; label: string }) {
  return (
    <div className="sensor-bar">
      <span className={'sensor-state ' + state}>
        {label}: {fallback ? 'manual' : state === 'active' ? 'on' : state === 'requesting' ? 'asking...' : state === 'denied' ? 'not allowed' : state === 'unsupported' ? 'not available' : 'off'}
      </span>
      {!fallback && state !== 'active' && state !== 'requesting' && (
        <button className="small" onClick={onEnable}>
          enable {label}
        </button>
      )}
      <button className="small ghost" onClick={onFallback}>
        {fallback ? `use ${label}` : 'manual control'}
      </button>
    </div>
  );
}

function useSensor(name: string, setSensor: ControlProps['setSensor']) {
  const [state, setState] = useState<SensorState>('idle');
  const [fallback, setFallback] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  useEffect(() => {
    setSensor({ sensor: name, state: fallback ? 'fallback' : state, calibrated });
  }, [name, state, fallback, calibrated, setSensor]);
  return { state, setState, fallback, setFallback, calibrated, setCalibrated };
}

/** a manual slider for fallbacks */
function Slider({ value, onChange, min = 0, max = 1, springBack }: { value: number; onChange: (v: number) => void; min?: number; max?: number; springBack?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const update = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onChange(min + k * (max - min));
  };
  const k = (value - min) / (max - min);
  return (
    <div
      ref={ref}
      className="slider"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => e.buttons && update(e)}
      onPointerUp={() => springBack && onChange((min + max) / 2)}
      onPointerCancel={() => springBack && onChange((min + max) / 2)}
    >
      <div className="slider-knob" style={{ left: `${k * 100}%` }} />
    </div>
  );
}

// ---------------- VISION / RED SIGHT ----------------

export function VisionControl({ state, sendValue, setSensor }: ControlProps) {
  const s = useSensor('camera', setSensor);
  const cam = useRef<CameraLuminance | null>(null);
  const [v, setV] = useState(0.5);
  const enable = async () => {
    s.setState('requesting');
    const c = new CameraLuminance();
    c.onValue = (val) => {
      setV(val);
      sendValue(val);
    };
    const r = await c.start();
    s.setState(r);
    if (r === 'active') cam.current = c;
    else s.setFallback(true);
  };
  useEffect(() => () => cam.current?.stop(), []);
  return (
    <div className="control">
      <div className="big-meter">
        <div className="eye" style={{ opacity: 0.25 + v * 0.75, transform: `scale(${0.7 + v * 0.5})` }} />
      </div>
      <Meter value={v} label="light" red={state.role.variant} />
      {s.fallback ? (
        <Slider
          value={v}
          onChange={(x) => {
            setV(x);
            sendValue(x);
          }}
        />
      ) : s.state === 'active' ? (
        <div className="row">
          <button
            className="small"
            onClick={() => {
              cam.current?.calibrateDark();
              s.setCalibrated(true);
            }}
          >
            covered = dark
          </button>
          <button
            className="small"
            onClick={() => {
              cam.current?.calibrateBright();
              s.setCalibrated(true);
            }}
          >
            pointed at light = bright
          </button>
        </div>
      ) : (
        <button className="primary" onClick={enable}>
          Open his eyes (camera)
        </button>
      )}
      <p className="note">Only a brightness number leaves your phone. No images are sent.</p>
      <SensorBar label="camera" state={s.state} fallback={s.fallback} onEnable={enable} onFallback={() => s.setFallback(!s.fallback)} />
    </div>
  );
}

// ---------------- DIRECTION / WANDERLUST ----------------

export function DirectionControl({ state, sendValue, setSensor }: ControlProps) {
  const s = useSensor('motion', setSensor);
  const tilt = useRef<TiltSensor | null>(null);
  const [x, setX] = useState(0);
  const enable = async () => {
    s.setState('requesting');
    const t = new TiltSensor();
    t.onValue = (v) => {
      setX(v);
      sendValue(v);
    };
    const r = await t.start();
    s.setState(r);
    if (r === 'active') {
      tilt.current = t;
      t.calibrate();
      s.setCalibrated(true);
    } else {
      t.stop();
      s.setFallback(true);
    }
  };
  useEffect(() => () => tilt.current?.stop(), []);
  const labels = state.role.variant ? ['explore', 'homeward'] : ['left', 'right'];
  return (
    <div className="control">
      <div className={'junction-cue' + (state.cue.approaching ? ' on' : '')}>{state.cue.approaching ? 'a junction - choose now' : 'walking...'}</div>
      <div className="tilt-view">
        <span>{labels[0]}</span>
        <div className="tilt-track">
          <div className="tilt-dot" style={{ left: `${50 + x * 45}%` }} />
        </div>
        <span>{labels[1]}</span>
      </div>
      {s.fallback ? (
        <>
          <p className="note">Drag and hold toward a side.</p>
          <Slider
            value={x}
            min={-1}
            max={1}
            springBack
            onChange={(v) => {
              setX(v);
              sendValue(v);
            }}
          />
        </>
      ) : s.state === 'active' ? (
        <button
          className="small"
          onClick={() => {
            tilt.current?.calibrate();
            vibrate(30);
          }}
        >
          set this as straight
        </button>
      ) : (
        <button className="primary" onClick={enable}>
          Feel the way (motion sensor)
        </button>
      )}
      <SensorBar label="motion" state={s.state} fallback={s.fallback} onEnable={enable} onFallback={() => s.setFallback(!s.fallback)} />
    </div>
  );
}

// ---------------- MEMORY / ECHO ----------------

export function MemoryControl({ state, send, sendValue, setSensor }: ControlProps) {
  const s = useSensor('microphone', setSensor);
  const mic = useRef<MicListener | null>(null);
  const [level, setLevel] = useState(0);
  const [flash, setFlash] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const taps = useRef<number[]>([]);
  const lastSent = useRef(0);
  const fire = (rhythm: boolean, v: number, bpm = 100, reg = 0.8) => {
    setFlash(performance.now());
    vibrate(rhythm ? [40, 40, 40] : 40);
    send(rhythm ? { t: 'rhythm', bpm, reg } : { t: 'onset', v });
  };
  const enable = async () => {
    s.setState('requesting');
    const m = new MicListener();
    m.threshold = 0.22 / Math.max(0.3, state.sensitivity);
    m.onLevel = (v) => {
      const now = performance.now();
      if (now - lastSent.current > 200) {
        lastSent.current = now;
        setLevel(v);
        sendValue(v);
      }
    };
    m.onOnset = (v) => fire(false, v);
    m.onRhythm = (bpm, reg) => fire(true, 1, bpm, reg);
    const r = await m.start();
    s.setState(r);
    if (r === 'active') {
      mic.current = m;
      setCalibrating(true);
      setTimeout(() => {
        setCalibrating(false);
        s.setCalibrated(true);
      }, 2100);
    } else s.setFallback(true);
  };
  useEffect(() => () => mic.current?.stop(), []);
  const knock = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 4000), now];
    const ts = taps.current.slice(-5);
    if (ts.length >= 4) {
      const iv = ts.slice(1).map((t, i) => t - ts[i]);
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
      if (sd / mean < 0.25 && mean > 180 && mean < 1300) {
        taps.current = [];
        fire(true, 1, 60000 / mean, 1 - (sd / mean) * 3);
        return;
      }
    }
    fire(false, 0.8);
  };
  const recent = performance.now() - flash < 500;
  return (
    <div className="control">
      <div className={'memory-orb' + (recent ? ' flash' : '')} style={{ transform: `scale(${0.8 + level * 0.6})` }} />
      <Meter value={level} label="sound" red={state.role.variant} />
      {state.cue.cooldown > 0 && !state.role.variant && <p className="note">the memory is settling... {state.cue.cooldown}s</p>}
      {calibrating && <p className="note">Stay quiet: listening to the room...</p>}
      {s.fallback ? (
        <>
          <button className="pad" onPointerDown={knock}>
            knock
          </button>
          <p className="note">Knock once for a sound, four even knocks for a rhythm.</p>
          {state.role.variant && (
            <Slider
              value={level}
              onChange={(v) => {
                setLevel(v);
                sendValue(v);
              }}
            />
          )}
        </>
      ) : s.state === 'active' ? (
        <button
          className="small"
          onClick={() => {
            mic.current?.calibrate();
            setCalibrating(true);
            setTimeout(() => setCalibrating(false), 2100);
          }}
        >
          re-measure the room
        </button>
      ) : (
        <button className="primary" onClick={enable}>
          Listen (microphone)
        </button>
      )}
      <p className="note">Sound is analysed on your phone. Nothing is recorded or sent.</p>
      <SensorBar label="microphone" state={s.state} fallback={s.fallback} onEnable={enable} onFallback={() => s.setFallback(!s.fallback)} />
    </div>
  );
}

// ---------------- INSTINCT / RESTRAINT ----------------

export function InstinctControl({ state, send, setSensor }: ControlProps) {
  useEffect(() => {
    setSensor({ sensor: 'touch', state: 'active', calibrated: true });
  }, [setSensor]);
  const scratch = useRef({ dist: 0, last: { x: 0, y: 0 }, t: 0, sentAt: 0 });
  const [pulse, setPulse] = useState(0);
  const lastTap = useRef(0);
  const variant = state.role.variant;
  return (
    <div className="control">
      <div
        className={'pad big' + (variant ? ' restraint' : '')}
        onPointerDown={(e) => {
          const now = performance.now();
          scratch.current.last = { x: e.clientX, y: e.clientY };
          if (now - lastTap.current > 90) {
            lastTap.current = now;
            send({ t: 'tap' });
            setPulse(now);
            vibrate(15);
          }
        }}
        onPointerMove={(e) => {
          if (variant || !e.buttons) return;
          const sc = scratch.current;
          sc.dist += Math.hypot(e.clientX - sc.last.x, e.clientY - sc.last.y);
          sc.last = { x: e.clientX, y: e.clientY };
          const now = performance.now();
          if (now - sc.sentAt > 250) {
            const intensity = Math.min(1, sc.dist / 600);
            if (intensity > 0.15) send({ t: 'scratch', v: intensity });
            sc.dist = 0;
            sc.sentAt = now;
          }
        }}
      >
        <span style={{ transform: `scale(${performance.now() - pulse < 120 ? 1.15 : 1})` }}>{variant ? 'tap to hold him back' : 'tap · scratch'}</span>
      </div>
      <Meter value={state.cue.level} label={variant ? 'caution' : 'energy'} red />
    </div>
  );
}

// ---------------- EMOTION / REST ----------------

export function EmotionControl({ state, send, setSensor }: ControlProps) {
  useEffect(() => {
    setSensor({ sensor: 'touch', state: 'active', calibrated: true });
  }, [setSensor]);
  const [held, setHeld] = useState(false);
  const start = useRef({ y: 0, t: 0 });
  const variant = state.role.variant;
  const release = () => {
    if (!held) return;
    setHeld(false);
    send({ t: 'hold', on: false });
  };
  return (
    <div className="control">
      <div
        className={'emotion-circle' + (held ? ' held' : '')}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          start.current = { y: e.clientY, t: performance.now() };
          setHeld(true);
          send({ t: 'hold', on: true });
          vibrate(20);
        }}
        onPointerMove={(e) => {
          if (variant || !held) return;
          if (e.clientY - start.current.y > 90 && performance.now() - start.current.t < 450) {
            start.current.t = 0;
            send({ t: 'flinch' });
            vibrate([30, 30, 60]);
            release();
          }
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <span>{variant ? (held ? 'resting...' : 'hold to rest') : held ? 'calm...' : 'hold'}</span>
      </div>
      {!variant && <p className="note">hold: calm · let go: curious · swipe down fast: wary</p>}
      {variant ? <Meter value={state.cue.level} label="rest" /> : <Meter value={state.cue.level} min={-1} max={1} label="curious ← → calm" red />}
    </div>
  );
}

// ---------------- HEARING / FAR EAR ----------------

export function HearingControl({ state, send, setSensor }: ControlProps) {
  useEffect(() => {
    setSensor({ sensor: 'touch', state: 'active', calibrated: true });
  }, [setSensor]);
  const [tick, setTick] = useState(0);
  const beat = useRef({ next: performance.now() + 1000, side: 0, last: 0, lastSide: 0, hits: 0 });
  const audio = useRef<AudioContext | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const tempo = state.cue.tempo;
  const cueSide = state.cue.side;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const b = beat.current;
      const now = performance.now();
      if (now >= b.next) {
        b.last = b.next;
        b.lastSide = b.side;
        b.side = cueSide;
        b.next = b.last + 60000 / Math.max(50, tempo);
        if (audio.current) {
          const ctx = audio.current;
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          const pan = ctx.createStereoPanner();
          pan.pan.value = b.lastSide * 0.8;
          o.frequency.value = b.lastSide === 0 ? 660 : 880;
          g.gain.setValueAtTime(0.25, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
          o.connect(g).connect(pan).connect(ctx.destination);
          o.start();
          o.stop(ctx.currentTime + 0.15);
        }
        vibrate(25);
      }
      setTick(now);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [tempo, cueSide]);
  const tap = (side: number) => {
    if (!audio.current) {
      audio.current = new AudioContext();
      audio.current.resume().catch(() => {});
    }
    const b = beat.current;
    const now = performance.now();
    const dPrev = Math.abs(now - b.last);
    const dNext = Math.abs(b.next - now);
    const dt = Math.min(dPrev, dNext);
    const targetSide = dPrev < dNext ? b.lastSide : b.side;
    const sideOk = targetSide === 0 || targetSide === side;
    const acc = Math.max(0, 1 - dt / 280) * (sideOk ? 1 : 0.25);
    send({ t: 'beat', acc });
    setScore(acc);
  };
  const b = beat.current;
  const period = 60000 / Math.max(50, tempo);
  const k = Math.max(0, Math.min(1, (b.next - tick) / period));
  const sideNext = b.side;
  return (
    <div className="control">
      <div className="hearing">
        {[-1, 1].map((side) => (
          <div key={side} className={'hearing-half' + (sideNext === side || sideNext === 0 ? ' active' : '')} onPointerDown={() => tap(side)}>
            <div className="hearing-target" />
            {(sideNext === side || sideNext === 0) && <div className="hearing-ring" style={{ transform: `scale(${1 + k * 2.2})`, opacity: 1 - k * 0.7 }} />}
            <span>{side < 0 ? 'left' : 'right'}</span>
          </div>
        ))}
      </div>
      <p className="note">{score === null ? 'tap the side of the pulse, when the ring meets the circle' : score > 0.7 ? 'clear!' : score > 0.35 ? 'almost' : 'missed'}</p>
      <Meter value={state.cue.level} label={state.role.variant ? 'home heard' : 'hearing'} red />
    </div>
  );
}

// ---------------- HEARTBEAT ----------------

export function HeartbeatControl({ state, send, setSensor }: ControlProps) {
  useEffect(() => {
    setSensor({ sensor: 'touch', state: 'active', calibrated: true });
  }, [setSensor]);
  const taps = useRef<number[]>([]);
  const [bpm, setBpm] = useState(0);
  const [steady, setSteady] = useState(0);
  const [pulse, setPulse] = useState(0);
  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 6000), now];
    send({ t: 'tap' });
    setPulse(now);
    vibrate(20);
    const ts = taps.current;
    if (ts.length >= 3) {
      const iv = ts.slice(1).map((t, i) => t - ts[i]);
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
      setBpm(Math.round(60000 / mean));
      setSteady(Math.max(0, 1 - (sd / mean) * 3));
    }
  };
  const recent = performance.now() - pulse < 150;
  return (
    <div className="control">
      <button className={'heart' + (recent ? ' beat' : '')} onPointerDown={tap}>
        ♥
      </button>
      <p className="note">{bpm ? `${bpm} bpm · ${steady > 0.7 ? 'steady' : steady > 0.4 ? 'uneven' : 'restless'}` : 'tap a calm, steady beat'}</p>
      <Meter value={state.cue.level} label="night extended" red />
    </div>
  );
}
