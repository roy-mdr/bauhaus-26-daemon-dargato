// Players, per-player sense state, input normalization and aggregation.
import { randomBytes } from 'node:crypto';
import type { PhoneInput, SensorStatus } from '../shared/protocol';
import type { ObjectiveId } from '../shared/roles';
import type { RoleRef, SenseId } from '../shared/types';
import { clamp } from '../shared/graph';

export type PlayerKind = 'phone' | 'bot' | 'sim';

export interface SenseState {
  /** continuous value: sight brightness 0..1, direction tilt -1..1, memory loudness 0..1 */
  value: number;
  valueAt: number;
  /** event-driven drive: SPEED paws 0..1, INSTINCT 0..1, HEARTBEAT tap rate (bpm) */
  drive: number;
  tapTimes: number[];
  /** token bucket for discrete events */
  bucket: number;
}

export interface Player {
  id: string;
  token: string;
  nickname: string;
  kind: PlayerKind;
  role: RoleRef;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number;
  joinedAt: number;
  lastInputAt: number;
  ping: number;
  influence: number;
  sensor?: SensorStatus;
  sense: SenseState;
  objective: { id: ObjectiveId; progress: number; done: boolean; failed: boolean };
  stats: { inputs: number; pulses: number };
  joinOrder: number;
}

export function neutralValue(sense: SenseId): number {
  return sense === 'sight' ? 0.5 : 0;
}

export function newSenseState(sense: SenseId): SenseState {
  return { value: neutralValue(sense), valueAt: 0, drive: 0, tapTimes: [], bucket: 8 };
}

let joinCounter = 0;
export function createPlayer(nickname: string, kind: PlayerKind, role: RoleRef): Player {
  return {
    id: randomBytes(4).toString('hex'),
    token: randomBytes(12).toString('hex'),
    nickname: sanitizeNickname(nickname),
    kind,
    role,
    socketId: null,
    connected: kind !== 'phone',
    disconnectedAt: 0,
    joinedAt: Date.now(),
    lastInputAt: 0,
    ping: 0,
    influence: 1,
    sense: newSenseState(role.sense),
    objective: { id: 'explore', progress: 0, done: false, failed: false },
    stats: { inputs: 0, pulses: 0 },
    joinOrder: joinCounter++,
  };
}

export function sanitizeNickname(s: string): string {
  const clean = String(s ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 16);
  return clean || 'cat-friend';
}

const finite = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return clamp(n, lo, hi);
};

/**
 * Applies one normalized phone input to a player's sense state.
 * Inputs are bounded and discrete events are rate limited (token bucket).
 * Returns true if accepted.
 */
export function applyInput(p: Player, input: PhoneInput, now: number): boolean {
  const s = p.sense;
  const sense = p.role.sense;
  const consume = (cost = 1) => {
    if (s.bucket < cost) return false;
    s.bucket -= cost;
    return true;
  };
  switch (input?.t) {
    case 'value': {
      if (sense !== 'sight' && sense !== 'direction' && sense !== 'memory') return false;
      const v = finite(input.v, sense === 'direction' ? -1 : 0, 1);
      if (v === null) return false;
      s.value = v;
      s.valueAt = now;
      break;
    }
    case 'tap': {
      if (sense !== 'heartbeat' || !consume()) return false;
      s.tapTimes.push(now);
      if (s.tapTimes.length > 8) s.tapTimes.shift();
      break;
    }
    case 'scratch':
    case 'shake': {
      if (sense !== (input.t === 'scratch' ? 'speed' : 'instinct') || !consume(0.5)) return false;
      const v = finite(input.v, 0, 1);
      if (v === null) return false;
      // the strongest recent gesture holds, then fades (see tickPlayer)
      s.drive = Math.max(s.drive, v);
      break;
    }
    default:
      return false;
  }
  p.lastInputAt = now;
  p.stats.inputs++;
  // discrete gestures (not continuous values), so the display can make them visible
  if (input.t !== 'value') p.stats.pulses++;
  return true;
}

/** a tap rate from recent tap times; it falls when the taps stop coming */
export function tapRate(times: number[], now: number): number {
  const ts = times.filter((t) => now - t < 6000).slice(-6);
  if (ts.length < 2) return 0;
  const iv = ts.slice(1).map((t, i) => t - ts[i]);
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  // waiting longer than the usual interval already slows the heart
  const interval = Math.max(mean, now - ts[ts.length - 1]);
  return 60000 / interval;
}

/** per-tick decay / integration of a player's sense state */
export function tickPlayer(p: Player, dt: number, now: number, graceSec: number): void {
  const s = p.sense;
  s.bucket = Math.min(8, s.bucket + dt * 6);
  // influence decays gradually when disconnected
  if (p.connected) p.influence = Math.min(1, p.influence + dt * 0.5);
  else p.influence *= Math.exp(-dt / 4);
  if (!p.connected && now - p.disconnectedAt > graceSec * 1000) p.influence = 0;

  const sense = p.role.sense;
  // continuous values without updates slowly relax toward neutral
  if (now - s.valueAt > 4000) s.value += (neutralValue(sense) - s.value) * Math.min(1, dt * 0.5);

  switch (sense) {
    case 'speed':
      // paws stop soon after the scratching stops
      s.drive *= Math.exp(-dt / 0.6);
      break;
    case 'instinct':
      s.drive *= Math.exp(-dt / 2.2);
      break;
    case 'heartbeat': {
      const bpm = tapRate(s.tapTimes, now);
      s.drive += (bpm - s.drive) * Math.min(1, dt * 3);
      break;
    }
  }
}

/** the player's current output channels (what gets averaged per sense) */
export function playerChannels(p: Player): Record<string, number> {
  const s = p.sense;
  switch (p.role.sense) {
    case 'sight':
      return { v: s.value };
    case 'direction':
      return { x: s.value };
    case 'memory':
      return { level: s.value };
    case 'speed':
    case 'instinct':
      return { drive: s.drive };
    case 'heartbeat':
      return { bpm: s.drive };
  }
}

/** a single number for meters on the director / debug views */
export function playerLevel(p: Player): number {
  if (p.role.sense === 'heartbeat') return clamp(p.sense.drive / 150);
  return Object.values(playerChannels(p))[0] ?? 0;
}

export function isActive(p: Player, now: number, windowMs = 8000): boolean {
  if (p.influence < 0.3) return false;
  return now - p.lastInputAt < windowMs;
}

// ---------------- simulated senses ----------------

export interface SimContext {
  /** the turn (-1..1) that would bring him along the shortest way home */
  steer: number;
  /** the pulse on the main display */
  heartBpm: number;
  /** SIGHT values in which he sees clearly right now */
  clear: [number, number];
  /** MEMORY: the loudness edge over which the paths hold together right now */
  sound: [number, number];
}

/**
 * A small autonomous "brain" that produces plausible inputs for a sense nobody
 * is playing (or for debug bots). It goes through the same applyInput path.
 */
export class SimBrain {
  private t = 0;
  private nextAction = 0;
  private target = 0;
  private active = true;
  private acc = 0;
  private wander = 0;
  constructor(
    private p: Player,
    private rnd: () => number,
    public intensity: number,
  ) {}

  think(dt: number, now: number, ctx: SimContext) {
    this.t += dt;
    const p = this.p;
    const r = this.rnd;
    const k = this.intensity;
    const ease = (to: number, rate: number) => p.sense.value + (to - p.sense.value) * Math.min(1, dt * rate);
    switch (p.role.sense) {
      case 'sight': {
        // mostly comfortable light, sometimes drifting too dark or too bright
        if (this.t > this.nextAction) {
          const drift = r() < 0.2 ? (r() < 0.5 ? -1 : 1) * 0.35 : (r() - 0.5) * 0.2;
          this.target = clamp((ctx.clear[0] + ctx.clear[1]) / 2 + drift * (0.4 + 0.6 * k));
          this.nextAction = this.t + 4 + r() * 8;
        }
        applyInput(p, { t: 'value', v: ease(this.target, 0.8) }, now);
        break;
      }
      case 'speed': {
        // scratching in bursts, with short pauses
        if (this.t > this.nextAction) {
          this.active = !this.active || r() < 0.3;
          this.nextAction = this.t + (this.active ? 6 + r() * 12 : 1 + r() * 2.5);
        }
        this.acc += dt;
        if (this.active && this.acc > 0.15) {
          this.acc = 0;
          applyInput(p, { t: 'scratch', v: clamp(0.4 + 0.35 * k + (r() - 0.5) * 0.2) }, now);
        }
        break;
      }
      case 'direction': {
        // roughly toward home, with a wandering mind
        if (this.t > this.nextAction) {
          this.wander = r() < 0.35 ? (r() - 0.5) * 1.6 : 0;
          this.nextAction = this.t + 2 + r() * 5;
        }
        const x = clamp(ctx.steer * (0.5 + 0.5 * k) + this.wander * (1 - 0.6 * k), -1, 1);
        applyInput(p, { t: 'value', v: ease(x, 2.5) }, now);
        break;
      }
      case 'memory': {
        // a steady murmur, with moments of silence when the streets come apart
        if (this.t > this.nextAction) {
          const quiet = r() < 0.18;
          this.target = quiet ? ctx.sound[0] * 0.5 : clamp(ctx.sound[1] * (0.7 + 0.3 * k) + (r() - 0.5) * 0.15);
          this.nextAction = this.t + (quiet ? 1.5 + r() * 2 : 5 + r() * 10);
        }
        applyInput(p, { t: 'value', v: ease(this.target, 1.5) }, now);
        break;
      }
      case 'instinct': {
        // now and then a shake, more often when the simulation is intense
        if (this.t > this.nextAction) {
          this.active = !this.active;
          this.nextAction = this.t + (this.active ? 1.5 + r() * 2 : (14 + r() * 20) / Math.max(0.3, k));
        }
        this.acc += dt;
        if (this.active && this.acc > 0.2) {
          this.acc = 0;
          applyInput(p, { t: 'shake', v: clamp(0.5 + 0.5 * r()) }, now);
        }
        break;
      }
      case 'heartbeat': {
        // taps along with the pulse, a little uneven
        this.acc += dt;
        const period = 60 / Math.max(30, ctx.heartBpm);
        if (this.acc > period * (0.96 + r() * 0.08)) {
          this.acc = 0;
          applyInput(p, { t: 'tap' }, now);
        }
        break;
      }
    }
  }
}
