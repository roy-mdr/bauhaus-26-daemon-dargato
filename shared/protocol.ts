// Messages between server, main display, phones, director and debug clients.
import type { SessionConfig } from './config';
import type { CatInternals, CatState, Hint, OptionScore, Phase, RoleRef, SenseId, World, WorldEvent } from './types';

/** normalized phone input; raw sensor data never leaves the phone */
export type PhoneInput =
  | { t: 'value'; v: number }
  | { t: 'tap' }
  | { t: 'scratch'; v: number }
  | { t: 'hold'; on: boolean }
  | { t: 'flinch' }
  | { t: 'beat'; acc: number }
  | { t: 'onset'; v: number }
  | { t: 'rhythm'; bpm: number; reg: number };

export interface SensorStatus {
  sensor: string;
  state: 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported' | 'fallback';
  calibrated: boolean;
}

export interface PlayerPublic {
  id: string;
  nickname: string;
  role: RoleRef;
  roleName: string;
  connected: boolean;
  sim: boolean;
  /** live normalized value / drive (0..1 or -1..1) for meters */
  level: number;
  sensor?: SensorStatus;
  ping?: number;
  lastInputAgo?: number;
  objective?: { text: string; progress: number; target: number; done: boolean };
  influence: number;
  /** current output channels (rounded), e.g. { calm, curiosity, caution } */
  ch: Record<string, number>;
  /** running count of discrete gestures (taps, beats, knocks, flinches, holds) */
  pulses: number;
}

export interface CatSnapshot {
  x: number;
  z: number;
  heading: number;
  state: CatState;
  speed: number;
  look: [number, number] | null;
  edge: number;
  from: number;
  to: number;
  s: number;
  node: number;
}

export interface Snapshot {
  t: number;
  code: string;
  phase: Phase;
  phaseT: number;
  journeyT: number;
  /** seconds until the soft limit (negative in overtime) */
  remaining: number;
  /** seconds until the night ends */
  hardRemaining: number;
  overtime: boolean;
  paused: boolean;
  cat: CatSnapshot;
  inner: CatInternals;
  hints: Hint[];
  options: OptionScore[];
  planned: number[];
  homeReveal: number;
  extension: number;
  players: PlayerPublic[];
  realPlayers: number;
  render: { fog: number; light: number; hintVisibility: number; whispers: boolean; keyboard: boolean };
  autoStartIn: number;
  ending: null | 'home' | 'sleep';
  summary: JourneySummary | null;
}

export interface PlayerSummary {
  playerId: string;
  nickname: string;
  roleName: string;
  objective: string;
  done: boolean;
  /** decisions where this player's sense tipped the choice */
  decisive: number;
  inputs: number;
  line: string;
}

export interface JourneySummary {
  ending: 'home' | 'sleep';
  durationSec: number;
  distance: number;
  junctions: number;
  detours: number;
  hintsSeen: number;
  memories: number;
  players: PlayerSummary[];
}

export interface PhoneState {
  playerId: string;
  token: string;
  nickname: string;
  code: string;
  role: RoleRef;
  roleName: string;
  instruction: string;
  objective: { text: string; progress: number; target: number; done: boolean };
  phase: Phase;
  paused: boolean;
  players: number;
  /** role-specific cues */
  cue: {
    approaching: boolean;
    /** -1 left, 0 ahead, 1 right: where the pulse / sound is (HEARING) */
    side: number;
    tempo: number;
    cooldown: number;
    level: number;
  };
  feedback: string;
  sensitivity: number;
  summary: PlayerSummary | null;
  catState: CatState;
}

export interface DirectorState {
  code: string;
  config: SessionConfig;
  phase: Phase;
  paused: boolean;
  journeyT: number;
  remaining: number;
  hardRemaining: number;
  extension: number;
  cat: CatSnapshot;
  inner: CatInternals;
  options: OptionScore[];
  lastDecisions: { t: number; node: number; chosen: number; terms: Record<string, number>; decisive: string; margin: number }[];
  planned: number[];
  players: PlayerPublic[];
  aggregated: Record<string, number>;
  diagnostics: {
    tickMs: number;
    clients: { displays: number; phones: number; directors: number; debug: number };
    uptimeSec: number;
    distanceToHome: number;
    bestDistanceToHome: number;
    progress: number;
    visitedEdges: number;
    decisions: number;
    detours: number;
    estDurationSec: number;
    worldStats: World['stats'];
  };
  events: WorldEvent[];
  summary: JourneySummary | null;
}

export type DirectorCommand =
  | { c: 'start' }
  | { c: 'pause' }
  | { c: 'resume' }
  | { c: 'reset' }
  | { c: 'newSession' }
  | { c: 'setSeed'; seed: string }
  | { c: 'regenerate'; seed?: string }
  | { c: 'config'; patch: Partial<SessionConfig> }
  | { c: 'hint'; edge?: number }
  | { c: 'memory' }
  | { c: 'event'; kind: string }
  | { c: 'teleport'; node: number }
  | { c: 'ending'; kind: 'home' | 'sleep' }
  | { c: 'kick'; playerId: string }
  | { c: 'reassign'; playerId: string; sense: SenseId; variant: boolean }
  | { c: 'bots'; count: number }
  | { c: 'debugOverlay'; on: boolean };

export type DevInput = { sense: SenseId; input: PhoneInput } | { sense: SenseId; hold: number | null };

export interface HelloAck {
  ok: boolean;
  error?: string;
  code?: string;
  lanUrls?: string[];
}
