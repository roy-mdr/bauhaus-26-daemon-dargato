// Dargato's body in the street: free movement steered by the senses, held inside
// the street corridors, plus his small autonomous reactions. Server-authoritative.
import { astar, clamp, leaveHeading, sampleEdge, wrapAngle } from '../shared/graph';
import { homeField } from '../shared/config';
import { Rng } from '../shared/rng';
import type { CatInternals, CatState, DiscoveryKind, Landmark, World } from '../shared/types';
import type { CatSnapshot } from '../shared/protocol';

export interface CatHooks {
  onHome(): void;
  onDiscovery(node: number, kind: DiscoveryKind): void;
  onDetour(): void;
  onRecovered(): void;
  onLandmarkNear(lm: Landmark): void;
  /** he entered a street (fresh: never walked before) */
  onStreet(edge: number, fresh: boolean): void;
}

/** what the senses ask of his body this tick */
export interface CatDrive {
  /** SPEED: paw rate 0..1 */
  paws: number;
  /** DIRECTION: -1 left .. 1 right */
  turn: number;
  /** MEMORY: whether there are paths to walk on, 0..1 */
  cohesion: number;
}

const TURN_RATE = 1.9; // rad/s at full tilt
const BODY = 0.3; // how close to the edge of a corridor he walks
const CELL = 8;
/** directions tried, in order, when the way straight ahead is blocked */
const FEEL = [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.1, -1.1];

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  /** half width of the walkable corridor */
  hw: number;
  edge: number;
  /** distance along the edge (from node a) where this segment starts */
  s0: number;
}

interface Disc {
  x: number;
  z: number;
  r: number;
  node: number;
}

interface Near {
  seg: Segment;
  /** distance along the edge from node a */
  s: number;
  dist: number;
  /** unit tangent from a to b */
  tx: number;
  tz: number;
}

/** the walkable area: street corridors and junction discs, with a spatial grid */
export class Walkable {
  segs: Segment[] = [];
  discs: Disc[] = [];
  private grid = new Map<string, { segs: Segment[]; discs: Disc[] }>();

  constructor(world: World) {
    for (const e of world.edges) {
      for (let i = 0; i < e.points.length - 1; i++) {
        const a = e.points[i];
        const b = e.points[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-4) continue;
        this.segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, len, hw: Math.max(0.35, e.width / 2 - BODY), edge: e.id, s0: e.cum[i] });
      }
    }
    for (const n of world.nodes) {
      const maxW = Math.max(...n.edges.map((eid) => world.edges[eid].width));
      this.discs.push({ x: n.x, z: n.z, r: Math.max(n.r, maxW / 2 + 0.3) - BODY, node: n.id });
    }
    for (const sg of this.segs) this.cover(Math.min(sg.ax, sg.bx) - sg.hw, Math.min(sg.az, sg.bz) - sg.hw, Math.max(sg.ax, sg.bx) + sg.hw, Math.max(sg.az, sg.bz) + sg.hw, (c) => c.segs.push(sg));
    for (const d of this.discs) this.cover(d.x - d.r, d.z - d.r, d.x + d.r, d.z + d.r, (c) => c.discs.push(d));
  }

  private cover(x0: number, z0: number, x1: number, z1: number, add: (c: { segs: Segment[]; discs: Disc[] }) => void) {
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = i + ',' + j;
        let c = this.grid.get(k);
        if (!c) this.grid.set(k, (c = { segs: [], discs: [] }));
        add(c);
      }
    }
  }

  private cell(x: number, z: number) {
    return this.grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
  }

  private project(sg: Segment, x: number, z: number): Near {
    const tx = (sg.bx - sg.ax) / sg.len;
    const tz = (sg.bz - sg.az) / sg.len;
    const u = clamp((x - sg.ax) * tx + (z - sg.az) * tz, 0, sg.len);
    const px = sg.ax + tx * u;
    const pz = sg.az + tz * u;
    return { seg: sg, s: sg.s0 + u, dist: Math.hypot(x - px, z - pz), tx, tz };
  }

  disc(x: number, z: number): Disc | null {
    for (const d of this.cell(x, z)?.discs ?? []) if (Math.hypot(x - d.x, z - d.z) <= d.r) return d;
    return null;
  }

  inside(x: number, z: number): boolean {
    const c = this.cell(x, z);
    if (!c) return false;
    for (const d of c.discs) if (Math.hypot(x - d.x, z - d.z) <= d.r) return true;
    for (const sg of c.segs) if (this.project(sg, x, z).dist <= sg.hw) return true;
    return false;
  }

  /** the closest corridor (searching the whole town if the local cell is empty) */
  nearest(x: number, z: number): Near {
    const local = this.cell(x, z)?.segs;
    let best: Near | null = null;
    for (const sg of local?.length ? local : this.segs) {
      const n = this.project(sg, x, z);
      if (!best || n.dist - sg.hw < best.dist - best.seg.hw) best = n;
    }
    return best!;
  }
}

export class CatSim {
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  paws = 0;
  state: CatState = 'idle';
  stateT = 0;
  look: [number, number] | null = null;
  /** street he is on (nearest corridor), position along it, and the node he is heading to */
  edge: number;
  s = 0;
  from = -1;
  to = -1;
  /** junction disc he stands in, -1 in a street */
  node: number;
  I: CatInternals;
  visits = new Map<number, number>();
  bestDHome: number;
  tSinceBest = 0;
  inDetour = false;
  detours = 0;
  distance = 0;
  seenLandmarks = new Set<number>();
  discovered = new Set<number>();
  cfgSpeed = 4.5;
  readonly walk: Walkable;
  private street = -1;
  private lookT = 0;
  private sniffCooldown = 6;
  private rng: Rng;

  constructor(
    public world: World,
    private hooks: CatHooks,
    seed: string,
  ) {
    this.rng = new Rng('cat:' + seed);
    this.walk = new Walkable(world);
    this.edge = world.startEdge;
    this.node = world.start;
    const n = world.nodes[world.start];
    this.x = n.x;
    this.z = n.z;
    this.heading = leaveHeading(world.edges[world.startEdge], world.start);
    this.bestDHome = world.distHome[world.start];
    this.I = { sight: 0.5, light: 1, glare: 0, paws: 0, turn: 0, cohesion: 1, instinct: 0, heartRate: 0, heart: 0, strain: 0, lost: 0 };
    this.track();
  }

  /** cost-weighted distance to home from where he stands */
  get distanceToHome(): number {
    const e = this.world.edges[this.edge];
    const d = this.world.distHome;
    return Math.min(d[e.a] + this.s * e.traversability, d[e.b] + (e.length - this.s) * e.traversability);
  }

  /** begin the journey from the start node */
  begin() {
    this.setTransient('paused', 1);
  }

  setTransient(state: CatState, dur: number) {
    if (this.state === 'arriving' || this.state === 'home' || this.state === 'sleeping') return;
    this.state = state;
    this.stateT = dur;
  }

  /** startle / sound reaction: a short stop with the ears up */
  react(x: number, z: number) {
    if (this.stateT > 0) return;
    this.look = [x, z];
    this.setTransient('alert', 0.9);
  }

  teleport(node: number) {
    const n = this.world.nodes[node];
    this.x = n.x;
    this.z = n.z;
    this.speed = 0;
    this.setTransient('paused', 0.6);
    this.track();
  }

  update(dt: number, d: CatDrive) {
    this.paws = d.paws * this.cfgSpeed;
    if (this.state === 'idle' || this.state === 'home' || this.state === 'sleeping' || this.state === 'arriving') {
      this.speed = 0;
      return;
    }
    this.tSinceBest += dt;
    this.I.lost += (clamp((this.tSinceBest - 60) / 90) - this.I.lost) * Math.min(1, dt * 0.3);

    // DIRECTION turns him at any moment, also when he stands still
    this.heading = wrapAngle(this.heading - d.turn * TURN_RATE * dt);

    // short autonomous stops (startled, sniffing, a discovery)
    if (this.stateT > 0) {
      this.stateT -= dt;
      this.speed = Math.max(0, this.speed - dt * 6);
      if (this.stateT <= 0) this.look = null;
      return;
    }

    // SPEED moves the paws; MEMORY decides whether there is a path under them
    const path = smooth(0.2, 0.55, d.cohesion);
    const target = this.cfgSpeed * d.paws * path * (this.lookT > 0 ? 0.6 : 1);
    this.speed += clamp(target - this.speed, -dt * 7, dt * 4.5);

    // with no hand on the direction he follows the street he is in
    const inDisc = this.walk.disc(this.x, this.z);
    if (Math.abs(d.turn) < 0.15 && this.speed > 0.2 && !inDisc) {
      const n = this.walk.nearest(this.x, this.z);
      const along = Math.atan2(n.tx, n.tz);
      const fwd = Math.abs(wrapAngle(along - this.heading)) < Math.PI / 2 ? along : wrapAngle(along + Math.PI);
      const diff = wrapAngle(fwd - this.heading);
      if (Math.abs(diff) < 1) this.heading = wrapAngle(this.heading + diff * Math.min(1, dt * 2.2));
    }

    const moved = this.move(this.speed * dt, dt);
    this.distance += moved;
    if (moved < this.speed * dt * 0.3) this.speed *= 0.5;

    if (this.lookT > 0) {
      this.lookT -= dt;
      if (this.lookT <= 0) this.look = null;
    }
    if (this.speed > 0.2) this.state = this.lookT > 0 ? 'looking' : this.speed > this.cfgSpeed * 0.6 ? 'trotting' : 'walking';
    // paws moving without a path to walk on: treading, looking for the street
    else this.state = d.paws > 0.15 ? 'hesitating' : 'paused';

    this.track();
    this.senseSurroundings(dt);
  }

  /**
   * A step forward that never leaves the streets: against a wall he slides along it,
   * or feels his way around the corner, and his heading follows.
   */
  private move(step: number, dt: number): number {
    if (step <= 0) return 0;
    for (const a of FEEL) {
      const h = this.heading + a;
      const fx = Math.sin(h) * step * Math.cos(a);
      const fz = Math.cos(h) * step * Math.cos(a);
      if (this.walk.inside(this.x + fx, this.z + fz)) {
        this.x += fx;
        this.z += fz;
        this.heading = wrapAngle(this.heading + a * Math.min(1, dt * 5));
        return step * Math.cos(a);
      }
    }
    return 0;
  }

  /** which street, where along it, which junction; streets walked; detours */
  private track() {
    const n = this.walk.nearest(this.x, this.z);
    const e = this.world.edges[n.seg.edge];
    const disc = this.walk.disc(this.x, this.z);
    this.node = disc ? disc.node : -1;
    // a street counts once he is out of the junction and in it
    if (!disc && n.seg.edge !== this.street) {
      this.street = n.seg.edge;
      const fresh = !this.visits.has(n.seg.edge);
      this.visits.set(n.seg.edge, (this.visits.get(n.seg.edge) ?? 0) + 1);
      this.hooks.onStreet(n.seg.edge, fresh);
    }
    this.edge = n.seg.edge;
    this.s = n.s;
    const forward = Math.sin(this.heading) * n.tx + Math.cos(this.heading) * n.tz >= 0;
    this.from = forward ? e.a : e.b;
    this.to = forward ? e.b : e.a;

    const dh = this.distanceToHome;
    if (dh < this.bestDHome - 1) {
      this.bestDHome = dh;
      this.tSinceBest = 0;
      if (this.inDetour) {
        this.inDetour = false;
        this.hooks.onRecovered();
      }
    } else if (!this.inDetour && dh > this.bestDHome + 18) {
      this.inDetour = true;
      this.detours++;
      this.hooks.onDetour();
    }
  }

  private senseSurroundings(dt: number) {
    // home is an open field: he has arrived once he is well inside it
    const home = this.world.nodes[this.world.home];
    if (this.node === this.world.home || Math.hypot(this.x - home.x, this.z - home.z) < homeField(home.r).arrive) {
      this.state = 'arriving';
      this.speed = 0;
      this.hooks.onHome();
      return;
    }
    // a dead end with something in it
    if (this.node >= 0) {
      const node = this.world.nodes[this.node];
      if (node.discovery && node.edges.length === 1 && !this.discovered.has(node.id)) {
        this.discovered.add(node.id);
        this.hooks.onDiscovery(node.id, node.discovery);
        this.look = [node.x + Math.sin(this.heading) * 1.5, node.z + Math.cos(this.heading) * 1.5];
        this.setTransient('investigating', 3);
        return;
      }
    }
    // glance at landmarks he passes
    for (const lm of this.world.landmarks) {
      if (this.seenLandmarks.has(lm.id)) continue;
      if (Math.hypot(lm.x - this.x, lm.z - this.z) < 7) {
        this.seenLandmarks.add(lm.id);
        this.hooks.onLandmarkNear(lm);
        if (this.speed > 0.2) {
          this.lookT = 1.4;
          this.look = [lm.x, lm.z];
        }
      }
    }
    // an occasional sniff when he dawdles
    this.sniffCooldown -= dt;
    if (this.sniffCooldown <= 0 && this.speed > 0.2 && this.speed < this.cfgSpeed * 0.4 && this.rng.chance(dt * 0.06)) {
      this.sniffCooldown = 12 + this.rng.range(0, 14);
      this.setTransient('sniffing', 1.3);
    }
  }

  snapshot(): CatSnapshot {
    return {
      x: this.x,
      z: this.z,
      heading: this.heading,
      state: this.state,
      speed: this.speed,
      look: this.look,
      paws: this.paws,
      edge: this.edge,
      from: this.from,
      to: this.to,
      s: this.s,
      node: this.node,
    };
  }

  /** the shortest way home from where he stands: his current street first */
  plannedRoute(): number[] {
    const e = this.world.edges[this.edge];
    const d = this.world.distHome;
    const viaA = d[e.a] + this.s * e.traversability;
    const viaB = d[e.b] + (e.length - this.s) * e.traversability;
    const exit = viaA < viaB ? e.a : e.b;
    if (exit === this.world.home) return [e.id];
    const r = astar(this.world.nodes, this.world.edges, exit, this.world.home);
    return r.edges[0] === e.id ? r.edges : [e.id, ...r.edges];
  }

  /** the turn (-1..1, + = right) that points him along the shortest way home */
  steerHome(): number {
    const route = this.plannedRoute();
    // aim a few metres ahead along the route
    let target: { x: number; z: number };
    const e = this.world.edges[route[0]];
    const towardB = route.length > 1 ? this.world.edges[route[1]].a === e.b || this.world.edges[route[1]].b === e.b : e.b === this.world.home;
    const exit = this.world.nodes[towardB ? e.b : e.a];
    const remaining = towardB ? e.length - this.s : this.s;
    if (remaining > 5 || route.length === 1) target = sampleEdge(e, e.a, towardB ? this.s + 5 : this.s - 5);
    else {
      const next = this.world.edges[route[1]];
      target = sampleEdge(next, exit.id, 5 - remaining);
    }
    const want = Math.atan2(target.x - this.x, target.z - this.z);
    return clamp(-wrapAngle(want - this.heading) * 1.4, -1, 1);
  }
}

function smooth(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
