// Dargato's autonomous behaviour: movement on the street graph, junction
// decisions, moods, fatigue, reactions and detour recovery. Server-authoritative.
import { clamp, otherNode, sampleEdge, astar, leaveHeading } from '../shared/graph';
import { Rng } from '../shared/rng';
import type { CatInternals, CatState, DiscoveryKind, Hint, Landmark, OptionScore, World } from '../shared/types';
import type { CatSnapshot } from '../shared/protocol';
import { decisiveTerm, scoreOptions, type Influences } from './routeChoice';

export interface Decision {
  t: number;
  node: number;
  chosen: number;
  options: OptionScore[];
  decisive: string;
  margin: number;
}

export interface CatHooks {
  onDecision(d: Decision): void;
  onArriveNode(node: number): void;
  onApproach(node: number, arriveEdge: number): void;
  onHome(): void;
  onDiscovery(node: number, kind: DiscoveryKind): void;
  onDetour(): void;
  onRecovered(): void;
  onLandmarkNear(lm: Landmark): void;
  hints(): Hint[];
}

const STOPPED: CatState[] = ['paused', 'sniffing', 'hesitating', 'alert', 'frightened', 'recovering', 'resting', 'investigating', 'arriving', 'home', 'sleeping', 'idle'];

export class CatSim {
  mode: 'node' | 'edge' = 'node';
  node: number;
  edge = -1;
  from = -1;
  to = -1;
  s = 0;
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  state: CatState = 'idle';
  stateT = 0;
  look: [number, number] | null = null;
  I: CatInternals;
  visits = new Map<number, number>();
  visitedNodes = new Set<number>();
  options: OptionScore[] = [];
  leader = -1;
  hesitateT = 0;
  hesitateDur = 0;
  arriveEdge = -1;
  commitT = 0;
  approached = false;
  bestDHome: number;
  tSinceBest = 0;
  inDetour = false;
  detours = 0;
  decisions = 0;
  junctions = 0;
  distance = 0;
  reversedOnEdge = false;
  private noise = new Map<number, number>();
  private lookFlip = 0;
  private sniffCooldown = 6;
  private seenLandmarks = new Set<number>();
  discovered = new Set<number>();
  private restT = 0;
  private restless = false;
  private landmarksByNode = new Map<number, Landmark[]>();
  private afterStop: (() => void) | null = null;
  private rng: Rng;
  shortestEdges: Set<number>;

  constructor(
    public world: World,
    private hooks: CatHooks,
    seed: string,
  ) {
    this.rng = new Rng('cat:' + seed);
    this.node = world.start;
    const n = world.nodes[world.start];
    this.x = n.x;
    this.z = n.z;
    this.heading = leaveHeading(world.edges[world.startEdge], world.start);
    this.bestDHome = world.distHome[world.start];
    this.I = {
      fatigue: 0,
      calm: 0.3,
      curiosity: 0.3,
      caution: 0.2,
      homeward: 0.55,
      lost: 0,
      energy: 0,
      perception: 0.6,
      acuity: 0.25,
      redGain: 1,
      soundGain: 1,
      explore: 0,
      rest: 0,
      farHearing: 0,
      heartbeat: 0,
      direction: 0,
      memory: 0.2,
    };
    for (const l of world.landmarks) {
      if (!this.landmarksByNode.has(l.nodeId)) this.landmarksByNode.set(l.nodeId, []);
      this.landmarksByNode.get(l.nodeId)!.push(l);
    }
    this.shortestEdges = new Set(astar(world.nodes, world.edges, world.start, world.home).edges);
    this.visitedNodes.add(world.start);
  }

  get distanceToHome(): number {
    if (this.mode === 'node') return this.world.distHome[this.node];
    const e = this.world.edges[this.edge];
    const rem = (e.length - this.s) * e.traversability;
    return Math.min(this.world.distHome[this.to] + rem, this.world.distHome[this.from] + this.s * e.traversability);
  }

  /** begin the journey from the start node */
  begin() {
    this.state = 'paused';
    this.stateT = 1;
    this.afterStop = () => this.arrive(this.world.start, -1);
  }

  setTransient(state: CatState, dur: number, then?: () => void) {
    if (this.state === 'arriving' || this.state === 'home' || this.state === 'sleeping') return;
    const prevAfter = this.afterStop;
    const wasHesitating = this.state === 'hesitating';
    this.state = state;
    this.stateT = dur;
    this.afterStop =
      then ??
      (() => {
        if (prevAfter) prevAfter();
        else if (wasHesitating || this.mode === 'node') this.startHesitation(true);
        else this.state = 'walking';
      });
  }

  /** startle / sound reaction; may turn him around mid-street when he is wary */
  react(x: number, z: number, strength: number) {
    if (STOPPED.includes(this.state) && this.state !== 'hesitating') return;
    this.look = [x, z];
    const frightened = this.I.caution > 0.6 && strength > 0.5;
    if (frightened) {
      this.I.caution = clamp(this.I.caution + 0.1);
      this.setTransient('frightened', 1.5);
    } else {
      this.setTransient('alert', 0.9);
    }
  }

  /** a startle behind him can make him turn back (bounded: once per street, only after commitment) */
  maybeReverse(): boolean {
    if (this.mode !== 'edge' || this.reversedOnEdge || this.commitT < 4) return false;
    const e = this.world.edges[this.edge];
    if (this.s < 3 || this.s > e.length - 3) return false;
    if (this.I.caution < 0.6) return false;
    this.reversedOnEdge = true;
    [this.from, this.to] = [this.to, this.from];
    this.s = e.length - this.s;
    this.approached = false;
    return true;
  }

  teleport(node: number) {
    this.mode = 'node';
    this.node = node;
    const n = this.world.nodes[node];
    this.x = n.x;
    this.z = n.z;
    this.speed = 0;
    this.afterStop = null;
    this.state = 'paused';
    this.stateT = 0.6;
    this.afterStop = () => this.arrive(node, -1);
  }

  update(dt: number, inf: Influences, homeward: number) {
    this.lastInf = inf;
    // REST is bounded: once rested he grows restless and ignores it until it is released
    if (inf.rest < 0.3) this.restless = false;
    const rest = this.restless ? 0 : inf.rest;
    this.updateInternals(dt, inf, homeward);

    if (this.state === 'idle' || this.state === 'home' || this.state === 'sleeping' || this.state === 'arriving') {
      this.speed = 0;
      return;
    }

    // transient stops
    if (this.state !== 'hesitating' && STOPPED.includes(this.state)) {
      this.speed = Math.max(0, this.speed - dt * 6);
      if (this.state === 'resting') {
        // resting lasts while REST is held or he is exhausted
        this.restT += dt;
        if (this.restT > 5 && this.I.fatigue < 0.2) this.restless = true;
        if ((rest > 0.4 && !this.restless) || this.I.fatigue > 0.6) return;
        this.stateT = Math.min(this.stateT, 0.3);
      }
      this.stateT -= dt;
      if (this.stateT <= 0) {
        const cb = this.afterStop;
        this.afterStop = null;
        if (cb) cb();
        else if (this.mode === 'edge') this.state = 'walking';
        else this.startHesitation(false);
        if ((this.state as CatState) !== 'hesitating' && this.mode === 'edge') this.look = null;
      }
      return;
    }

    if (this.state === 'hesitating') {
      this.updateHesitation(dt, inf);
      return;
    }

    // ---- moving along an edge ----
    if (this.mode !== 'edge') return;
    const e = this.world.edges[this.edge];
    const toNode = this.world.nodes[this.to];
    const remaining = e.length - this.s;
    this.commitT += dt;

    if (rest > 0.6 && this.state !== 'resting') {
      this.restT = 0;
      this.setTransient('resting', 1.5);
      return;
    }
    if (this.I.fatigue > 0.92) {
      this.restT = 0;
      this.setTransient('resting', 3);
      return;
    }

    const base = this.cfgSpeed;
    let mult =
      (0.85 + 0.9 * this.I.energy) *
      (1 - 0.45 * this.I.fatigue) *
      (1 - 0.32 * this.I.caution) *
      (1 - 0.7 * rest) *
      (1 + 0.1 * this.I.curiosity - 0.08 * this.I.calm);
    if (toNode.edges.length >= 3 && remaining < 6) mult *= 0.7;
    if (this.state === 'looking') mult *= 0.55;
    const target = clamp(base * mult, 0.35, base * 2.1);
    this.speed += clamp(target - this.speed, -dt * 4, dt * 3);
    this.s += this.speed * dt;
    this.distance += this.speed * dt;

    if (this.state === 'looking') {
      this.stateT -= dt;
      if (this.stateT <= 0) {
        this.state = 'walking';
        this.look = null;
      }
    } else {
      this.state = this.speed > base * 1.3 ? 'trotting' : 'walking';
    }

    // approaching a junction: let the hint system prepare the options
    if (!this.approached && remaining < 10 && toNode.edges.length >= 3) {
      this.approached = true;
      this.hooks.onApproach(this.to, this.edge);
    }

    // glance at landmarks he passes
    for (const lm of this.world.landmarks) {
      if (this.seenLandmarks.has(lm.id)) continue;
      const d = Math.hypot(lm.x - this.x, lm.z - this.z);
      if (d < 7) {
        this.seenLandmarks.add(lm.id);
        this.hooks.onLandmarkNear(lm);
        if (this.state === 'walking' || this.state === 'trotting') {
          this.state = 'looking';
          this.stateT = 1.4;
          this.look = [lm.x, lm.z];
        }
      }
    }

    // occasional autonomous sniffing
    this.sniffCooldown -= dt;
    if (this.sniffCooldown <= 0 && this.commitT > 3 && remaining > 5 && this.rng.chance(dt * 0.05 * (1.2 - this.I.energy))) {
      this.sniffCooldown = 12 + this.rng.range(0, 14);
      this.setTransient('sniffing', 1.3);
    }

    if (this.s >= e.length) {
      this.s = e.length;
      this.updatePose();
      this.arrive(this.to, this.edge);
      return;
    }
    this.updatePose();
  }

  cfgSpeed = 2.4;

  private updatePose() {
    if (this.mode !== 'edge') return;
    const p = sampleEdge(this.world.edges[this.edge], this.from, this.s);
    this.x = p.x;
    this.z = p.z;
    this.heading = p.heading;
  }

  private updateInternals(dt: number, inf: Influences, homeward: number) {
    const I = this.I;
    const ease = (cur: number, target: number, rate: number) => cur + (target - cur) * Math.min(1, dt * rate);
    I.perception = ease(I.perception, 0.25 + 0.75 * inf.perception, 2);
    I.redGain = inf.redGain;
    I.soundGain = inf.soundGain;
    I.acuity = ease(I.acuity, inf.acuity, 2);
    I.farHearing = inf.farHearing;
    I.explore = inf.explore;
    I.rest = inf.rest;
    I.heartbeat = inf.heartbeat;
    I.direction = inf.dir;
    I.memory = inf.memoryLevel;
    I.calm = ease(I.calm, 0.15 + 0.8 * inf.calmDrive, 0.5);
    I.curiosity = ease(I.curiosity, 0.25 + 0.75 * inf.curiosityDrive, 0.6);
    I.caution = ease(I.caution, clamp(0.12 + 0.7 * inf.cautionDrive + 0.5 * inf.restraint), 0.5);
    const energyTarget = clamp(inf.energyDrive + inf.scratch * 0.5) * (1 - 0.6 * inf.restraint);
    I.energy = ease(I.energy, energyTarget, energyTarget > I.energy ? 2 : 0.5);
    const moving = this.mode === 'edge' && !STOPPED.includes(this.state);
    I.fatigue = clamp(
      I.fatigue +
        dt * (moving ? 0.0008 + 0.012 * I.energy * I.energy + 0.01 * inf.scratch : -0.025) -
        dt * inf.rest * 0.06 -
        dt * I.calm * 0.002,
    );
    // lost: no improvement for a while
    this.tSinceBest += dt;
    I.lost = ease(I.lost, clamp((this.tSinceBest - 50) / 80), 0.3);
    I.homeward = homeward + 0.9 * I.lost;
  }

  private arrive(n: number, viaEdge: number) {
    this.mode = 'node';
    this.node = n;
    this.arriveEdge = viaEdge;
    this.edge = -1;
    const node = this.world.nodes[n];
    this.x = node.x;
    this.z = node.z;
    this.visitedNodes.add(n);
    this.hooks.onArriveNode(n);

    const dh = this.world.distHome[n];
    if (dh < this.bestDHome - 0.1) {
      this.bestDHome = dh;
      this.tSinceBest = 0;
      if (this.inDetour) {
        this.inDetour = false;
        this.hooks.onRecovered();
        this.setTransient('recovering', 1.5, () => this.afterArrival(n, viaEdge));
        return;
      }
    } else if (!this.inDetour && dh > this.bestDHome + 18) {
      this.inDetour = true;
      this.detours++;
      this.hooks.onDetour();
    }
    this.afterArrival(n, viaEdge);
  }

  private afterArrival(n: number, viaEdge: number) {
    const node = this.world.nodes[n];
    if (n === this.world.home) {
      this.state = 'arriving';
      this.speed = 0;
      this.hooks.onHome();
      return;
    }
    if (node.edges.length === 1) {
      // dead end: investigate the discovery, then turn back
      const back = node.edges[0];
      if (node.discovery && !this.discovered.has(n)) {
        this.discovered.add(n);
        this.hooks.onDiscovery(n, node.discovery);
        this.state = 'investigating';
        this.stateT = 3;
        this.look = [node.x + Math.sin(this.heading) * 1.5, node.z + Math.cos(this.heading) * 1.5];
      } else {
        this.state = 'sniffing';
        this.stateT = 1.2;
      }
      this.afterStop = () => this.commit(back, n, []);
      return;
    }
    if (node.edges.length === 2 && viaEdge >= 0) {
      // a bend: keep walking
      const next = node.edges[0] === viaEdge ? node.edges[1] : node.edges[0];
      this.commit(next, n, [], true);
      return;
    }
    this.startHesitation(false);
  }

  private startHesitation(resume: boolean) {
    if (this.mode !== 'node') {
      this.state = 'walking';
      return;
    }
    if (!resume) {
      this.junctions++;
      this.noise.clear();
      for (const eid of this.world.nodes[this.node].edges) this.noise.set(eid, this.rng.range(-0.06, 0.06));
      this.leader = -1;
      this.hesitateT = 0;
    }
    this.state = 'hesitating';
    this.options = this.score();
    this.leader = this.options[0]?.edgeId ?? -1;
    if (!resume) {
      const margin = this.options.length > 1 ? this.options[0].total - this.options[1].total : 2;
      this.hesitateDur = clamp(0.5 + (1 - clamp(margin)) * 1.8 + this.I.caution * 0.8 - this.I.energy * 0.5, 0.4, 3.2);
    }
  }

  private score(): OptionScore[] {
    return scoreOptions({
      world: this.world,
      node: this.node,
      arriveEdge: this.arriveEdge,
      I: this.I,
      inf: this.lastInf,
      hints: this.hooks.hints(),
      visits: this.visits,
      leader: this.leader,
      noise: this.noise,
      landmarksByNode: this.landmarksByNode,
      shortestEdges: this.shortestEdges,
    });
  }

  lastInf!: Influences;

  private updateHesitation(dt: number, inf: Influences) {
    this.speed = Math.max(0, this.speed - dt * 6);
    this.hesitateT += dt;
    this.options = this.score();
    this.leader = this.options[0]?.edgeId ?? this.leader;
    // look between the two strongest options while undecided
    this.lookFlip -= dt;
    if (this.lookFlip <= 0 && this.options.length) {
      const close = this.options.length > 1 && this.options[0].total - this.options[1].total < 0.35;
      const pick = close && this.rng.chance(0.5) ? this.options[1] : this.options[0];
      const p = sampleEdge(this.world.edges[pick.edgeId], this.node, 7);
      this.look = [p.x, p.z];
      this.lookFlip = close ? 0.7 : 1.2;
    }
    if (this.hesitateT >= this.hesitateDur && this.options.length) {
      const chosen = this.options[0];
      const { term, margin } = decisiveTerm(this.options);
      this.decisions++;
      const d: Decision = { t: Date.now(), node: this.node, chosen: chosen.edgeId, options: this.options, decisive: term, margin };
      this.hooks.onDecision(d);
      this.commit(chosen.edgeId, this.node, this.options);
    }
  }

  private commit(eid: number, from: number, _options: OptionScore[], keepSpeed = false) {
    const e = this.world.edges[eid];
    this.mode = 'edge';
    this.edge = eid;
    this.from = from;
    this.to = otherNode(e, from);
    this.s = 0;
    this.commitT = 0;
    this.approached = false;
    this.reversedOnEdge = false;
    this.visits.set(eid, (this.visits.get(eid) ?? 0) + 1);
    this.state = 'walking';
    this.look = null;
    if (!keepSpeed) this.speed = Math.min(this.speed, 0.6);
    this.options = [];
    this.updatePose();
  }

  snapshot(): CatSnapshot {
    return {
      x: this.x,
      z: this.z,
      heading: this.heading,
      state: this.state,
      speed: this.speed,
      look: this.look,
      edge: this.edge,
      from: this.from,
      to: this.to,
      s: this.s,
      node: this.mode === 'node' ? this.node : -1,
    };
  }

  /** the A* route he would take from here if he simply followed his instinct */
  plannedRoute(): number[] {
    const startNode = this.mode === 'node' ? this.node : this.to;
    const r = astar(this.world.nodes, this.world.edges, startNode, this.world.home);
    return this.mode === 'edge' ? [this.edge, ...r.edges] : r.edges;
  }
}
