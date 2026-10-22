// Players, per-player sense state, input normalization and aggregation.
import { randomBytes } from 'node:crypto';
import type { PhoneInput, SensorStatus } from '../shared/protocol';
import type { ObjectiveId } from '../shared/roles';
import { roleKey } from '../shared/roles';
import type { RoleRef, SenseId } from '../shared/types';
import { clamp } from '../shared/graph';

export type PlayerKind = 'phone' | 'bot' | 'sim';

export interface SenseState {
  /** continuous value: vision luminance 0..1, tilt -1..1, mic level 0..1 */
  value: number;
  valueAt: number;
  /** event-driven drive: instinct / restraint energy, hearing acuity, heartbeat quality, rest */
  drive: number;
  scratch: number;
  hold: boolean;
  holdSince: number;
  calm: number;
  curiosityPulse: number;
  cautionPulse: number;
  tapTimes: number[];
  /** token bucket for discrete events */
  bucket: number;
  pendingOnsets: { v: number; rhythm: boolean }[];
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
  stats: { inputs: number; decisive: number; memories: number; pulses: number };
  joinOrder: number;
}

export function neutralValue(sense: SenseId): number {
  return sense === 'vision' ? 0.5 : sense === 'direction' ? 0 : sense === 'memory' ? 0.2 : 0;
}

export function newSenseState(sense: SenseId): SenseState {
  return {
    value: neutralValue(sense),
    valueAt: 0,
    drive: sense === 'hearing' ? 0.25 : 0,
    scratch: 0,
    hold: false,
    holdSince: 0,
    calm: 0,
    curiosityPulse: 0,
    cautionPulse: 0,
    tapTimes: [],
    bucket: 8,
    pendingOnsets: [],
  };
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
    objective: { id: 'reveal-hints', progress: 0, done: false, failed: false },
    stats: { inputs: 0, decisive: 0, memories: 0, pulses: 0 },
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
 * Inputs are bounded and discrete events are rate limited (token bucket) so
 * unlimited tapping is not rewarded. Returns true if accepted.
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
      const lo = sense === 'direction' ? -1 : 0;
      const v = finite(input.v, lo, 1);
      if (v === null) return false;
      s.value = v;
      s.valueAt = now;
      break;
    }
    case 'tap': {
      if (!consume()) return false;
      s.tapTimes.push(now);
      if (s.tapTimes.length > 8) s.tapTimes.shift();
      if (sense === 'instinct') s.drive += 0.2 * (1 - s.drive);
      break;
    }
    case 'scratch': {
      if (sense !== 'instinct' || !consume(2)) return false;
      const v = finite(input.v, 0, 1);
      if (v === null) return false;
      s.scratch = Math.max(s.scratch, v);
      s.drive += 0.25 * v * (1 - s.drive);
      break;
    }
    case 'hold': {
      const on = !!input.on;
      if (on === s.hold) return true;
      if (on) s.holdSince = now;
      else if (sense === 'emotion' && !p.role.variant) {
        // releasing after holding encourages curiosity, more so after a long hold
        const held = (now - s.holdSince) / 1000;
        s.curiosityPulse = Math.max(s.curiosityPulse, clamp(0.45 + held / 6, 0.45, 1));
      }
      s.hold = on;
      break;
    }
    case 'flinch': {
      if (!consume(2)) return false;
      s.cautionPulse = 1;
      break;
    }
    case 'beat': {
      if (sense !== 'hearing' || !consume()) return false;
      const acc = finite(input.acc, 0, 1);
      if (acc === null) return false;
      s.drive = s.drive * 0.72 + acc * 0.28;
      break;
    }
    case 'onset': {
      if (sense !== 'memory' || !consume(2)) return false;
      const v = finite(input.v, 0, 1);
      if (v === null) return false;
      s.pendingOnsets.push({ v, rhythm: false });
      break;
    }
    case 'rhythm': {
      if (sense !== 'memory' || !consume(3)) return false;
      const reg = finite(input.reg, 0, 1);
      if (reg === null) return false;
      s.pendingOnsets.push({ v: 0.6 + 0.4 * reg, rhythm: true });
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
    case 'instinct':
      if (p.role.variant) {
        // restraint: taps hold him back
        const recent = s.tapTimes.filter((t) => now - t < 1500).length;
        s.drive += (clamp(recent / 5) - s.drive) * Math.min(1, dt * 2);
      } else {
        s.drive *= Math.exp(-dt / 1.6);
      }
      s.scratch *= Math.exp(-dt / 0.8);
      break;
    case 'hearing':
      // acuity fades without accurate beats
      if (now - p.lastInputAt > 2500) s.drive += (0.15 - s.drive) * Math.min(1, dt * 0.25);
      break;
    case 'heartbeat': {
      // steady rhythm (regular intervals, 40-150 bpm) -> quality
      const ts = s.tapTimes.filter((t) => now - t < 6000);
      let q = 0;
      if (ts.length >= 4 && now - ts[ts.length - 1] < 2000) {
        const iv = ts.slice(1).map((t, i) => t - ts[i]);
        const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
        const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
        const bpm = 60000 / mean;
        if (bpm >= 40 && bpm <= 150) q = clamp(1 - (sd / mean) * 3);
      }
      s.drive += (q - s.drive) * Math.min(1, dt * 1.5);
      break;
    }
    case 'emotion':
      if (p.role.variant) {
        s.drive += ((s.hold ? 1 : 0) - s.drive) * Math.min(1, dt * (s.hold ? 1.2 : 2));
      } else {
        s.calm += ((s.hold ? 1 : 0) - s.calm) * Math.min(1, dt * (s.hold ? 0.45 : 0.8));
        s.curiosityPulse *= Math.exp(-dt / 7);
        s.cautionPulse *= Math.exp(-dt / 6);
      }
      break;
  }
}

/** the player's current output channels (what gets averaged per role) */
export function playerChannels(p: Player): Record<string, number> {
  const s = p.sense;
  switch (roleKey(p.role)) {
    case 'vision':
    case 'vision-b':
      return { v: s.value };
    case 'direction':
    case 'direction-b':
      return { x: s.value };
    case 'instinct':
      return { drive: s.drive, scratch: s.scratch };
    case 'instinct-b':
      return { drive: s.drive };
    case 'emotion':
      return { calm: s.calm, curiosity: s.curiosityPulse, caution: s.cautionPulse };
    case 'emotion-b':
      return { rest: s.drive };
    case 'hearing':
    case 'hearing-b':
      return { acuity: s.drive };
    case 'memory':
    case 'memory-b':
      return { level: s.value };
    case 'heartbeat':
    case 'heartbeat-b':
      return { quality: s.drive };
  }
  return {};
}

/** a single number for meters on the director / debug views */
export function playerLevel(p: Player): number {
  const ch = playerChannels(p);
  if ('v' in ch) return ch.v;
  if ('x' in ch) return ch.x;
  if ('calm' in ch) return Math.max(ch.calm, ch.curiosity, ch.caution);
  const vals = Object.values(ch);
  return vals.length ? vals[0] : 0;
}

export function isActive(p: Player, now: number, windowMs = 8000): boolean {
  if (p.influence < 0.3) return false;
  if (now - p.lastInputAt < windowMs) return true;
  const s = p.sense;
  if (p.role.sense === 'direction') return Math.abs(s.value) > 0.25;
  if (p.role.sense === 'vision') return Math.abs(s.value - 0.5) > 0.15;
  return s.hold;
}

// ---------- simulated senses ----------

/**
 * A small autonomous "brain" that produces plausible inputs for a sense nobody
 * is playing (or for debug bots). It goes through the same applyInput path.
 */
export class SimBrain {
  private t = 0;
  private nextAction = 0;
  private target = 0;
  private holdUntil = 0;
  private beatPhase = 0;
  constructor(
    private p: Player,
    private rnd: () => number,
    public intensity: number,
  ) {}

  think(dt: number, now: number, ctx: { approaching: boolean; hesitating: boolean }) {
    this.t += dt;
    const p = this.p;
    const r = this.rnd;
    const k = this.intensity;
    switch (p.role.sense) {
      case 'vision': {
        if (this.t > this.nextAction) {
          this.target = 0.5 + (r() - 0.35) * 0.6 * k;
          this.nextAction = this.t + 4 + r() * 8;
        }
        const v = p.sense.value + (this.target - p.sense.value) * Math.min(1, dt * 0.8);
        applyInput(p, { t: 'value', v }, now);
        break;
      }
      case 'direction': {
        if ((ctx.approaching || ctx.hesitating) && this.t > this.nextAction) {
          this.target = r() < 0.45 ? 0 : (r() < 0.5 ? -1 : 1) * (0.4 + r() * 0.6) * k;
          this.nextAction = this.t + 3 + r() * 4;
        } else if (!ctx.approaching && !ctx.hesitating && this.t > this.nextAction) {
          this.target = 0;
        }
        const v = p.sense.value + (this.target - p.sense.value) * Math.min(1, dt * 2);
        applyInput(p, { t: 'value', v }, now);
        break;
      }
      case 'instinct': {
        if (p.role.variant) {
          if (r() < dt * 0.4 * k) applyInput(p, { t: 'tap' }, now);
        } else if (r() < dt * (0.6 + 1.2 * k) * (Math.sin(this.t * 0.2) > 0 ? 1 : 0.25)) {
          applyInput(p, { t: 'tap' }, now);
        }
        break;
      }
      case 'emotion': {
        if (this.t > this.nextAction) {
          if (p.sense.hold) applyInput(p, { t: 'hold', on: false }, now);
          else if (r() < 0.6) {
            applyInput(p, { t: 'hold', on: true }, now);
            this.holdUntil = this.t + 2 + r() * 6;
          } else if (r() < 0.25 * k) applyInput(p, { t: 'flinch' }, now);
          this.nextAction = this.t + 5 + r() * 10;
        }
        if (p.sense.hold && this.t > this.holdUntil) applyInput(p, { t: 'hold', on: false }, now);
        break;
      }
      case 'hearing': {
        this.beatPhase += dt;
        if (this.beatPhase > 0.75) {
          this.beatPhase = 0;
          if (r() < 0.5 + 0.3 * k) applyInput(p, { t: 'beat', acc: clamp(0.3 + r() * 0.6 * k + 0.1) }, now);
        }
        break;
      }
      case 'memory': {
        if (this.t > this.nextAction) {
          if (this.t > 15) applyInput(p, r() < 0.3 ? { t: 'rhythm', bpm: 100, reg: 0.8 } : { t: 'onset', v: 0.7 }, now);
          this.nextAction = this.t + 25 + r() * 35 / Math.max(0.3, k);
        }
        applyInput(p, { t: 'value', v: clamp(0.2 + 0.15 * Math.sin(this.t * 0.3) + r() * 0.05) }, now);
        break;
      }
      case 'heartbeat': {
        this.beatPhase += dt;
        if (this.beatPhase > 0.85 + r() * 0.05) {
          this.beatPhase = 0;
          applyInput(p, { t: 'tap' }, now);
        }
        break;
      }
    }
  }
}
