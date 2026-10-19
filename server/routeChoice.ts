// Route preference at a junction: combines homeward instinct, player influences,
// hints, sounds, mood and memory of visited streets into one score per option.
import { arriveHeading, clamp, leaveHeading, otherNode, wrapAngle } from '../shared/graph';
import type { CatInternals, Hint, Landmark, OptionScore, World } from '../shared/types';

export interface Influences {
  perception: number;
  redGain: number;
  dir: number;
  explore: number;
  energyDrive: number;
  scratch: number;
  restraint: number;
  calmDrive: number;
  curiosityDrive: number;
  cautionDrive: number;
  rest: number;
  acuity: number;
  farHearing: number;
  soundGain: number;
  heartbeat: number;
  memoryLevel: number;
}

export const NEUTRAL_INFLUENCES: Influences = {
  perception: 0.5,
  redGain: 1,
  dir: 0,
  explore: 0,
  energyDrive: 0,
  scratch: 0,
  restraint: 0,
  calmDrive: 0,
  curiosityDrive: 0,
  cautionDrive: 0,
  rest: 0,
  acuity: 0.25,
  farHearing: 0,
  soundGain: 1,
  heartbeat: 0,
  memoryLevel: 0.2,
};

export const WEIGHTS = {
  home: 1.2,
  dir: 1.05,
  hint: 0.9,
  sound: 0.95,
  curiosity: 0.6,
  calm: 0.4,
  caution: 0.65,
  explore: 0.6,
  revisit: 0.4,
  back: 1.6,
  hysteresis: 0.15,
};

/** which senses a score term belongs to (for attribution / private objectives) */
export const TERM_SOURCES: Record<string, string[]> = {
  dir: ['direction'],
  explore: ['direction-b'],
  hint: ['vision', 'vision-b', 'hearing'],
  sound: ['memory', 'memory-b', 'hearing', 'hearing-b'],
  curiosity: ['emotion'],
  calm: ['emotion'],
  caution: ['emotion', 'instinct-b'],
};

export const RED_HINTS = new Set(['red-glow']);

export interface ChoiceContext {
  world: World;
  node: number;
  arriveEdge: number;
  I: CatInternals;
  inf: Influences;
  hints: Hint[];
  visits: Map<number, number>;
  leader: number;
  noise: Map<number, number>;
  landmarksByNode: Map<number, Landmark[]>;
  shortestEdges: Set<number>;
}

export function scoreOptions(ctx: ChoiceContext): OptionScore[] {
  const { world, node, I, inf } = ctx;
  const n = world.nodes[node];
  const inHeading = ctx.arriveEdge >= 0 ? arriveHeading(world.edges[ctx.arriveEdge], node) : null;
  const out: OptionScore[] = [];
  const dHere = world.distHome[node];

  for (const eid of n.edges) {
    const e = world.edges[eid];
    const m = otherNode(e, node);
    const out_h = leaveHeading(e, node);
    const turn = inHeading === null ? 0 : wrapAngle(out_h - inHeading);
    const isBack = eid === ctx.arriveEdge;
    const dH = clamp((dHere - world.distHome[m]) / (e.length * e.traversability), -1, 1);
    const visits = ctx.visits.get(eid) ?? 0;
    const target = world.nodes[m];
    const lms = ctx.landmarksByNode.get(m) ?? [];
    const lmHere = (ctx.landmarksByNode.get(node) ?? []).filter((l) => l.edgeId === eid);

    const terms: Record<string, number> = {};
    terms.home = WEIGHTS.home * I.homeward * dH;

    // DIRECTION: tilt right -> prefer right turns (negative turn angle)
    if (Math.abs(inf.dir) > 0.12 && !isBack) {
      const targetTurn = -inf.dir * (Math.PI / 2);
      terms.dir = WEIGHTS.dir * Math.abs(inf.dir) * Math.cos(wrapAngle(turn - targetTurn));
    } else terms.dir = 0;

    // visual hints seen from this junction
    let hint = 0;
    let sound = 0;
    for (const h of ctx.hints) {
      if (h.edgeId !== eid || h.nodeId !== node) continue;
      if (h.kind === 'sound') sound += h.visible;
      else hint += h.visible;
    }
    for (const l of lmHere) if (l.meaning === 'true') hint += 0.25 * I.perception * inf.redGain;
    terms.hint = WEIGHTS.hint * Math.min(1.3, hint);
    // sounds attract more when curious; FAR EAR makes the home direction audible
    sound = sound * (0.5 + I.curiosity) + inf.farHearing * 0.8 * Math.max(0, dH);
    terms.sound = WEIGHTS.sound * Math.min(1.3, sound);

    const novelty =
      (visits === 0 ? 1 : 0.2 / visits) +
      (e.kind === 'alley' || e.kind === 'path' ? 0.3 : 0) +
      (lms.some((l) => l.meaning !== 'true') || lmHere.some((l) => l.meaning !== 'true') ? 0.5 : 0) +
      (target.discovery && visits === 0 ? 0.3 : 0);
    const familiarity = (e.kind === 'main' || e.kind === 'street' ? 0.5 : 0) + (visits > 0 ? 0.3 : 0) + (dH > 0 ? 0.4 : 0);
    const risk =
      (e.kind === 'alley' ? 0.6 : e.kind === 'path' ? 0.35 : 0) +
      (e.effect === 'fog' ? 0.4 : 0) +
      (target.edges.length === 1 && visits === 0 ? 0.3 : 0);

    terms.curiosity = isBack ? 0 : WEIGHTS.curiosity * I.curiosity * novelty;
    terms.calm = WEIGHTS.calm * I.calm * familiarity;
    terms.caution = -WEIGHTS.caution * I.caution * risk;
    terms.explore = WEIGHTS.explore * inf.explore * (novelty * 0.6 - dH * 0.8);
    terms.revisit = -WEIGHTS.revisit * visits * (1 + I.lost);
    terms.back = isBack ? -WEIGHTS.back : 0;
    terms.hysteresis = eid === ctx.leader ? WEIGHTS.hysteresis : 0;
    terms.noise = ctx.noise.get(eid) ?? 0;

    let total = 0;
    for (const v of Object.values(terms)) total += v;
    out.push({ edgeId: eid, toNode: m, turn, total, terms });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

/** which sense tipped the decision (largest player-driven advantage of the winner over the runner-up) */
export function decisiveTerm(options: OptionScore[]): { term: string; margin: number } {
  if (options.length < 2) return { term: 'none', margin: 0 };
  const [a, b] = options;
  let best = 'home';
  let bestD = a.terms.home - b.terms.home;
  for (const k of Object.keys(TERM_SOURCES)) {
    const d = (a.terms[k] ?? 0) - (b.terms[k] ?? 0);
    if (d > bestD) {
      bestD = d;
      best = k;
    }
  }
  return { term: best, margin: a.total - b.total };
}
