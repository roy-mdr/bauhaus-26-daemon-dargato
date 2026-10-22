import type { RoleRef, SenseId } from './types';

export interface RoleInfo {
  sense: SenseId;
  name: string;
  /** one-sentence instruction shown on the phone */
  instruction: string;
  /** the same, for the manual fallback when the sensor is not available */
  fallback: string;
  /** what it changes in Dargato (shown in director / summary) */
  effect: string;
  sensor: 'camera' | 'motion' | 'orientation' | 'microphone' | 'touch';
}

/** order in which players receive senses; players beyond six repeat senses and their inputs are averaged */
export const SENSE_ORDER: SenseId[] = ['direction', 'speed', 'memory', 'heartbeat', 'sight', 'instinct'];

const ROLES: RoleInfo[] = [
  {
    sense: 'sight',
    name: 'SIGHT',
    instruction: 'Point your camera at the light so Dargato can see. Too dark and the streets go black, too bright and the fog swallows them.',
    fallback: 'His eye keeps closing: swipe up to hold it open. Swipe too much and the light blinds him.',
    effect: 'Camera brightness sets the light: too dark is night, too bright is glaring fog.',
    sensor: 'camera',
  },
  {
    sense: 'speed',
    name: 'SPEED',
    instruction: 'Scratch the screen from top to bottom to move his paws. The faster you scratch, the faster he walks.',
    fallback: 'Scratch the screen from top to bottom to move his paws. The faster you scratch, the faster he walks.',
    effect: 'Scratching moves the paws; no scratching, no walking. He only gets anywhere if the paths are there.',
    sensor: 'touch',
  },
  {
    sense: 'direction',
    name: 'DIRECTION',
    instruction: 'Tilt your phone left or right to turn Dargato.',
    fallback: 'Drag the joystick left or right to turn Dargato.',
    effect: 'Tilt turns him left or right, at any moment.',
    sensor: 'orientation',
  },
  {
    sense: 'memory',
    name: 'MEMORY',
    instruction: 'Blow or whisper into the microphone so he remembers the streets. In silence the paths fall apart and he cannot walk.',
    fallback: 'Tap to make sound: the faster you tap, the clearer he remembers the streets.',
    effect: 'Sound pulls the particles into paths and the buildings back to the ground; silence scatters them.',
    sensor: 'microphone',
  },
  {
    sense: 'instinct',
    name: 'INSTINCT',
    instruction: 'Shake your phone to wake his instinct: the shortest way home turns red.',
    fallback: 'Scratch the screen from side to side to wake his instinct: the shortest way home turns red.',
    effect: 'Shaking turns the particles of the shortest way home red.',
    sensor: 'motion',
  },
  {
    sense: 'heartbeat',
    name: 'HEARTBEAT',
    instruction: 'Tap with the pulse on the big screen. Too slow, or too fast, and the night is over.',
    fallback: 'Tap with the pulse on the big screen. Too slow, or too fast, and the night is over.',
    effect: 'Tapping on the beat keeps the journey going; stopping or rushing ends it.',
    sensor: 'touch',
  },
];

export function roleInfo(r: RoleRef): RoleInfo {
  return ROLES.find((x) => x.sense === r.sense)!;
}

// ---------- private objectives ----------

export type ObjectiveId =
  | 'clear-sight'
  | 'keep-fast'
  | 'explore'
  | 'cause-detour'
  | 'hold-paths'
  | 'show-way'
  | 'steady-heart'
  | 'visit-landmark'
  | 'investigate-alley'
  | 'find-discovery';

export interface ObjectiveDef {
  id: ObjectiveId;
  text: string;
  target: number;
}

export const OBJECTIVES: Record<ObjectiveId, ObjectiveDef> = {
  'clear-sight': { id: 'clear-sight', text: 'Keep his eyes clear, neither dark nor blinded, for 60 seconds.', target: 60 },
  'keep-fast': { id: 'keep-fast', text: 'Keep Dargato running for 40 seconds.', target: 40 },
  explore: { id: 'explore', text: 'Lead him through eight different streets.', target: 8 },
  'cause-detour': { id: 'cause-detour', text: 'Lead him away from home for a while.', target: 1 },
  'hold-paths': { id: 'hold-paths', text: 'Hold the paths together for 90 seconds.', target: 90 },
  'show-way': { id: 'show-way', text: 'Show him the way home for 30 seconds.', target: 30 },
  'steady-heart': { id: 'steady-heart', text: 'Keep his heart on the beat for two minutes.', target: 120 },
  'visit-landmark': { id: 'visit-landmark', text: 'Bring Dargato to a red landmark.', target: 1 },
  'investigate-alley': { id: 'investigate-alley', text: 'Make Dargato walk down a narrow alley.', target: 1 },
  'find-discovery': { id: 'find-discovery', text: 'Lead him into a dead end to find something.', target: 1 },
};

/** candidate objectives per sense (first one is the sense's natural wish) */
export const SENSE_OBJECTIVES: Record<SenseId, ObjectiveId[]> = {
  sight: ['clear-sight', 'visit-landmark'],
  speed: ['keep-fast', 'find-discovery'],
  direction: ['explore', 'cause-detour', 'investigate-alley'],
  memory: ['hold-paths', 'find-discovery'],
  instinct: ['show-way', 'visit-landmark'],
  heartbeat: ['steady-heart'],
};
