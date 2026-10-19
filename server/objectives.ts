// Private, lightweight objectives that create conflicting incentives.
// They never replace the shared goal (bring Dargato home).
import { OBJECTIVES, ROLE_OBJECTIVES, roleInfo, roleKey, type ObjectiveId } from '../shared/roles';
import type { PlayerSummary } from '../shared/protocol';
import type { Rng } from '../shared/rng';
import type { GraphEdge, OptionScore } from '../shared/types';
import { isActive, type Player } from './players';

export class Objectives {
  constructor(private players: () => Player[]) {}

  assign(p: Player, rng: Rng) {
    const pool = ROLE_OBJECTIVES[roleKey(p.role)] ?? ['reveal-hints'];
    const taken = new Set(this.players().filter((q) => q !== p && q.kind !== 'sim').map((q) => q.objective.id));
    const fresh = pool.filter((id) => !taken.has(id));
    const id: ObjectiveId = fresh.length && rng.chance(0.75) ? fresh[0] : rng.pick(pool);
    p.objective = { id, progress: 0, done: false, failed: false };
  }

  private bump(id: ObjectiveId, amount: number, now: number, filter: (p: Player) => boolean = () => true, windowMs = 8000) {
    for (const p of this.players()) {
      if (p.kind === 'sim' || p.objective.id !== id || p.objective.done || p.objective.failed) continue;
      if (!isActive(p, now, windowMs) || !filter(p)) continue;
      p.objective.progress = Math.min(OBJECTIVES[id].target, p.objective.progress + amount);
      if (p.objective.progress >= OBJECTIVES[id].target) p.objective.done = true;
    }
  }

  onHintRevealed(now: number) {
    this.bump('reveal-hints', 1, now, (p) => p.role.sense === 'vision' || p.role.sense === 'hearing');
  }

  onDecision(chosen: OptionScore, edge: GraphEdge, runnerUp: OptionScore | undefined, offShortestFresh: boolean, now: number) {
    this.bump('direction-changes', 1, now, (p) => p.role.sense === 'direction' && Math.abs(chosen.turn) > 0.5 && Math.sign(-p.sense.value) === Math.sign(chosen.turn) && Math.abs(p.sense.value) > 0.25);
    if (edge.kind === 'alley' || edge.kind === 'path') this.bump('investigate-alley', 1, now);
    if (offShortestFresh) this.bump('explore', 1, now);
    const soundAdv = (chosen.terms.sound ?? 0) - (runnerUp?.terms.sound ?? 0);
    if ((chosen.terms.sound ?? 0) > 0.2 && soundAdv > 0.1) this.bump('follow-sound', 1, now, () => true, 15000);
  }

  onDetour(now: number) {
    this.bump('cause-detour', 1, now, () => true, 20000);
  }

  onMemory(p: Player) {
    if (p.objective.id === 'trigger-memory' && !p.objective.done) {
      p.objective.progress++;
      if (p.objective.progress >= OBJECTIVES['trigger-memory'].target) p.objective.done = true;
    }
  }

  onLandmarkVisit(now: number) {
    this.bump('visit-landmark', 1, now, () => true, 15000);
  }

  tick(dt: number, now: number, s: { fast: boolean; calm: number; fatigue: number }) {
    if (s.fast) this.bump('keep-fast', dt, now);
    if (s.calm > 0.6) this.bump('keep-calm', dt, now);
    for (const p of this.players()) {
      if (p.kind === 'sim') continue;
      if (p.objective.id === 'avoid-fatigue' && s.fatigue > 0.85) p.objective.failed = true;
      if (p.objective.id === 'extend-night' && !p.objective.done && p.role.sense === 'heartbeat') {
        p.objective.progress += dt * 0.5 * p.sense.drive * p.influence;
        if (p.objective.progress >= OBJECTIVES['extend-night'].target) p.objective.done = true;
      }
    }
  }

  finish() {
    for (const p of this.players()) {
      if (p.objective.id === 'avoid-fatigue' && !p.objective.failed) {
        p.objective.progress = 1;
        p.objective.done = true;
      }
    }
  }

  summary(p: Player): PlayerSummary {
    const def = OBJECTIVES[p.objective.id];
    const info = roleInfo(p.role);
    const lines: string[] = [];
    if (p.stats.decisive > 0) lines.push(`You tipped ${p.stats.decisive} of his decisions.`);
    else lines.push('He felt you, even when he went his own way.');
    if (p.stats.memories > 0) lines.push(`You woke ${p.stats.memories} memor${p.stats.memories === 1 ? 'y' : 'ies'}.`);
    return {
      playerId: p.id,
      nickname: p.nickname,
      roleName: info.name,
      objective: def.text,
      done: p.objective.done,
      decisive: p.stats.decisive,
      inputs: p.stats.inputs,
      line: lines.join(' '),
    };
  }

  view(p: Player) {
    const def = OBJECTIVES[p.objective.id];
    return { text: def.text, progress: Math.floor(p.objective.progress * 10) / 10, target: def.target, done: p.objective.done && !p.objective.failed };
  }
}
