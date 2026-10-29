// Messages between server, main display, phones, director and debug clients.
import type { SessionConfig } from './config';
import type { CatInternals, CatState, Phase, RoleRef, SenseId, World, WorldEvent } from './types';

/** normalized phone input; raw sensor data never leaves the phone */
export type PhoneInput =
  /** SIGHT brightness 0..1, DIRECTION tilt -1..1, MEMORY loudness 0..1 */
  | { t: 'value'; v: number }
  /** HEARTBEAT */
  | { t: 'tap' }
  /** SPEED: top-to-bottom scratching intensity 0..1 */
  | { t: 'scratch'; v: number }
  /** INSTINCT: shaking (or side-to-side scratching) intensity 0..1 */
  | { t: 'shake'; v: number };

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
  /** running count of discrete gestures (taps, scratches, shakes) */
  pulses: number;
}

export interface CatSnapshot {
  x: number;
  z: number;
  heading: number;
  state: CatState;
  speed: number;
  look: [number, number] | null;
  /** how fast the paws move (m/s equivalent), even when there is no path to walk on */
  paws: number;
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
  /** the shortest way home from where he stands (edge ids, current street first) */
  planned: number[];
  homeReveal: number;
  /** how close he is to home, 0 at the start .. 1 at home; SIGHT and MEMORY ask for more as it rises (see senseCurves) */
  near: number;
  /** MEMORY: the averaged loudness 0..1 (inner.cohesion is what it does to the paths) */
  loudness: number;
  /** where each sense should be right now: the SIGHT clear band, the MEMORY ramp, the HEARTBEAT half-width */
  targets: { sight: [number, number]; sound: [number, number]; heart: number };
  /** the pulse HEARTBEAT players tap along with */
  heartBpm: number;
  players: PlayerPublic[];
  realPlayers: number;
  render: { fog: number; light: number; whispers: boolean; keyboard: boolean };
  autoStartIn: number;
  /** seconds until the tutorial ends by itself (-1: it waits for the host, or no tutorial) */
  tutorialIn: number;
  ending: null | 'home' | 'sleep';
  endCause: EndCause | null;
  summary: JourneySummary | null;
}

/** why the journey ended: home, or the night ended (heart too slow / too fast, or out of time) */
export type EndCause = 'home' | 'slow' | 'fast' | 'time';

export interface PlayerSummary {
  playerId: string;
  nickname: string;
  roleName: string;
  objective: string;
  done: boolean;
  inputs: number;
  line: string;
}

export interface JourneySummary {
  ending: 'home' | 'sleep';
  cause: EndCause;
  durationSec: number;
  distance: number;
  streets: number;
  detours: number;
  discoveries: number;
  landmarks: number;
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
    /** the sense's effect on Dargato right now (heartbeat: the slider, -1..1) */
    level: number;
    /** the pulse on the big screen (bpm) */
    tempo: number;
    /** SIGHT: the light range in which he sees clearly; it climbs as he nears home */
    band: [number, number];
    /** HEARTBEAT: |slider| below this is on the beat */
    heartZone: number;
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
  cat: CatSnapshot;
  inner: CatInternals;
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
  | { c: 'event'; kind: string }
  | { c: 'teleport'; node: number }
  | { c: 'ending'; kind: 'home' | 'sleep' }
  | { c: 'kick'; playerId: string }
  | { c: 'reassign'; playerId: string; sense: SenseId }
  | { c: 'bots'; count: number }
  | { c: 'debugOverlay'; on: boolean };

export type DevInput = { sense: SenseId; input: PhoneInput } | { sense: SenseId; hold: number | null };

export interface HelloAck {
  ok: boolean;
  error?: string;
  code?: string;
  lanUrls?: string[];
}
