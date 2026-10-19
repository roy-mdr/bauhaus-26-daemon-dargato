// Route hints: subtle environmental signs (red glow, reflections, paw prints,
// clearer fog, sounds, silhouettes) attached to the first stretch of a street
// seen from a junction. They are mostly truthful, sometimes ambiguous, and grow
// stronger and more truthful when the group is lost or time runs out.
import { clamp, otherNode } from '../shared/graph';
import type { Rng } from '../shared/rng';
import type { CatInternals, Hint, HintKind, Landmark, World } from '../shared/types';
import { RED_HINTS } from './routeChoice';

export interface HintContext {
  now: number;
  timeFrac: number;
  lost: number;
  overtime: boolean;
}

export class HintSystem {
  hints: Hint[] = [];
  private nextId = 1;
  private preparedAt = new Map<number, number>();
  revealed = new Set<number>();

  constructor(
    private world: World,
    private rng: Rng,
  ) {}

  add(kind: HintKind, edgeId: number, nodeId: number, strength: number, now: number, durSec: number, source: string): Hint {
    // merge with an existing hint of the same kind on the same street
    const existing = this.hints.find((h) => h.edgeId === edgeId && h.nodeId === nodeId && h.kind === kind);
    if (existing) {
      existing.strength = Math.max(existing.strength, strength);
      existing.until = Math.max(existing.until, now + durSec * 1000);
      existing.source = source;
      return existing;
    }
    const h: Hint = { id: this.nextId++, kind, edgeId, nodeId, strength: clamp(strength, 0, 1.4), visible: 0, t0: now, until: now + durSec * 1000, source };
    this.hints.push(h);
    return h;
  }

  private kindFor(edgeId: number): HintKind {
    const e = this.world.edges[edgeId];
    if (e.effect === 'puddles' && this.rng.chance(0.7)) return 'reflection';
    if (e.effect === 'fog' && this.rng.chance(0.7)) return 'clarity';
    return this.rng.chance(0.55) ? 'red-glow' : 'pawprints';
  }

  /** automatic hints for the options of a junction the cat approaches */
  prepareJunction(node: number, arriveEdge: number, ctx: HintContext) {
    const last = this.preparedAt.get(node) ?? -Infinity;
    if (ctx.now - last < 20000) return;
    this.preparedAt.set(node, ctx.now);
    const n = this.world.nodes[node];
    const options = n.edges.filter((e) => e !== arriveEdge);
    if (!options.length) return;
    const chanceAny = clamp(0.55 + 0.3 * ctx.timeFrac + 0.6 * ctx.lost + (ctx.overtime ? 1 : 0));
    if (!this.rng.chance(chanceAny)) return;
    const dH = (eid: number) => this.world.distHome[node] - this.world.distHome[otherNode(this.world.edges[eid], node)];
    const best = options.reduce((a, b) => (dH(b) > dH(a) ? b : a));
    const pTrue = clamp(0.62 + 0.25 * ctx.timeFrac + 0.35 * ctx.lost + (ctx.overtime ? 0.4 : 0), 0, 0.97);
    const strengthBase = clamp(0.55 + 0.3 * ctx.timeFrac + 0.5 * ctx.lost + (ctx.overtime ? 0.5 : 0), 0, 1.3);
    const others = options.filter((e) => e !== best);
    const target = this.rng.chance(pTrue) || !others.length ? best : this.rng.pick(others);
    const e = this.world.edges[target];
    this.add(this.kindFor(target), target, node, strengthBase * (0.6 + 0.5 * e.hintStrength), ctx.now, 30, target === best ? 'instinct' : 'ambiguous');
    // sometimes a second, weaker sign elsewhere keeps things ambiguous
    if (others.length && this.rng.chance(0.3 * (1 - ctx.lost))) {
      const alt = this.rng.pick(options.filter((x) => x !== target));
      this.add(this.kindFor(alt), alt, node, strengthBase * 0.5, ctx.now, 30, 'ambiguous');
    }
  }

  /** a strong, truthful hint (director / emergency) */
  forceHomeHint(node: number, arriveEdge: number, now: number, edgeId?: number) {
    const n = this.world.nodes[node];
    const options = n.edges.filter((e) => e !== arriveEdge);
    if (!options.length) return null;
    const dH = (eid: number) => this.world.distHome[node] - this.world.distHome[otherNode(this.world.edges[eid], node)];
    const target = edgeId !== undefined && options.includes(edgeId) ? edgeId : options.reduce((a, b) => (dH(b) > dH(a) ? b : a));
    return this.add('red-glow', target, node, 1.2, now, 30, 'director');
  }

  /** a familiar sound coming from one street (MEMORY, narrative) */
  soundFrom(node: number, arriveEdge: number, strength: number, now: number, landmarksByNode: Map<number, Landmark[]>, source: string, preferHome = false) {
    const n = this.world.nodes[node];
    const options = n.edges.filter((e) => e !== arriveEdge);
    if (!options.length) return null;
    let best = options[0];
    let bestScore = -Infinity;
    for (const eid of options) {
      const m = otherNode(this.world.edges[eid], node);
      let sc = this.rng.range(0, 0.6);
      if (preferHome) sc += (this.world.distHome[node] - this.world.distHome[m]) / 10;
      else {
        const near = [m, ...this.world.nodes[m].edges.map((x) => otherNode(this.world.edges[x], m))];
        if (near.some((k) => (landmarksByNode.get(k) ?? []).some((l) => l.meaning !== 'true'))) sc += 1;
        const k = this.world.edges[eid].kind;
        if (k === 'alley' || k === 'path') sc += 0.5;
      }
      if (sc > bestScore) {
        bestScore = sc;
        best = eid;
      }
    }
    return this.add('sound', best, node, strength, now, 14, source);
  }

  update(now: number, I: CatInternals, hintVisibility: number, cat: { mode: string; from: number; s: number; node: number }) {
    for (const h of this.hints) {
      // once he has left the junction the sign fades
      if (cat.mode === 'edge' && cat.from === h.nodeId && cat.s > 8) h.until = Math.min(h.until, now + 1500);
      if (cat.mode === 'node' && cat.node !== h.nodeId && h.until > now + 3000) {
        // he is somewhere else: keep only hints at nearby junctions
        const a = this.world.nodes[h.nodeId];
        const b = this.world.nodes[cat.node];
        if (Math.hypot(a.x - b.x, a.z - b.z) > 40) h.until = now + 1500;
      }
      const fade = clamp((h.until - now) / 1500) * clamp((now - h.t0) / 1200);
      let v: number;
      if (h.kind === 'sound') v = h.strength * (0.3 + 0.9 * I.acuity) * I.soundGain;
      else v = h.strength * I.perception * (RED_HINTS.has(h.kind) ? I.redGain : 1) * (1 + 0.3 * I.acuity);
      h.visible = clamp(v * hintVisibility * fade, 0, 1.5);
    }
    this.hints = this.hints.filter((h) => h.until > now);
  }

  clear() {
    this.hints = [];
    this.preparedAt.clear();
    this.revealed.clear();
  }
}
