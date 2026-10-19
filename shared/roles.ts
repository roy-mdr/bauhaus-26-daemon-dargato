import type { RoleRef, SenseId } from './types';

export interface RoleInfo {
  sense: SenseId;
  variant: boolean;
  name: string;
  /** one-sentence instruction shown on the phone */
  instruction: string;
  /** what it changes in Dargato (shown in director / summary) */
  effect: string;
  sensor: 'camera' | 'orientation' | 'microphone' | 'touch';
}

export const CORE_SENSES: SenseId[] = ['vision', 'direction', 'instinct', 'emotion', 'hearing', 'memory'];
/** order in which players 1..7 receive senses; HEARTBEAT is the 7th (keep-alive) sense */
export const SENSE_ORDER: SenseId[] = [...CORE_SENSES, 'heartbeat'];
/** order in which variants are handed out to players 8+ */
export const VARIANT_ORDER: SenseId[] = ['vision', 'direction', 'emotion', 'instinct', 'memory', 'hearing'];

const ROLES: RoleInfo[] = [
  {
    sense: 'vision',
    variant: false,
    name: 'VISION',
    instruction: 'Point your camera at light to help Dargato see the faint signs in the streets; cover it to let the fog close in.',
    effect: 'Brightness reveals route hints, red landmarks and nearby details.',
    sensor: 'camera',
  },
  {
    sense: 'vision',
    variant: true,
    name: 'RED SIGHT',
    instruction: 'Bright light makes red things burn brighter for Dargato; darkness makes him ignore them.',
    effect: 'Brightness strengthens or weakens the red route hints.',
    sensor: 'camera',
  },
  {
    sense: 'direction',
    variant: false,
    name: 'DIRECTION',
    instruction: 'Tilt your phone left or right to make one street feel more like the way home.',
    effect: 'Tilt biases which street Dargato prefers at junctions.',
    sensor: 'orientation',
  },
  {
    sense: 'direction',
    variant: true,
    name: 'WANDERLUST',
    instruction: 'Tilt right to pull Dargato homeward, tilt left to make unknown streets irresistible.',
    effect: 'Tilt trades homeward progress against exploration.',
    sensor: 'orientation',
  },
  {
    sense: 'instinct',
    variant: false,
    name: 'INSTINCT',
    instruction: 'Tap to make Dargato hurry, scratch the screen for a burst of speed. He tires quickly.',
    effect: 'Taps and scratches raise movement energy, limited by fatigue.',
    sensor: 'touch',
  },
  {
    sense: 'instinct',
    variant: true,
    name: 'RESTRAINT',
    instruction: 'Tap to hold Dargato back: slower, more careful, wary of narrow alleys.',
    effect: 'Taps increase caution and slow him down.',
    sensor: 'touch',
  },
  {
    sense: 'emotion',
    variant: false,
    name: 'EMOTION',
    instruction: 'Hold to calm Dargato, let go to make him curious, swipe down to make him wary.',
    effect: 'Calm favours familiar streets, curiosity favours the unknown, caution avoids risk.',
    sensor: 'touch',
  },
  {
    sense: 'emotion',
    variant: true,
    name: 'REST',
    instruction: 'Hold to let Dargato rest and recover; release to let him walk on.',
    effect: 'Holding slows him and removes fatigue.',
    sensor: 'touch',
  },
  {
    sense: 'hearing',
    variant: false,
    name: 'HEARING',
    instruction: 'Tap the side where the pulse appears, in time, so Dargato can hear distant sounds.',
    effect: 'Accurate rhythm sharpens his hearing of sounds and hints.',
    sensor: 'touch',
  },
  {
    sense: 'hearing',
    variant: true,
    name: 'FAR EAR',
    instruction: 'Tap the pulses in time to let Dargato hear the far-away cats of home.',
    effect: 'Accurate rhythm makes the sound of home audible, pulling him homeward.',
    sensor: 'touch',
  },
  {
    sense: 'memory',
    variant: false,
    name: 'MEMORY',
    instruction: 'Clap, knock or make a rhythm near your phone to wake a memory: a familiar sound from one street.',
    effect: 'Distinct sounds trigger memory sounds that attract him toward one street.',
    sensor: 'microphone',
  },
  {
    sense: 'memory',
    variant: true,
    name: 'ECHO',
    instruction: 'Keep the room loud to make sounds pull at Dargato; keep it quiet to make him ignore them.',
    effect: 'Loudness strengthens or weakens sound-based navigation.',
    sensor: 'microphone',
  },
  {
    sense: 'heartbeat',
    variant: false,
    name: 'HEARTBEAT',
    instruction: 'Tap a steady heartbeat to keep the night going a little longer for Dargato.',
    effect: 'A steady rhythm extends the time before the night ends.',
    sensor: 'touch',
  },
  {
    sense: 'heartbeat',
    variant: true,
    name: 'HEARTBEAT',
    instruction: 'Tap a steady heartbeat to keep the night going a little longer for Dargato.',
    effect: 'A steady rhythm extends the time before the night ends.',
    sensor: 'touch',
  },
];

export function roleInfo(r: RoleRef): RoleInfo {
  return ROLES.find((x) => x.sense === r.sense && x.variant === r.variant)!;
}

export function roleKey(r: RoleRef): string {
  return r.variant ? `${r.sense}-b` : r.sense;
}

// ---------- private objectives ----------

export type ObjectiveId =
  | 'reveal-hints'
  | 'direction-changes'
  | 'investigate-alley'
  | 'keep-fast'
  | 'cause-detour'
  | 'avoid-fatigue'
  | 'trigger-memory'
  | 'explore'
  | 'follow-sound'
  | 'keep-calm'
  | 'extend-night'
  | 'visit-landmark';

export interface ObjectiveDef {
  id: ObjectiveId;
  text: string;
  target: number;
}

export const OBJECTIVES: Record<ObjectiveId, ObjectiveDef> = {
  'reveal-hints': { id: 'reveal-hints', text: 'Reveal three route hints.', target: 3 },
  'direction-changes': { id: 'direction-changes', text: 'Make Dargato turn where you tilt, three times.', target: 3 },
  'investigate-alley': { id: 'investigate-alley', text: 'Make Dargato go down a narrow alley.', target: 1 },
  'keep-fast': { id: 'keep-fast', text: 'Keep Dargato moving quickly for 40 seconds.', target: 40 },
  'cause-detour': { id: 'cause-detour', text: 'Cause a short detour away from home.', target: 1 },
  'avoid-fatigue': { id: 'avoid-fatigue', text: 'Never let Dargato become exhausted.', target: 1 },
  'trigger-memory': { id: 'trigger-memory', text: 'Trigger two memory clues.', target: 2 },
  explore: { id: 'explore', text: 'Lead him through four streets off the shortest way.', target: 4 },
  'follow-sound': { id: 'follow-sound', text: 'Make Dargato follow a distant sound.', target: 1 },
  'keep-calm': { id: 'keep-calm', text: 'Keep Dargato calm for 60 seconds.', target: 60 },
  'extend-night': { id: 'extend-night', text: 'Keep the night alive for one extra minute.', target: 60 },
  'visit-landmark': { id: 'visit-landmark', text: 'Bring Dargato to a red landmark.', target: 1 },
};

/** candidate objectives per role (first one is the role's natural wish) */
export const ROLE_OBJECTIVES: Record<string, ObjectiveId[]> = {
  vision: ['reveal-hints', 'visit-landmark'],
  'vision-b': ['visit-landmark', 'reveal-hints'],
  direction: ['direction-changes', 'cause-detour'],
  'direction-b': ['explore', 'cause-detour'],
  instinct: ['keep-fast', 'cause-detour'],
  'instinct-b': ['avoid-fatigue', 'keep-calm'],
  emotion: ['investigate-alley', 'keep-calm'],
  'emotion-b': ['avoid-fatigue', 'keep-calm'],
  hearing: ['follow-sound', 'reveal-hints'],
  'hearing-b': ['follow-sound', 'keep-calm'],
  memory: ['trigger-memory', 'follow-sound'],
  'memory-b': ['follow-sound', 'investigate-alley'],
  heartbeat: ['extend-night'],
  'heartbeat-b': ['extend-night'],
};
