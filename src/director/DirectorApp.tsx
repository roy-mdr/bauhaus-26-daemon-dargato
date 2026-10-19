import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { SessionConfig } from '../../shared/config';
import type { DirectorCommand, DirectorState } from '../../shared/protocol';
import { SENSE_ORDER, roleInfo } from '../../shared/roles';
import type { SenseId, World } from '../../shared/types';
import { connect, hello } from '../net';
import { MapView } from './MapView';

const KEY = 'dargato:directorKey';

export function useDirectorSocket(kind: 'director' | 'debug') {
  const [key, setKey] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState('');
  const [world, setWorld] = useState<World | null>(null);
  const [state, setState] = useState<DirectorState | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  useEffect(() => {
    const socket = connect();
    socketRef.current = socket;
    socket.on('connect', async () => {
      setConnected(true);
      const r = await hello(socket, kind, key || undefined);
      if (!r.ok) {
        setError(r.error ?? 'refused');
        setAuthed(false);
      } else {
        setError('');
        setAuthed(kind === 'director' ? true : !!r.authed);
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('world', (w: World) => setWorld(w));
    socket.on('dir', (s: DirectorState) => setState(s));
    return () => {
      socket.disconnect();
    };
  }, [key, kind]);
  const login = (k: string) => {
    try {
      localStorage.setItem(KEY, k);
    } catch {
      /* ignore */
    }
    setKey(k);
  };
  const cmd = (c: DirectorCommand) => socketRef.current?.emit('cmd', c);
  return { key, login, authed, error, world, state, connected, cmd, socket: socketRef };
}

function Num({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="num">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <em>{Number.isInteger(step) ? value : value.toFixed(step < 0.01 ? 3 : 2)}</em>
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Bar({ label, value, min = 0, max = 1 }: { label: string; value: number; min?: number; max?: number }) {
  const k = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return (
    <div className="bar">
      <span>{label}</span>
      <div>
        <i style={{ width: `${k * 100}%` }} />
      </div>
      <em>{value.toFixed(2)}</em>
    </div>
  );
}

export default function DirectorApp() {
  const d = useDirectorSocket('director');
  const [keyInput, setKeyInput] = useState(d.key);
  const [seed, setSeed] = useState('');
  const [overlay, setOverlay] = useState(false);
  const [botCount, setBotCount] = useState(0);
  const s = d.state;
  const cfg = s?.config;
  const patch = (p: Partial<SessionConfig>) => d.cmd({ c: 'config', patch: p });

  if (!d.authed)
    return (
      <div className="panel login">
        <h1>DARGATO · director</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            d.login(keyInput);
          }}
        >
          <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="director key" autoFocus />
          <button type="submit">enter</button>
        </form>
        {d.error && <p className="error">{d.error}</p>}
        <p className="dim">The key is printed in the server console (default: dargato, set DIRECTOR_KEY).</p>
      </div>
    );

  const fmtT = (t: number) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(t) / 60)}:${String(Math.floor(Math.abs(t) % 60)).padStart(2, '0')}`;

  return (
    <div className="panel director">
      <header>
        <h1>DARGATO · director</h1>
        <span className={'dot' + (d.connected ? ' on' : '')} />
        {s && (
          <span className="status">
            code <b>{s.code}</b> · {s.phase}
            {s.paused ? ' (paused)' : ''} · journey {fmtT(s.journeyT)} · soft limit in {fmtT(s.remaining)} · night ends in {fmtT(s.hardRemaining)} {s.extension > 1 ? `(+${Math.round(s.extension)}s heartbeat)` : ''}
          </span>
        )}
      </header>

      <div className="cols">
        <section className="col">
          <h2>Session</h2>
          <div className="buttons">
            <button className="primary" onClick={() => d.cmd({ c: 'start' })} disabled={s?.phase !== 'lobby'}>
              Start journey
            </button>
            {s?.paused ? <button onClick={() => d.cmd({ c: 'resume' })}>Resume</button> : <button onClick={() => d.cmd({ c: 'pause' })}>Pause</button>}
            <button onClick={() => d.cmd({ c: 'reset' })}>Reset to lobby</button>
            <button onClick={() => confirm('Create a new session? Phones must re-join with the new code.') && d.cmd({ c: 'newSession' })}>New session</button>
          </div>
          <div className="buttons">
            <button onClick={() => d.cmd({ c: 'ending', kind: 'home' })}>Test ending: home</button>
            <button onClick={() => d.cmd({ c: 'ending', kind: 'sleep' })}>Test ending: sleep</button>
          </div>

          <h2>World</h2>
          <div className="row">
            <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder={d.world?.seed ?? 'seed'} />
            <button onClick={() => seed.trim() && d.cmd({ c: 'setSeed', seed: seed.trim() })}>Set seed</button>
            <button onClick={() => d.cmd({ c: 'regenerate' })}>Random</button>
          </div>
          {cfg && <Toggle label="keep seed between journeys" value={cfg.lockSeed} onChange={(v) => patch({ lockSeed: v })} />}
          {d.world && (
            <>
              <MapView world={d.world} state={s} onNode={(id) => confirm(`Move Dargato to node ${id}?`) && d.cmd({ c: 'teleport', node: id })} />
              <p className="dim small">
                seed <b>{d.world.seed}</b> · {d.world.stats.nodes} nodes · {d.world.stats.edges} streets · {d.world.stats.loops} loops · {d.world.stats.deadEnds} dead ends · {d.world.stats.alleys} alleys · {d.world.stats.paths} paths ·{' '}
                {d.world.stats.curved} curved · {d.world.stats.plazas} squares · {d.world.stats.tJunctions} T · {d.world.stats.crossroads} crossroads · shortest {d.world.stats.shortestPathLength}u · est. {fmtT(d.world.stats.estDurationSec)}
              </p>
              <p className="dim small">click a node to move Dargato there · red dashed: instinct route · blue: options being weighed</p>
            </>
          )}
        </section>

        <section className="col">
          <h2>Triggers</h2>
          <div className="buttons">
            <button onClick={() => d.cmd({ c: 'hint' })}>Route hint</button>
            <button onClick={() => d.cmd({ c: 'memory' })}>Memory event</button>
            <button onClick={() => d.cmd({ c: 'event', kind: 'distant-red-light' })}>Red light</button>
            <button onClick={() => d.cmd({ c: 'event', kind: 'red-balloon' })}>Red balloon</button>
            <button onClick={() => d.cmd({ c: 'event', kind: 'home-chorus' })}>Cats calling</button>
            <button onClick={() => d.cmd({ c: 'event', kind: 'startle' })}>Startle</button>
          </div>
          <Toggle
            label="debug overlay on main display"
            value={overlay}
            onChange={(v) => {
              setOverlay(v);
              d.cmd({ c: 'debugOverlay', on: v });
            }}
          />

          {cfg && (
            <>
              <h2>Atmosphere & pacing</h2>
              <Num label="fog" value={cfg.fogDensity} min={0} max={0.06} step={0.001} onChange={(v) => patch({ fogDensity: v })} />
              <Num label="light" value={cfg.lightIntensity} min={0.2} max={2} step={0.05} onChange={(v) => patch({ lightIntensity: v })} />
              <Num label="hint visibility" value={cfg.hintVisibility} min={0} max={2.5} step={0.05} onChange={(v) => patch({ hintVisibility: v })} />
              <Num label="cat speed" value={cfg.catSpeed} min={0.8} max={5} step={0.1} onChange={(v) => patch({ catSpeed: v })} />
              <Num label="soft limit (s)" value={cfg.maxDurationSec} min={120} max={900} step={10} onChange={(v) => patch({ maxDurationSec: v })} />
              <Num label="final grace (s)" value={cfg.finalGraceSec} min={0} max={300} step={10} onChange={(v) => patch({ finalGraceSec: v })} />
              <Num label="max heartbeat bonus (s)" value={cfg.maxHeartbeatExtensionSec} min={0} max={400} step={10} onChange={(v) => patch({ maxHeartbeatExtensionSec: v })} />
              <Num label="summary (s)" value={cfg.summarySec} min={5} max={120} step={5} onChange={(v) => patch({ summarySec: v })} />
              <Toggle label="whispered text lines" value={cfg.whispers} onChange={(v) => patch({ whispers: v })} />

              <h2>Senses</h2>
              {SENSE_ORDER.map((sense) => (
                <Num key={sense} label={`${sense} sensitivity`} value={cfg.sensitivity[sense]} min={0} max={2.5} step={0.05} onChange={(v) => d.cmd({ c: 'config', patch: { sensitivity: { ...cfg.sensitivity, [sense]: v } } })} />
              ))}
              <Toggle label="simulate senses nobody plays" value={cfg.simulateMissing} onChange={(v) => patch({ simulateMissing: v })} />
              <Num label="simulation intensity" value={cfg.simIntensity} min={0} max={1} step={0.05} onChange={(v) => patch({ simIntensity: v })} />
              <label className="num">
                <span>players 8+</span>
                <select value={cfg.extraPlayerMode} onChange={(e) => patch({ extraPlayerMode: e.target.value as 'variant' | 'average' })}>
                  <option value="variant">role variants (then averaged repeats)</option>
                  <option value="average">repeat senses, average inputs</option>
                </select>
              </label>
              <Toggle label="reshuffle roles each journey" value={cfg.reshuffleRoles} onChange={(v) => patch({ reshuffleRoles: v })} />
              <Toggle label="auto start" value={cfg.autoStart} onChange={(v) => patch({ autoStart: v })} />
              {cfg.autoStart && (
                <>
                  <Num label="auto start delay (s)" value={cfg.autoStartDelaySec} min={5} max={180} step={5} onChange={(v) => patch({ autoStartDelaySec: v })} />
                  <Num label="min players" value={cfg.autoStartMinPlayers} min={1} max={10} step={1} onChange={(v) => patch({ autoStartMinPlayers: v })} />
                </>
              )}
              <Toggle label="keyboard controls on main display" value={cfg.displayKeyboard} onChange={(v) => patch({ displayKeyboard: v })} />
            </>
          )}
        </section>

        <section className="col">
          <h2>Players</h2>
          <div className="row">
            <span className="dim small">test bots</span>
            <input type="number" min={0} max={16} value={botCount} onChange={(e) => setBotCount(Number(e.target.value))} style={{ width: 60 }} />
            <button onClick={() => d.cmd({ c: 'bots', count: botCount })}>set</button>
          </div>
          <table className="players">
            <tbody>
              {(s?.players ?? []).map((p) => (
                <tr key={p.id} className={p.connected ? '' : 'off'}>
                  <td>
                    {p.nickname}
                    {p.sim ? <i> sim</i> : ''}
                  </td>
                  <td>
                    {p.id.startsWith('sim-') ? (
                      p.roleName
                    ) : (
                      <select
                        value={`${p.role.sense}${p.role.variant ? '-b' : ''}`}
                        onChange={(e) => {
                          const [sense, b] = e.target.value.split('-');
                          d.cmd({ c: 'reassign', playerId: p.id, sense: sense as SenseId, variant: b === 'b' });
                        }}
                      >
                        {SENSE_ORDER.flatMap((sn) => (sn === 'heartbeat' ? [[sn, false]] : [[sn, false], [sn, true]]) as [SenseId, boolean][]).map(([sn, v]) => (
                          <option key={sn + v} value={`${sn}${v ? '-b' : ''}`}>
                            {roleInfo({ sense: sn, variant: v }).name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="small">{p.connected ? (p.ping ? `${p.ping}ms` : '') : 'away'}</td>
                  <td>
                    <div className="mini">
                      <i style={{ width: `${Math.min(100, Math.abs(p.level) * 100)}%` }} />
                    </div>
                  </td>
                  <td className="small">{p.sensor ? `${p.sensor.sensor}:${p.sensor.state}` : ''}</td>
                  <td className="small">{p.objective ? `${p.objective.done ? '✓ ' : ''}${p.objective.text}` : ''}</td>
                  <td>{!p.id.startsWith('sim-') && <button className="small" onClick={() => d.cmd({ c: 'kick', playerId: p.id })}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {s && (
            <>
              <h2>Dargato</h2>
              <p className="small">
                state <b>{s.cat.state}</b> · node {s.cat.node} · edge {s.cat.edge} · {s.diagnostics.distanceToHome}u from home (best {s.diagnostics.bestDistanceToHome}) · progress {(s.diagnostics.progress * 100).toFixed(0)}% · decisions {s.diagnostics.decisions} · detours {s.diagnostics.detours}
              </p>
              <div className="bars">
                {Object.entries(s.inner).map(([k, v]) => (
                  <Bar key={k} label={k} value={v as number} min={k === 'direction' || k === 'explore' ? -1 : 0} max={k === 'homeward' ? 4 : k === 'redGain' || k === 'soundGain' ? 2 : 1} />
                ))}
              </div>
              {s.options.length > 0 && (
                <>
                  <h3>Route preferences now</h3>
                  <OptionsTable options={s.options} />
                </>
              )}
              <h3>Recent decisions</h3>
              <table className="decisions small">
                <tbody>
                  {[...s.lastDecisions].reverse().map((dd, i) => (
                    <tr key={i}>
                      <td>n{dd.node}→e{dd.chosen}</td>
                      <td>tipped by {dd.decisive}</td>
                      <td>margin {dd.margin.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Diagnostics</h3>
              <p className="small dim">
                tick {s.diagnostics.tickMs}ms · displays {s.diagnostics.clients.displays} · phones {s.diagnostics.clients.phones} · directors {s.diagnostics.clients.directors} · debug {s.diagnostics.clients.debug} · uptime {fmtT(s.diagnostics.uptimeSec)}
              </p>
              <h3>Events</h3>
              <ul className="events small">
                {[...s.events].reverse().map((e) => (
                  <li key={e.id}>
                    {e.kind} {e.text ? `"${e.text}"` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function OptionsTable({ options }: { options: DirectorState['options'] }) {
  return (
    <table className="options small">
      <thead>
        <tr>
          <th>street</th>
          <th>turn</th>
          <th>total</th>
          <th>terms</th>
        </tr>
      </thead>
      <tbody>
        {options.map((o, i) => (
          <tr key={o.edgeId} className={i === 0 ? 'lead' : ''}>
            <td>e{o.edgeId}</td>
            <td>{o.turn > 0.5 ? 'left' : o.turn < -0.5 ? 'right' : 'ahead'}</td>
            <td>{o.total.toFixed(2)}</td>
            <td>
              {Object.entries(o.terms)
                .filter(([, v]) => Math.abs(v) > 0.02)
                .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v.toFixed(2)}`)
                .join(' · ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
