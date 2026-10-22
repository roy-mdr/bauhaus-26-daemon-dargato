import type { SenseId } from './types';

export interface SessionConfig {
  seed: string;
  /** keep the same seed when a session returns to the lobby */
  lockSeed: boolean;
  /** soft limit: after this the way home starts to glow red on its own (final opportunity) */
  maxDurationSec: number;
  /** extra time after the soft limit before the night ends */
  finalGraceSec: number;
  /** top walking speed (m/s) at full SPEED scratching */
  catSpeed: number;
  fogDensity: number;
  lightIntensity: number;
  /** the pulse shown on the main display; HEARTBEAT players tap along with it */
  heartBpm: number;
  /** seconds of tapping far off the beat (or not at all) before the night ends */
  heartFailSec: number;
  sensitivity: Record<SenseId, number>;
  /** simulate the senses nobody is playing */
  simulateMissing: boolean;
  simIntensity: number;
  /** reshuffle roles each new journey */
  reshuffleRoles: boolean;
  /** start automatically when real players are present */
  autoStart: boolean;
  autoStartDelaySec: number;
  autoStartMinPlayers: number;
  summarySec: number;
  /** allow keyboard test controls on the main display */
  displayKeyboard: boolean;
  /** subtle text lines on the main display for story events */
  whispers: boolean;
  /** seconds a disconnected player's slot is kept for reconnection */
  reconnectGraceSec: number;
}

export const DEFAULT_CONFIG: SessionConfig = {
  seed: 'dargato',
  lockSeed: false,
  maxDurationSec: 480,
  finalGraceSec: 90,
  catSpeed: 3.2,
  fogDensity: 0.022,
  lightIntensity: 1,
  heartBpm: 72,
  heartFailSec: 10,
  sensitivity: { sight: 1, speed: 1, direction: 1, memory: 1, instinct: 1, heartbeat: 1 },
  simulateMissing: true,
  simIntensity: 0.6,
  reshuffleRoles: true,
  autoStart: false,
  autoStartDelaySec: 45,
  autoStartMinPlayers: 2,
  summarySec: 25,
  displayKeyboard: true,
  whispers: true,
  reconnectGraceSec: 120,
};

/** heartbeat slider position for a tap rate: -1 too slow (or no taps) .. 0 on the beat .. 1 too fast */
export function heartPosition(bpm: number, target: number): number {
  if (bpm <= 0) return -1;
  return Math.max(-1, Math.min(1, (bpm - target) / (target * 0.5)));
}

/** |heart| below this counts as "on the beat" */
export const HEART_ZONE = 0.3;

/** home is an open field of red dots around the home node: how far it spreads, and how deep in he has arrived */
export function homeField(r: number): { radius: number; arrive: number } {
  return { radius: r + 16, arrive: r + 5 };
}
