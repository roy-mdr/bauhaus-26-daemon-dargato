import { useEffect, useRef, useState } from 'react';
import type { PhoneInput, PhoneState, SensorStatus } from '../../shared/protocol';
import { roleInfo } from '../../shared/roles';
import { CameraLuminance, MicListener, ShakeSensor, TiltSensor, vibrate, type SensorState } from './sensors';

export interface ControlProps {
  state: PhoneState;
  send: (i: PhoneInput) => void;
  sendValue: (v: number) => void;
  setSensor: (s: SensorStatus) => void;
}

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

function Meter({ value, min = 0, max = 1, label, red, band }: { value: number; min?: number; max?: number; label?: string; red?: boolean; band?: [number, number] }) {
  const k = clamp((value - min) / (max - min));
  const at = (v: number) => clamp((v - min) / (max - min)) * 100;
  const centered = min < 0;
  return (
    <div className="meter">
      {label && <span className="meter-label">{label}</span>}
      <div className="meter-track">
        {band && <div className="meter-band" style={{ left: `${at(band[0])}%`, width: `${at(band[1]) - at(band[0])}%` }} />}
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

function useTouchSensor(setSensor: ControlProps['setSensor']) {
  useEffect(() => {
    setSensor({ sensor: 'touch', state: 'active', calibrated: true });
  }, [setSensor]);
}

/** runs every animation frame with the elapsed seconds */
function useFrameLoop(fn: (dt: number) => void, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      ref.current(Math.min(0.1, (now - last) / 1000));
      last = now;
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** pointer travel on a pad, summed per ~150 ms window and sent as one gesture */
function useStroke(axis: 'down' | 'side', onWindow: (px: number) => void) {
  const st = useRef({ last: { x: 0, y: 0 }, dist: 0, sentAt: 0, dir: 0 });
  return {
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      st.current.last = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!e.buttons) return;
      const s = st.current;
      const dx = e.clientX - s.last.x;
      const dy = e.clientY - s.last.y;
      s.last = { x: e.clientX, y: e.clientY };
      // SPEED counts only strokes toward the bottom; INSTINCT counts side-to-side travel
      if (axis === 'down') s.dist += Math.max(0, dy);
      else s.dist += Math.abs(dx);
      const now = performance.now();
      if (now - s.sentAt > 150) {
        onWindow(s.dist);
        s.dist = 0;
        s.sentAt = now;
      }
    },
  };
}

function Instruction({ state, fallback }: { state: PhoneState; fallback: boolean }) {
  const info = roleInfo(state.role);
  return <p className="note">{fallback ? info.fallback : info.instruction}</p>;
}

// the light band (camera value) in which he sees clearly, matching the server's curves
const CLEAR_BAND: [number, number] = [0.3, 0.7];

// ---------------- SIGHT ----------------

export function SightControl({ state, sendValue, setSensor }: ControlProps) {
  const s = useSensor('camera', setSensor);
  const cam = useRef<CameraLuminance | null>(null);
  const [v, setV] = useState(0.5);
  const eye = useRef(0.5);
  const swipe = useRef({ y: 0, on: false });
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
  // fallback: the eye keeps closing by itself; swiping up holds it open (too much: blinding)
  useFrameLoop((dt) => {
    eye.current = clamp(eye.current - dt * 0.07);
    setV(eye.current);
    sendValue(eye.current);
  }, s.fallback);
  const open = clamp(v / 0.5);
  return (
    <div className="control">
      <div
        className="big-meter"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          swipe.current = { y: e.clientY, on: true };
        }}
        onPointerMove={(e) => {
          if (!s.fallback || !swipe.current.on) return;
          const up = swipe.current.y - e.clientY;
          swipe.current.y = e.clientY;
          if (up > 0) eye.current = clamp(eye.current + up / 600);
        }}
        onPointerUp={() => (swipe.current.on = false)}
        style={{ touchAction: 'none' }}
      >
        <div className={'eye' + (v > CLEAR_BAND[1] ? ' glare' : '')} style={{ transform: `scaleY(${0.06 + open * 0.94})`, opacity: 0.35 + Math.min(1, v * 1.5) * 0.65 }} />
      </div>
      <Meter value={v} label="dark · clear · blinding" band={CLEAR_BAND} red />
      <Instruction state={state} fallback={s.fallback} />
      {s.fallback ? (
        <p className="note">swipe up on the eye</p>
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

// ---------------- SPEED ----------------

export function SpeedControl({ state, send, setSensor }: ControlProps) {
  useTouchSensor(setSensor);
  const [scratch, setScratch] = useState(0);
  const stroke = useStroke('down', (px) => {
    // ~300 px of downward travel in 150 ms is a frantic scratch
    const v = clamp(px / 300);
    setScratch(v);
    if (v > 0.03) {
      send({ t: 'scratch', v });
      if (v > 0.5) vibrate(8);
    }
  });
  useFrameLoop((dt) => setScratch((x) => x * Math.exp(-dt * 4)));
  return (
    <div className="control">
      <div className="pad big scratch-pad" {...stroke} style={{ ['--k' as string]: scratch }}>
        <span>scratch ↓</span>
      </div>
      <Instruction state={state} fallback={false} />
      <Meter value={state.cue.level} label="his pace" red />
    </div>
  );
}

// ---------------- DIRECTION ----------------

function Joystick({ onChange }: { onChange: (x: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const update = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const v = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2 - 30), -1, 1);
    setX(v);
    onChange(v);
  };
  const release = () => {
    setX(0);
    onChange(0);
  };
  return (
    <div
      ref={ref}
      className="joystick"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => e.buttons && update(e)}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div className="joystick-knob" style={{ left: `calc(50% + ${x} * (50% - 30px))` }} />
    </div>
  );
}

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
  return (
    <div className="control">
      <div className="tilt-view">
        <span>left</span>
        <div className="tilt-track">
          <div className="tilt-dot" style={{ left: `${50 + x * 45}%` }} />
        </div>
        <span>right</span>
      </div>
      <Instruction state={state} fallback={s.fallback} />
      {s.fallback ? (
        <Joystick
          onChange={(v) => {
            setX(v);
            sendValue(v);
          }}
        />
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

// ---------------- MEMORY ----------------

export function MemoryControl({ state, sendValue, setSensor }: ControlProps) {
  const s = useSensor('microphone', setSensor);
  const mic = useRef<MicListener | null>(null);
  const [level, setLevel] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const taps = useRef<number[]>([]);
  const tapLevel = useRef(0);
  const lastSent = useRef(0);
  const enable = async () => {
    s.setState('requesting');
    const m = new MicListener();
    m.rangeDb = 40 / Math.max(0.3, state.sensitivity);
    m.onLevel = (v) => {
      const now = performance.now();
      if (now - lastSent.current > 150) {
        lastSent.current = now;
        setLevel(v);
        sendValue(v);
      }
    };
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
  // fallback: tapping makes sound; ~6 taps per second is as loud as it gets
  useFrameLoop(() => {
    const now = performance.now();
    taps.current = taps.current.filter((t) => now - t < 1500);
    const target = clamp(taps.current.length / 1.5 / 6);
    tapLevel.current += (target - tapLevel.current) * (target > tapLevel.current ? 0.3 : 0.05);
    setLevel(tapLevel.current);
    sendValue(tapLevel.current);
  }, s.fallback);
  return (
    <div className="control">
      <div className="memory-orb" style={{ transform: `scale(${0.7 + level * 0.8})`, opacity: 0.4 + level * 0.6 }} />
      <Meter value={state.cue.level} label="the paths" red />
      <Instruction state={state} fallback={s.fallback} />
      {calibrating && <p className="note">Stay quiet: listening to the room...</p>}
      {s.fallback ? (
        <button
          className="pad"
          onPointerDown={() => {
            taps.current.push(performance.now());
            vibrate(10);
          }}
        >
          tap
        </button>
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

// ---------------- INSTINCT ----------------

export function InstinctControl({ state, send, setSensor }: ControlProps) {
  const s = useSensor('motion', setSensor);
  const shake = useRef<ShakeSensor | null>(null);
  const [v, setV] = useState(0);
  const lastSent = useRef(0);
  const fire = (x: number) => {
    setV(x);
    if (x > 0.08) send({ t: 'shake', v: x });
  };
  const enable = async () => {
    s.setState('requesting');
    const sh = new ShakeSensor();
    sh.onValue = (x) => {
      const now = performance.now();
      if (now - lastSent.current > 150) {
        lastSent.current = now;
        fire(x);
      }
    };
    const r = await sh.start();
    s.setState(r);
    if (r === 'active') shake.current = sh;
    else {
      sh.stop();
      s.setFallback(true);
    }
  };
  useEffect(() => () => shake.current?.stop(), []);
  // ~400 px of side-to-side travel in 150 ms is a wild scratch
  const stroke = useStroke('side', (px) => fire(clamp(px / 400)));
  useFrameLoop((dt) => setV((x) => x * Math.exp(-dt * 3)), s.fallback);
  return (
    <div className="control">
      {s.fallback ? (
        <div className="pad big scratch-pad side" {...stroke} style={{ ['--k' as string]: v }}>
          <span>← scratch →</span>
        </div>
      ) : (
        <div className="memory-orb red" style={{ transform: `scale(${0.7 + v * 0.8}) rotate(${v * 25}deg)` }} />
      )}
      <Meter value={state.cue.level} label="the way home" red />
      <Instruction state={state} fallback={s.fallback} />
      {!s.fallback && s.state !== 'active' && (
        <button className="primary" onClick={enable}>
          Wake his instinct (motion sensor)
        </button>
      )}
      <SensorBar label="motion" state={s.state} fallback={s.fallback} onEnable={enable} onFallback={() => s.setFallback(!s.fallback)} />
    </div>
  );
}

// ---------------- HEARTBEAT ----------------

export function HeartbeatControl({ state, send, setSensor }: ControlProps) {
  useTouchSensor(setSensor);
  const [pulse, setPulse] = useState(0);
  const [beat, setBeat] = useState(0);
  const t0 = useRef(performance.now());
  // the same tempo as the pulse on the big screen (only the rate matters, not the phase)
  useFrameLoop(() => {
    const ph = (((performance.now() - t0.current) / 1000) * state.cue.tempo) / 60;
    setBeat(Math.pow(Math.max(0, Math.cos((ph % 1) * Math.PI * 2)), 12));
  });
  const tap = () => {
    send({ t: 'tap' });
    setPulse(performance.now());
    vibrate(20);
  };
  const recent = performance.now() - pulse < 150;
  const h = state.cue.level;
  return (
    <div className="control">
      <button className={'heart' + (recent ? ' beat' : '')} onPointerDown={tap}>
        ♥
      </button>
      <div className="row center">
        <span className="pulse-dot" style={{ opacity: 0.25 + beat * 0.75, transform: `scale(${1 + beat * 0.4})` }} />
        <span className="note">the pulse · {state.cue.tempo} bpm</span>
      </div>
      <Meter value={h} min={-1} max={1} label="too slow · on the beat · too fast" band={[-0.3, 0.3]} red />
      <Instruction state={state} fallback={false} />
    </div>
  );
}
