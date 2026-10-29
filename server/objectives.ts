// Private, lightweight objectives that create conflicting incentives.
// They never replace the shared goal (bring Dargato home).
import { OBJECTIVES, SENSE_OBJECTIVES, roleInfo, type ObjectiveId } from '../shared/roles';
import type { PlayerSummary } from '../shared/protocol';
import type { Rng } from '../shared/rng';
import type { EdgeKind, SenseId } from '../shared/types';
import { isActive, type Player } from './players';

/** what the senses achieve right now (checked every tick) */
export interface ObjectiveTick {
  clearSight: boolean;
  fast: boolean;
  pathsHeld: boolean;
  wayShown: boolean;
  onBeat: boolean;
}

const SUMMARY_LINE: Record<SenseId, string> = {
  sight: 'You were the light in his eyes.',
  speed: 'You were his paws on the stones.',
  direction: 'You chose every corner he turned.',
  memory: 'You held the streets together for him.',
  instinct: 'You were the red pull toward home.',
  heartbeat: 'You kept his heart going through the night.',
};

export class Objectives {
  constructor(private players: () => Player[]) {}

  assign(p: Player, rng: Rng) {
    const pool = SENSE_OBJECTIVES[p.role.sense];
    const taken = new Set(this.players().filter((q) => q !== p && q.kind !== 'sim').map((q) => q.objective.id));
    const fresh = pool.filter((id) => !taken.has(id));
    const id: ObjectiveId = fresh.length && rng.chance(0.75) ? fresh[0] : rng.pick(pool);
    p.objective = { id, progress: 0, done: false, failed: false };
  }

  private bump(id: ObjectiveId, amount: number, now: number, windowMs = 8000) {
    for (const p of this.players()) {
      if (p.kind === 'sim' || p.objective.id !== id || p.objective.done) continue;
      if (!isActive(p, now, windowMs)) continue;
      p.objective.progress = Math.min(OBJECTIVES[id].target, p.objective.progress + amount);
      if (p.objective.progress >= OBJECTIVES[id].target) {
        p.objective.done = true;
        p.objective.doneAt = now;
      }
    }
  }

  onStreet(kind: EdgeKind, fresh: boolean, now: number) {
    if (fresh) this.bump('explore', 1, now);
    if (kind === 'alley' || kind === 'path') this.bump('investigate-alley', 1, now);
  }

  onDetour(now: number) {
    this.bump('cause-detour', 1, now, 20000);
  }

  onLandmarkVisit(now: number) {
    this.bump('visit-landmark', 1, now, 15000);
  }

  onDiscovery(now: number) {
    this.bump('find-discovery', 1, now, 15000);
  }

  tick(dt: number, now: number, s: ObjectiveTick) {
    if (s.clearSight) this.bump('clear-sight', dt, now);
    if (s.fast) this.bump('keep-fast', dt, now);
    if (s.pathsHeld) this.bump('hold-paths', dt, now);
    if (s.wayShown) this.bump('show-way', dt, now);
    if (s.onBeat) this.bump('steady-heart', dt, now);
  }

  summary(p: Player): PlayerSummary {
    const def = OBJECTIVES[p.objective.id];
    const info = roleInfo(p.role);
    return {
      playerId: p.id,
      nickname: p.nickname,
      roleName: info.name,
      objective: def.text,
      done: p.objective.done,
      inputs: p.stats.inputs,
      line: p.stats.inputs > 10 ? SUMMARY_LINE[p.role.sense] : 'He barely felt you this time.',
    };
  }

  view(p: Player) {
    const def = OBJECTIVES[p.objective.id];
    return { text: def.text, progress: Math.floor(p.objective.progress * 10) / 10, target: def.target, done: p.objective.done };
  }
}
