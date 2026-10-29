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
  /** how wide each sense's target is: 1 as designed, lower is narrower (harder) */
  sightWidth: number;
  soundWidth: number;
  heartWidth: number;
  sensitivity: Record<SenseId, number>;
  /** simulate the senses nobody is playing */
  simulateMissing: boolean;
  simIntensity: number;
  /** reshuffle roles each new journey */
  reshuffleRoles: boolean;
  /** show the tutorial (each sense, its phone sensor and its effect) between the lobby and the journey */
  tutorial: boolean;
  /** seconds the tutorial stays before the journey begins by itself (0: until the host starts it) */
  tutorialSec: number;
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
  catSpeed: 4.5,
  fogDensity: 0.022,
  lightIntensity: 1,
  heartBpm: 72,
  heartFailSec: 5,
  sightWidth: 1,
  soundWidth: 1,
  heartWidth: 1,
  sensitivity: { sight: 1, speed: 1, direction: 1, memory: 1, instinct: 1, heartbeat: 1 },
  simulateMissing: true,
  simIntensity: 0.6,
  reshuffleRoles: true,
  tutorial: true,
  tutorialSec: 60,
  autoStart: false,
  autoStartDelaySec: 45,
  autoStartMinPlayers: 2,
  summarySec: 25,
  displayKeyboard: true,
  whispers: true,
  reconnectGraceSec: 120,
};

/**
 * the intro before the journey: the camera circles home once, flies over the district to
 * Dargato's starting point, then settles behind him (seconds)
 */
export const INTRO = { home: 7, fly: 6, settle: 2 };
export const INTRO_SEC = INTRO.home + INTRO.fly + INTRO.settle;

/** heartbeat slider position for a tap rate: -1 too slow (or no taps) .. 0 on the beat .. 1 too fast */
export function heartPosition(bpm: number, target: number): number {
  if (bpm <= 0) return -1;
  return Math.max(-1, Math.min(1, (bpm - target) / (target * 0.5)));
}

/** |heart| below this counts as "on the beat" (at heartWidth 1) */
export const HEART_ZONE = 0.3;

/** the "on the beat" half-width for a given target width */
export function heartZone(width = 1): number {
  return HEART_ZONE * width;
}

/** home is an open field of red dots around the home node: how far it spreads, and how deep in he has arrived */
export function homeField(r: number): { radius: number; arrive: number } {
  return { radius: r + 16, arrive: r + 5 };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * SIGHT and MEMORY ask for more as he nears home (near: 0 at the start .. 1 at home).
 * Far away a little light already blinds him and a whisper holds the paths;
 * close to home he needs bright light and loud sound.
 * Each pair is a smoothstep edge [from, to] over the phone's 0..1 value.
 */
export function senseCurves(near: number, sightWidth = 1, soundWidth = 1) {
  const t = Math.max(0, Math.min(1, near));
  const dark: [number, number] = [lerp(0, 0.32, t), lerp(0.16, 0.64, t)];
  const glare: [number, number] = [lerp(0.36, 0.86, t), lerp(0.7, 1, t)];
  const sound: [number, number] = [lerp(0.02, 0.15, t), lerp(0.18, 0.7, t)];
  // a narrower target squeezes every edge toward the middle of the clear band (or of the sound ramp)
  const [lo, hi] = bandOf(dark, glare);
  const sq = (e: [number, number], mid: number, w: number) => e.map((x) => Math.max(0, mid + (x - mid) * w)) as [number, number];
  return {
    /** light rises over this edge (below it: darkness) */
    dark: sq(dark, (lo + hi) / 2, sightWidth),
    /** glare rises over this edge */
    glare: sq(glare, (lo + hi) / 2, sightWidth),
    /** the paths hold together over this edge */
    sound: sq(sound, (sound[0] + sound[1]) / 2, soundWidth),
  };
}

/** sight values with light > 0.85 and glare < 0.15 */
function bandOf(dark: [number, number], glare: [number, number]): [number, number] {
  return [dark[0] + 0.77 * (dark[1] - dark[0]), glare[0] + 0.24 * (glare[1] - glare[0])];
}

/** the sight value range in which he sees clearly */
export function clearBand(near: number, sightWidth = 1): [number, number] {
  const c = senseCurves(near, sightWidth);
  return bandOf(c.dark, c.glare).map((x) => Math.min(1, x)) as [number, number];
}
