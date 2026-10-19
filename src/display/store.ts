// Mutable store shared by the 3D scene (read every frame, no React re-renders).
import type { Snapshot } from '../../shared/protocol';
import type { World, WorldEvent } from '../../shared/types';
import { lerpAngle } from '../../shared/graph';

export interface CatView {
  x: number;
  z: number;
  heading: number;
  speed: number;
  state: Snapshot['cat']['state'];
  look: [number, number] | null;
}

export const store = {
  world: null as World | null,
  snaps: [] as { snap: Snapshot; recv: number }[],
  latest: null as Snapshot | null,
  events: [] as WorldEvent[],
  /** min(recv - serverT) -> best estimate of the clock offset */
  offset: Infinity,
  debug: false,
  interpDelay: 110,
  cat: { x: 0, z: 0, heading: 0, speed: 0, state: 'idle', look: null } as CatView,
};

export function pushSnapshot(snap: Snapshot) {
  const recv = performance.now();
  const off = recv - snap.t;
  // track the smallest observed delay, but let it drift slowly so clock skew does not accumulate
  store.offset = Math.min(store.offset + 0.5, off);
  store.snaps.push({ snap, recv });
  if (store.snaps.length > 40) store.snaps.shift();
  store.latest = snap;
}

export function serverNow(): number {
  return performance.now() - (isFinite(store.offset) ? store.offset : 0);
}

/** interpolated cat pose at render time */
export function sampleCat(): CatView {
  const snaps = store.snaps;
  if (!snaps.length) return store.cat;
  const t = serverNow() - store.interpDelay;
  let a = snaps[0];
  let b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].snap.t <= t) {
      a = snaps[i - 1];
      b = snaps[i];
      break;
    }
  }
  const span = b.snap.t - a.snap.t;
  const k = span > 0 ? Math.max(0, Math.min(1, (t - a.snap.t) / span)) : 1;
  const ca = a.snap.cat;
  const cb = b.snap.cat;
  // a teleport: do not interpolate across
  const jump = Math.hypot(cb.x - ca.x, cb.z - ca.z) > 6;
  const c = store.cat;
  c.x = jump ? cb.x : ca.x + (cb.x - ca.x) * k;
  c.z = jump ? cb.z : ca.z + (cb.z - ca.z) * k;
  c.heading = jump ? cb.heading : lerpAngle(ca.heading, cb.heading, k);
  c.speed = ca.speed + (cb.speed - ca.speed) * k;
  c.state = (k < 0.5 ? ca : cb).state;
  c.look = cb.look;
  return c;
}
