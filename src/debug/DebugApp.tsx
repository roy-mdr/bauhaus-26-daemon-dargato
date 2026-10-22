// /debug: test sensors on this device, watch every phone's live inputs,
// spawn bots, and verify the world generator.
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/protocol';
import { graphFingerprint } from '../../shared/graph';
import { generateWorld, validateWorld } from '../../shared/worldgen';
import { Bar, useDirectorSocket } from '../director/DirectorApp';
import { MapView } from '../director/MapView';
import { CameraLuminance, MicListener, ShakeSensor, TiltSensor, keepAwake, secureContext, vibrate } from '../phone/sensors';

export default function DebugApp() {
  const d = useDirectorSocket('debug');
  const [keyInput, setKeyInput] = useState(d.key);
  const [bots, setBots] = useState(4);
  const snapRate = useSnapRate(d.socket.current);
  const s = d.state;
  return (
    <div className="panel debug">
      <header>
        <h1>DARGATO · debug</h1>
        <span className={'dot' + (d.connected ? ' on' : '')} />
        <span className="status">
          {s ? (
            <>
              code <b>{s.code}</b> · {s.phase} · snapshots {snapRate.hz.toFixed(1)}/s · tick {s.diagnostics.tickMs}ms
            </>
          ) : (
            'waiting for server state...'
          )}
        </span>
      </header>
      <div className="cols">
        <section className="col">
          <h2>This device</h2>
          <DeviceTests />
          <h2>Join links</h2>
          {s && (
            <p className="small">
              <a href={`/join?c=${s.code}`} target="_blank" rel="noreferrer">
                open a phone controller in a new tab
              </a>{' '}
              · <a href="/" target="_blank" rel="noreferrer">main display</a> · <a href="/director" target="_blank" rel="noreferrer">director</a>
            </p>
          )}
          <h2>Bots</h2>
          {d.authed ? (
            <div className="row">
              <input type="number" min={0} max={16} value={bots} onChange={(e) => setBots(Number(e.target.value))} style={{ width: 60 }} />
              <button onClick={() => d.cmd({ c: 'bots', count: bots })}>spawn / set bots</button>
              <button onClick={() => d.cmd({ c: 'start' })}>start</button>
              <button onClick={() => d.cmd({ c: 'reset' })}>reset</button>
            </div>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                d.login(keyInput);
              }}
            >
              <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="director key (for bots)" />
              <button type="submit">unlock</button>
            </form>
          )}
          <p className="dim small">Bots take real role slots (useful to test 6-10 players from one computer). Run `npm run bots -- 8` for socket-level phone bots.</p>
          <h2>World generator</h2>
          <GenTest />
        </section>

        <section className="col wide">
          <h2>Live phones</h2>
          <table className="players">
            <thead>
              <tr>
                <th>name</th>
                <th>role</th>
                <th>link</th>
                <th>ping</th>
                <th>last input</th>
                <th>sensor</th>
                <th>value</th>
                <th>influence</th>
              </tr>
            </thead>
            <tbody>
              {(s?.players ?? []).map((p) => (
                <tr key={p.id} className={p.connected ? '' : 'off'}>
                  <td>
                    {p.nickname}
                    {p.sim ? <i> sim</i> : ''}
                  </td>
                  <td>{p.roleName}</td>
                  <td>{p.connected ? 'online' : 'away'}</td>
                  <td>{p.ping ? `${p.ping}ms` : '-'}</td>
                  <td>{p.lastInputAgo !== undefined && p.lastInputAgo >= 0 ? `${p.lastInputAgo}s` : '-'}</td>
                  <td>{p.sensor ? `${p.sensor.sensor} ${p.sensor.state}${p.sensor.calibrated ? ' ✓cal' : ''}` : '-'}</td>
                  <td style={{ minWidth: 120 }}>
                    <Bar label="" value={p.level} min={p.role.sense === 'direction' ? -1 : 0} />
                  </td>
                  <td>{p.influence.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s && (
            <>
              <h2>Aggregated influences (server)</h2>
              <div className="bars">
                {Object.entries(s.aggregated).map(([k, v]) => (
                  <Bar key={k} label={k} value={v} min={k === 'turn' ? -1 : 0} max={k === 'heartRate' ? 160 : 1} />
                ))}
              </div>
              <h2>Cat</h2>
              <p className="small">
                {s.cat.state} · ({s.cat.x.toFixed(1)}, {s.cat.z.toFixed(1)}) · speed {s.cat.speed.toFixed(2)} · {s.diagnostics.distanceToHome}u to home
              </p>
              {d.world && <MapView world={d.world} state={s} />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function useSnapRate(socket: ReturnType<typeof useDirectorSocket>['socket']['current']) {
  const [hz, setHz] = useState(0);
  const count = useRef(0);
  useEffect(() => {
    if (!socket) return;
    const on = (_: Snapshot) => count.current++;
    socket.on('snap', on);
    const t = setInterval(() => {
      setHz(count.current / 2);
      count.current = 0;
    }, 2000);
    return () => {
      socket.off('snap', on);
      clearInterval(t);
    };
  }, [socket]);
  return { hz };
}

function DeviceTests() {
  const [cam, setCam] = useState<string>('-');
  const [mic, setMic] = useState<string>('-');
  const [tilt, setTilt] = useState<string>('-');
  const [shake, setShake] = useState<string>('-');
  const [wake, setWake] = useState('-');
  const refs = useRef<{ cam?: CameraLuminance; mic?: MicListener; tilt?: TiltSensor; shake?: ShakeSensor }>({});
  useEffect(
    () => () => {
      refs.current.cam?.stop();
      refs.current.mic?.stop();
      refs.current.tilt?.stop();
      refs.current.shake?.stop();
    },
    [],
  );
  return (
    <div className="device-tests small">
      <p>
        secure context (HTTPS): <b>{secureContext ? 'yes' : 'NO - sensors will be blocked except on localhost'}</b>
      </p>
      <p className="dim">{navigator.userAgent}</p>
      <div className="row">
        <button
          onClick={async () => {
            const c = new CameraLuminance();
            c.onValue = (v) => setCam(`luminance raw ${c.raw.toFixed(3)} · normalized ${v.toFixed(3)}`);
            const r = await c.start();
            setCam(r);
            refs.current.cam = c;
          }}
        >
          test camera
        </button>
        <span>{cam}</span>
      </div>
      <div className="row">
        <button
          onClick={async () => {
            const m = new MicListener();
            m.onLevel = (v) => setMic(`level ${v.toFixed(3)} · floor ${m.floorDb.toFixed(1)} dB${m.isCalibrating ? ' (calibrating)' : ''}`);
            const r = await m.start();
            setMic(r);
            refs.current.mic = m;
          }}
        >
          test microphone
        </button>
        <span>{mic}</span>
      </div>
      <div className="row">
        <button
          onClick={async () => {
            const t = new TiltSensor();
            t.onValue = (v) => setTilt(`tilt ${t.gamma.toFixed(1)}° · normalized ${v.toFixed(2)}`);
            const r = await t.start();
            if (r !== 'active') setTilt(r);
            refs.current.tilt = t;
          }}
        >
          test motion
        </button>
        <span>{tilt}</span>
      </div>
      <div className="row">
        <button
          onClick={async () => {
            const sh = new ShakeSensor();
            sh.onValue = (v) => setShake(`shake ${v.toFixed(2)}`);
            const r = await sh.start();
            if (r !== 'active') setShake(r);
            refs.current.shake = sh;
          }}
        >
          test shaking
        </button>
        <span>{shake}</span>
      </div>
      <div className="row">
        <button onClick={() => vibrate([60, 60, 60])}>test vibration</button>
        <button
          onClick={async () => {
            await keepAwake();
            setWake('requested');
          }}
        >
          test wake lock
        </button>
        <span>{wake}</span>
      </div>
    </div>
  );
}

function GenTest() {
  const [out, setOut] = useState<string[]>([]);
  const [n, setN] = useState(30);
  const run = () => {
    const lines: string[] = [];
    let fails = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const seed = `debug-${i}`;
      const w = generateWorld(seed);
      const same = graphFingerprint(w) === graphFingerprint(generateWorld(seed));
      const v = validateWorld(w);
      if (v || !same) fails++;
      if (i < 8 || v || !same) lines.push(`${seed}: ${graphFingerprint(w)} ${v ?? 'ok'}${same ? '' : ' NON-DETERMINISTIC'} · ${w.stats.nodes}n ${w.stats.loops} loops · est ${w.stats.estDurationSec}s`);
    }
    lines.push(`${n} worlds, ${fails} failures, ${((performance.now() - t0) / (n * 2)).toFixed(1)} ms per world`);
    setOut(lines);
  };
  return (
    <div className="small">
      <div className="row">
        <input type="number" min={1} max={500} value={n} onChange={(e) => setN(Number(e.target.value))} style={{ width: 70 }} />
        <button onClick={run}>generate & validate seeds</button>
      </div>
      <pre>{out.join('\n')}</pre>
    </div>
  );
}
