import type { SenseId } from './types';

export interface SessionConfig {
  seed: string;
  /** keep the same seed when a session returns to the lobby */
  lockSeed: boolean;
  /** soft limit: after this the homeward instinct and hints grow strongly (final opportunity) */
  maxDurationSec: number;
  /** extra time after the soft limit before the night ends */
  finalGraceSec: number;
  /** maximum extension the HEARTBEAT sense can earn */
  maxHeartbeatExtensionSec: number;
  catSpeed: number;
  fogDensity: number;
  lightIntensity: number;
  hintVisibility: number;
  sensitivity: Record<SenseId, number>;
  /** simulate the core senses nobody is playing */
  simulateMissing: boolean;
  simIntensity: number;
  /** players beyond the 7 unique senses: 'variant' = role variants first, 'average' = repeat senses and average */
  extraPlayerMode: 'variant' | 'average';
  /** reshuffle roles each new journey */
  reshuffleRoles: boolean;
  /** start automatically when real players are present */
  autoStart: boolean;
  autoStartDelaySec: number;
  autoStartMinPlayers: number;
  summarySec: number;
  /** allow keyboard test controls on the main display */
  displayKeyboard: boolean;
  /** subtle text lines on the main display for memory events */
  whispers: boolean;
  /** seconds a disconnected player's slot is kept for reconnection */
  reconnectGraceSec: number;
}

export const DEFAULT_CONFIG: SessionConfig = {
  seed: 'dargato',
  lockSeed: false,
  maxDurationSec: 480,
  finalGraceSec: 90,
  maxHeartbeatExtensionSec: 150,
  catSpeed: 2.0,
  fogDensity: 0.022,
  lightIntensity: 1,
  hintVisibility: 1,
  sensitivity: { vision: 1, direction: 1, memory: 1, instinct: 1, hearing: 1, emotion: 1, heartbeat: 1 },
  simulateMissing: true,
  simIntensity: 0.6,
  extraPlayerMode: 'variant',
  reshuffleRoles: true,
  autoStart: false,
  autoStartDelaySec: 45,
  autoStartMinPlayers: 2,
  summarySec: 25,
  displayKeyboard: true,
  whispers: true,
  reconnectGraceSec: 120,
};
