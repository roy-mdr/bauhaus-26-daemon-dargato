// Procedural street-network generation.
//
// Pipeline (all seeded, deterministic for a given seed + params):
//  1. irregular, perturbed street grid (column/row widths vary, lines bend)
//  2. remove a few nodes to create larger blocks and irregular gaps
//  3. randomized spanning tree (Kruskal) -> guaranteed connectivity
//  4. extra edges -> loops and alternate routes (fewer near the start, more later)
//  5. diagonal pedestrian shortcuts, dead-end stubs with discoveries, curved streets
//  6. clearance validation (no crossings, no corridors touching) with local repairs
//  7. start + distant home: set apart from the district at the end of its own street,
//     chosen by graph distance to target a 5-10 minute journey
//  8. widths, surfaces, effects, plazas, landmarks, route-hint strengths
//  9. final connectivity + reachability validation

import { Rng } from './rng';
import { astar, computeCum, dijkstra, edgeCost, leaveHeading, otherNode, reachable } from './graph';
import type {
  DiscoveryKind,
  EdgeEffect,
  EdgeKind,
  GraphEdge,
  GraphNode,
  Landmark,
  LandmarkKind,
  Surface,
  Vec2,
  World,
  WorldParams,
} from './types';

export const DEFAULT_WORLD_PARAMS: WorldParams = {
  cols: 10,
  rows: 8,
  spacing: 22,
  jitter: 0.18,
  removeNodeChance: 0.07,
  extraEdgeChance: 0.42,
  diagonalChance: 0.16,
  curveChance: 0.26,
  stubCount: 6,
  targetPathLength: 380,
  nominalSpeed: 2.0,
};

interface ProtoNode {
  x: number;
  z: number;
  gi: number;
  gj: number;
  alive: boolean;
  stub: boolean;
  gp: number; // geometric progress estimate start -> far corner
}

interface ProtoEdge {
  a: number;
  b: number;
  kind: EdgeKind;
  tree: boolean;
  diag: boolean;
  stub: boolean;
  bulge: number; // signed fraction of length
  removed: boolean;
}

const WIDTH: Record<EdgeKind, number> = { main: 7.5, street: 5, alley: 2.6, path: 2.2 };

/** length of home's own street out of the district */
const HOME_REACH = 44;
/** no other crossing comes closer to home than this (its red field reaches homeField(r).radius) */
const HOME_GAP = 40;

function segPointDist(a: Vec2, b: Vec2, x: number, z: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}

export function generateWorld(seed: string, params: Partial<WorldParams> = {}): World {
  const p = { ...DEFAULT_WORLD_PARAMS, ...params };
  let lastErr = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = attemptWorld(seed, attempt, p);
    if (typeof res !== 'string') return res;
    lastErr = res;
  }
  throw new Error(`world generation failed for seed "${seed}": ${lastErr}`);
}

function polyline(a: Vec2, b: Vec2, bulge: number): Vec2[] {
  if (!bulge) return [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const px = -dz / len;
  const pz = dx / len;
  const off = bulge * len * 2;
  const cx = (a.x + b.x) / 2 + px * off;
  const cz = (a.z + b.z) / 2 + pz * off;
  const pts: Vec2[] = [];
  const N = 14;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, z: u * u * a.z + 2 * u * t * cz + t * t * b.z });
  }
  return pts;
}

function resample(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

function attemptWorld(seed: string, attempt: number, p: WorldParams): World | string {
  const rng = new Rng(`world:${seed}:${attempt}`);
  const { cols, rows, spacing } = p;

  // ---- 1. irregular grid ----
  const colW: number[] = [];
  for (let i = 0; i < cols - 1; i++) colW.push(spacing * rng.range(0.78, 1.22));
  const rowW: number[] = [];
  for (let j = 0; j < rows - 1; j++) rowW.push(spacing * rng.range(0.78, 1.22));
  const colX = [0];
  for (const w of colW) colX.push(colX[colX.length - 1] + w);
  const rowZ = [0];
  for (const w of rowW) rowZ.push(rowZ[rowZ.length - 1] + w);
  const cx0 = colX[colX.length - 1] / 2;
  const cz0 = rowZ[rowZ.length - 1] / 2;
  const phA = rng.range(0, Math.PI * 2);
  const phB = rng.range(0, Math.PI * 2);
  const warp = spacing * 0.16;
  const rot = rng.range(-0.25, 0.25);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);

  const proto: ProtoNode[] = [];
  const gid = (i: number, j: number) => j * cols + i;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let x = colX[i] - cx0 + Math.sin(j * 0.7 + phA + i * 0.25) * warp * 0.6;
      let z = rowZ[j] - cz0 + Math.sin(i * 0.6 + phB + j * 0.2) * warp * 0.6;
      x += rng.range(-1, 1) * p.jitter * spacing * 0.5;
      z += rng.range(-1, 1) * p.jitter * spacing * 0.5;
      const rx = x * cr - z * sr;
      const rz = x * sr + z * cr;
      proto.push({ x: rx, z: rz, gi: i, gj: j, alive: true, stub: false, gp: 0 });
    }
  }

  // start near a random corner; geometric progress axis toward the opposite corner
  const corner = rng.int(0, 3);
  const ci = corner & 1 ? cols - 1 : 0;
  const cj = corner & 2 ? rows - 1 : 0;
  const si = ci === 0 ? rng.int(0, 1) : cols - 1 - rng.int(0, 1);
  const sj = cj === 0 ? rng.int(0, 1) : rows - 1 - rng.int(0, 1);
  const startG = gid(si, sj);
  const far = proto[gid(cols - 1 - ci, rows - 1 - cj)];
  const sP = proto[startG];
  const ax = far.x - sP.x;
  const az = far.z - sP.z;
  const aL2 = ax * ax + az * az;
  for (const n of proto) n.gp = Math.max(0, Math.min(1, ((n.x - sP.x) * ax + (n.z - sP.z) * az) / aL2));

  // ---- 2. remove nodes ----
  for (const n of proto) {
    const border = n.gi === 0 || n.gj === 0 || n.gi === cols - 1 || n.gj === rows - 1;
    const nearStart = Math.abs(n.gi - si) <= 1 && Math.abs(n.gj - sj) <= 1;
    if (nearStart) continue;
    if (rng.chance(p.removeNodeChance * (border ? 0.5 : 1))) n.alive = false;
  }

  // ---- 3. candidates + spanning tree ----
  const mainRows = new Set<number>([rng.int(1, rows - 2)]);
  const mainCols = new Set<number>([rng.int(1, cols - 2)]);
  if (cols >= 7 && rng.chance(0.6)) {
    const c2 = rng.int(1, cols - 2);
    if (Math.abs(c2 - [...mainCols][0]) >= 3) mainCols.add(c2);
  }
  const cand: ProtoEdge[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = gid(i, j);
      if (!proto[a].alive) continue;
      if (i + 1 < cols && proto[gid(i + 1, j)].alive) {
        cand.push({ a, b: gid(i + 1, j), kind: mainRows.has(j) ? 'main' : 'street', tree: false, diag: false, stub: false, bulge: 0, removed: false });
      }
      if (j + 1 < rows && proto[gid(i, j + 1)].alive) {
        cand.push({ a, b: gid(i, j + 1), kind: mainCols.has(i) ? 'main' : 'street', tree: false, diag: false, stub: false, bulge: 0, removed: false });
      }
    }
  }
  const parent = proto.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const order = rng.shuffle(cand.slice()).sort((e1, e2) => (e1.kind === 'main' ? 0 : 1) - (e2.kind === 'main' ? 0 : 1));
  for (const e of order) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) {
      parent[ra] = rb;
      e.tree = true;
    }
  }
  const root = find(startG);
  for (let k = 0; k < proto.length; k++) if (proto[k].alive && find(k) !== root) proto[k].alive = false;

  // ---- 4. loops / alternate routes ----
  const edges: ProtoEdge[] = [];
  for (const e of cand) {
    if (!proto[e.a].alive || !proto[e.b].alive) continue;
    if (e.tree || e.kind === 'main') {
      edges.push(e);
      continue;
    }
    const gp = (proto[e.a].gp + proto[e.b].gp) / 2;
    let chance = p.extraEdgeChance * (0.35 + 0.9 * gp);
    if (gp < 0.12) chance *= 0.4;
    if (rng.chance(chance)) edges.push(e);
  }

  // ---- 5a. diagonal pedestrian shortcuts ----
  const cellState: string[] = new Array((cols - 1) * (rows - 1)).fill('free');
  const cid = (i: number, j: number) => j * (cols - 1) + i;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const c = [gid(i, j), gid(i + 1, j), gid(i, j + 1), gid(i + 1, j + 1)];
      if (!c.every((k) => proto[k].alive)) continue;
      const gp = c.reduce((s, k) => s + proto[k].gp, 0) / 4;
      if (!rng.chance(p.diagonalChance * (0.3 + gp))) continue;
      const flip = rng.chance(0.5);
      edges.push({ a: flip ? c[0] : c[1], b: flip ? c[3] : c[2], kind: 'path', tree: false, diag: true, stub: false, bulge: 0, removed: false });
      cellState[cid(i, j)] = 'diag';
    }
  }

  // ---- 5b. dead-end stubs ----
  const cellCenter = (i: number, j: number): Vec2 | null => {
    const c = [gid(i, j), gid(i + 1, j), gid(i, j + 1), gid(i + 1, j + 1)].map((k) => proto[k]);
    return { x: c.reduce((s, n) => s + n.x, 0) / 4, z: c.reduce((s, n) => s + n.z, 0) / 4 };
  };
  const stubCells = rng.shuffle([...Array(cellState.length).keys()]);
  let stubs = 0;
  for (const c of stubCells) {
    if (stubs >= p.stubCount) break;
    if (cellState[c] !== 'free') continue;
    const i = c % (cols - 1);
    const j = Math.floor(c / (cols - 1));
    const corners = [gid(i, j), gid(i + 1, j), gid(i, j + 1), gid(i + 1, j + 1)].filter((k) => proto[k].alive);
    if (corners.length < 3) continue;
    const gp = corners.reduce((s, k) => s + proto[k].gp, 0) / corners.length;
    if (gp < 0.18 || gp > 0.92) continue;
    const from = rng.pick(corners);
    const center = cellCenter(i, j)!;
    const fn = proto[from];
    const ang = Math.atan2(center.x - fn.x, center.z - fn.z) + rng.range(-0.28, 0.28);
    const len = Math.hypot(center.x - fn.x, center.z - fn.z) * rng.range(0.5, 0.62);
    const sn: ProtoNode = { x: fn.x + Math.sin(ang) * len, z: fn.z + Math.cos(ang) * len, gi: -1, gj: -1, alive: true, stub: true, gp };
    proto.push(sn);
    edges.push({ a: from, b: proto.length - 1, kind: 'alley', tree: false, diag: false, stub: true, bulge: 0, removed: false });
    cellState[c] = 'stub';
    stubs++;
  }

  // ---- 5c. kinds + curves ----
  for (const e of edges) {
    if (e.kind !== 'street') continue;
    const gp = (proto[e.a].gp + proto[e.b].gp) / 2;
    if (rng.chance(0.1 + 0.42 * gp)) e.kind = 'alley';
  }
  for (const e of edges) {
    if (e.diag || e.stub || e.kind === 'main') continue;
    const gp = (proto[e.a].gp + proto[e.b].gp) / 2;
    if (!rng.chance(p.curveChance * (0.4 + gp))) continue;
    const A = proto[e.a];
    const B = proto[e.b];
    // the two cells bordering this grid edge
    const horizontal = A.gj === B.gj;
    const i0 = Math.min(A.gi, B.gi);
    const j0 = Math.min(A.gj, B.gj);
    const sides = horizontal ? [[i0, j0 - 1], [i0, j0]] : [[i0 - 1, j0], [i0, j0]];
    const options: { sign: number }[] = [];
    for (const [ci2, cj2] of sides) {
      if (ci2 < 0 || cj2 < 0 || ci2 >= cols - 1 || cj2 >= rows - 1) continue;
      if (cellState[cid(ci2, cj2)] !== 'free') continue;
      const cc = cellCenter(ci2, cj2)!;
      const dx = B.x - A.x;
      const dz = B.z - A.z;
      const sign = Math.sign(-dz * (cc.x - (A.x + B.x) / 2) + dx * (cc.z - (A.z + B.z) / 2)) || 1;
      options.push({ sign });
    }
    if (!options.length) continue;
    e.bulge = rng.pick(options).sign * rng.range(0.09, 0.15);
  }

  // ---- 6. clearance validation with repairs ----
  for (let pass = 0; pass < 6; pass++) {
    const conflicts = findConflicts(proto, edges);
    if (!conflicts.length) break;
    let fixed = false;
    for (const [e1, e2] of conflicts) {
      const pair = e2 < 0 ? [edges[e1]] : [edges[e1], edges[e2]];
      if (pair.some((e) => e.removed)) continue;
      const curved = pair.find((e) => e.bulge !== 0);
      if (curved) {
        curved.bulge = 0;
        fixed = true;
        continue;
      }
      const removable = pair.find((e) => e.stub) ?? pair.find((e) => e.diag) ?? pair.find((e) => !e.tree && e.kind !== 'main');
      if (removable) {
        removable.removed = true;
        if (removable.stub) proto[removable.b].alive = false;
        fixed = true;
      }
    }
    if (!fixed) return 'unrepairable street conflicts';
    if (pass === 5 && findConflicts(proto, edges).length) return 'conflicts remain';
  }

  // ---- build final graph ----
  const remap = new Map<number, number>();
  const nodes: GraphNode[] = [];
  const live = edges.filter((e) => !e.removed && proto[e.a].alive && proto[e.b].alive);
  const used = new Set<number>();
  for (const e of live) {
    used.add(e.a);
    used.add(e.b);
  }
  for (let k = 0; k < proto.length; k++) {
    const n = proto[k];
    if (!n.alive || !used.has(k)) continue;
    remap.set(k, nodes.length);
    nodes.push({ id: nodes.length, x: n.x, z: n.z, kind: 'junction', r: 2, gi: n.gi, gj: n.gj, progress: 0, edges: [] });
  }
  const gEdges: GraphEdge[] = [];
  for (const e of live) {
    const a = remap.get(e.a)!;
    const b = remap.get(e.b)!;
    const points = polyline(nodes[a], nodes[b], e.bulge);
    const cum = computeCum(points);
    const width = WIDTH[e.kind] * rng.range(0.92, 1.08);
    const surface: Surface =
      e.kind === 'main' ? 'asphalt' : e.kind === 'path' ? 'gravel' : e.kind === 'alley' ? rng.pick(['cobble', 'paved'] as const) : rng.pick(['asphalt', 'cobble', 'paved'] as const);
    let effect: EdgeEffect = 'none';
    const r = rng.next();
    if (e.kind === 'alley') effect = r < 0.3 ? 'fog' : r < 0.55 ? 'echo' : 'none';
    else if (e.kind === 'street') effect = r < 0.22 ? 'puddles' : 'none';
    else if (e.kind === 'path') effect = r < 0.25 ? 'wind' : 'none';
    else if (e.kind === 'main') effect = r < 0.15 ? 'puddles' : 'none';
    const trav = { main: 1, street: 1.05, alley: 1.15, path: 1.1 }[e.kind] * (e.bulge ? 1.06 : 1);
    const hintBase = { main: [0.35, 0.2], street: [0.5, 0.3], alley: [0.7, 0.3], path: [0.6, 0.3] }[e.kind];
    const ge: GraphEdge = {
      id: gEdges.length,
      a,
      b,
      kind: e.kind,
      width,
      surface,
      length: cum[cum.length - 1],
      traversability: trav,
      landmarkVisibility: 0.2 + rng.next() * 0.3,
      hintStrength: hintBase[0] + rng.next() * hintBase[1],
      effect,
      curved: e.bulge !== 0,
      points,
      cum,
    };
    gEdges.push(ge);
    nodes[a].edges.push(ge.id);
    nodes[b].edges.push(ge.id);
  }

  const start = remap.get(startG);
  if (start === undefined) return 'start removed';
  const reach = reachable(nodes, gEdges, start);
  if (reach.size !== nodes.length) return 'disconnected island';

  // node radii from incident widths
  for (const n of nodes) {
    let w = 0;
    for (const eid of n.edges) w = Math.max(w, gEdges[eid].width);
    n.r = w / 2 + 1.0;
  }

  // ---- 7. home selection ----
  // home never sits among the other crossings: it lies apart from the district, at the end of
  // its own street leading out from an anchor node chosen for the length of the journey
  const dStart = dijkstra(nodes, gEdges, start);
  const startNode = nodes[start];
  const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
  const cz = nodes.reduce((s, n) => s + n.z, 0) / nodes.length;
  const anchors = nodes
    .filter((n) => {
      if (n.id === start || n.edges.length > 3) return false;
      const pn = proto[[...remap.entries()].find(([, v]) => v === n.id)![0]];
      return !pn.stub && pn.gp >= 0.45;
    })
    .map((n) => ({ n, score: Math.abs(dStart[n.id] + HOME_REACH - p.targetPathLength) + rng.next() * 8 }))
    .sort((a, b) => a.score - b.score);
  let spot: { anchor: GraphNode; x: number; z: number } | null = null;
  for (const { n } of anchors.slice(0, 40)) {
    // outward: away from its own streets and from the middle of the district
    let ox = n.x - cx;
    let oz = n.z - cz;
    for (const eid of n.edges) {
      const m = nodes[otherNode(gEdges[eid], n.id)];
      const d = Math.hypot(n.x - m.x, n.z - m.z) || 1;
      ox += ((n.x - m.x) / d) * 30;
      oz += ((n.z - m.z) / d) * 30;
    }
    const base = Math.atan2(ox, oz);
    for (const dev of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
      const a = base + dev;
      // keep clear of its own streets leaving the anchor
      if (n.edges.some((eid) => Math.abs(Math.atan2(Math.sin(a - leaveHeading(gEdges[eid], n.id)), Math.cos(a - leaveHeading(gEdges[eid], n.id)))) < 0.7)) continue;
      const x = n.x + Math.sin(a) * HOME_REACH;
      const z = n.z + Math.cos(a) * HOME_REACH;
      if (nodes.some((m) => m.id !== n.id && Math.hypot(m.x - x, m.z - z) < HOME_GAP)) continue;
      // no other street near home, and the new street touches none of them
      let clear = true;
      for (const e of gEdges) {
        if (e.a === n.id || e.b === n.id) continue;
        for (let k = 1; k < e.points.length && clear; k++) {
          const q0 = e.points[k - 1];
          const q1 = e.points[k];
          if (segPointDist(q0, q1, x, z) - e.width / 2 < HOME_GAP - 6) clear = false;
          for (let t = 0.2; t <= 1 && clear; t += 0.1) {
            if (segPointDist(q0, q1, n.x + (x - n.x) * t, n.z + (z - n.z) * t) - e.width / 2 < 9) clear = false;
          }
        }
        if (!clear) break;
      }
      if (clear) {
        spot = { anchor: n, x, z };
        break;
      }
    }
    if (spot) break;
  }
  if (!spot) return 'no home candidate';
  const home = nodes.length;
  nodes.push({ id: home, x: spot.x, z: spot.z, kind: 'junction', r: 2, gi: -1, gj: -1, progress: 0, edges: [] });
  {
    const points = polyline(spot.anchor, nodes[home], 0);
    const cum = computeCum(points);
    const ge: GraphEdge = {
      id: gEdges.length,
      a: spot.anchor.id,
      b: home,
      kind: 'street',
      width: WIDTH.street,
      surface: 'paved',
      length: cum[cum.length - 1],
      traversability: 1.05,
      landmarkVisibility: 0.4,
      hintStrength: 0.6,
      effect: 'none',
      curved: false,
      points,
      cum,
    };
    gEdges.push(ge);
    spot.anchor.edges.push(ge.id);
    nodes[home].edges.push(ge.id);
  }
  const distHome = dijkstra(nodes, gEdges, home);
  for (const n of nodes) {
    const ds = dStart[n.id];
    const dh = distHome[n.id];
    n.progress = ds + dh > 0 ? ds / (ds + dh) : 0;
  }

  // ---- 8. node kinds, plazas, discoveries ----
  const discoveries: DiscoveryKind[] = ['fish-bones', 'red-collar', 'sleeping-cat', 'mirror', 'yarn', 'empty-bowl'];
  for (const n of nodes) {
    const deg = n.edges.length;
    n.kind = deg === 1 ? 'deadend' : deg === 2 ? 'bend' : 'junction';
    if (n.kind === 'deadend' && n.id !== start && n.id !== home) n.discovery = rng.pick(discoveries);
  }
  const homeNode = nodes[home];
  homeNode.kind = 'home';
  homeNode.r = 10;
  homeNode.discovery = undefined;
  startNode.kind = 'start';
  startNode.r = Math.max(startNode.r, 5);

  const clearance = (n: GraphNode) => {
    let c = Infinity;
    for (const e of gEdges) {
      if (e.a === n.id || e.b === n.id) {
        c = Math.min(c, e.length * 0.36);
        continue;
      }
      for (const pt of resample(e.points, 1.5)) c = Math.min(c, Math.hypot(pt.x - n.x, pt.z - n.z) - e.width / 2 - 1.5);
    }
    for (const m of nodes) if (m.id !== n.id) c = Math.min(c, Math.hypot(m.x - n.x, m.z - n.z) - m.r - 2);
    return c;
  };
  if (clearance(homeNode) < 8) homeNode.r = Math.max(6, clearance(homeNode));
  const plazaCands = rng.shuffle(nodes.filter((n) => n.kind === 'junction' && n.edges.length >= 3 && n.progress > 0.2 && n.progress < 0.85));
  let plazas = 0;
  for (const n of plazaCands) {
    if (plazas >= 3) break;
    const c = clearance(n);
    if (c < 6) continue;
    n.kind = 'plaza';
    n.r = Math.min(c, rng.range(6.5, 9));
    plazas++;
  }

  // ---- landmarks ----
  const path = astar(nodes, gEdges, start, home);
  if (!path.edges.length) return 'home unreachable';
  const onPath = new Set(path.nodes);
  const landmarks: Landmark[] = [];
  const taken = new Set<string>();
  const addLandmark = (kind: LandmarkKind, nodeId: number, edgeId: number, meaning: Landmark['meaning']) => {
    const key = `${nodeId}:${edgeId}`;
    if (taken.has(key)) return;
    taken.add(key);
    const n = nodes[nodeId];
    const e = gEdges[edgeId];
    const h = leaveHeading(e, nodeId);
    const side = rng.chance(0.5) ? 1 : -1;
    const fwd = n.r + 1.2;
    const lat = e.width / 2 + 0.9;
    const x = n.x + Math.sin(h) * fwd + Math.cos(h) * lat * side;
    const z = n.z + Math.cos(h) * fwd - Math.sin(h) * lat * side;
    landmarks.push({ id: landmarks.length, kind, nodeId, edgeId, x, z, facing: h, meaning });
    e.landmarkVisibility = 1;
    for (const eid of n.edges) gEdges[eid].landmarkVisibility = Math.max(gEdges[eid].landmarkVisibility, 0.6);
  };
  const trueKinds: LandmarkKind[] = ['red-lamp', 'red-door', 'red-window', 'red-scarf', 'red-umbrella'];
  for (let k = 1; k < path.nodes.length - 1; k++) {
    const nid = path.nodes[k];
    if (nodes[nid].edges.length < 3) continue;
    if (rng.chance(0.42)) addLandmark(rng.pick(trueKinds), nid, path.edges[k], 'true');
  }
  const ambKinds: LandmarkKind[] = ['red-chair', 'red-bicycle', 'silhouette', 'red-umbrella', 'red-door'];
  const junctions = rng.shuffle(nodes.filter((n) => n.edges.length >= 3 && n.id !== start && n.id !== home));
  let amb = 0;
  for (const n of junctions) {
    if (amb >= 6) break;
    const offPath = n.edges.filter((eid) => !path.edges.includes(eid));
    if (!offPath.length) continue;
    addLandmark(rng.pick(ambKinds), n.id, rng.pick(offPath), 'ambiguous');
    amb++;
  }
  // memory: a red chair at the start, echoed somewhere later (deja-vu)
  addLandmark('red-chair', start, startNode.edges[0], 'memory');
  const echo = junctions.find((n) => n.progress > 0.45 && n.progress < 0.8 && !onPath.has(n.id)) ?? junctions.find((n) => n.progress > 0.4);
  if (echo) addLandmark('red-chair', echo.id, rng.pick(echo.edges), 'memory');
  for (const n of rng.shuffle(nodes.filter((m) => m.kind === 'junction')).slice(0, 2)) addLandmark('roof-cat', n.id, rng.pick(n.edges), 'ambiguous');

  // initial facing: toward the best first step (Dargato knows roughly where home is)
  let startEdge = startNode.edges[0];
  let bestD = Infinity;
  for (const eid of startNode.edges) {
    const d = distHome[otherNode(gEdges[eid], start)];
    if (d < bestD) {
      bestD = d;
      startEdge = eid;
    }
  }

  // ---- stats ----
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z);
    maxZ = Math.max(maxZ, n.z);
  }
  const junctionsOnPath = path.nodes.filter((nid) => nodes[nid].edges.length >= 3).length;
  const pathLen = path.edges.reduce((s, eid) => s + gEdges[eid].length, 0);
  const estDurationSec = Math.round((pathLen / p.nominalSpeed + junctionsOnPath * 1.8) * 1.45 + 10);

  const world: World = {
    seed,
    params: p,
    nodes,
    edges: gEdges,
    landmarks,
    start,
    home,
    startEdge,
    distHome,
    attempts: attempt + 1,
    stats: {
      nodes: nodes.length,
      edges: gEdges.length,
      loops: gEdges.length - nodes.length + 1,
      deadEnds: nodes.filter((n) => n.kind === 'deadend').length,
      tJunctions: nodes.filter((n) => n.edges.length === 3).length,
      crossroads: nodes.filter((n) => n.edges.length >= 4).length,
      plazas,
      alleys: gEdges.filter((e) => e.kind === 'alley').length,
      paths: gEdges.filter((e) => e.kind === 'path').length,
      curved: gEdges.filter((e) => e.curved).length,
      mainStreets: gEdges.filter((e) => e.kind === 'main').length,
      shortestPathLength: Math.round(pathLen),
      junctionsOnPath,
      estDurationSec,
      bounds: { minX, maxX, minZ, maxZ },
    },
  };
  const v = validateWorld(world);
  if (v) return v;
  return world;
}

function findConflicts(proto: ProtoNode[], edges: ProtoEdge[]): [number, number][] {
  const CELL = 6;
  const grid = new Map<string, { e: number; x: number; z: number; hw: number }[]>();
  const samples: { e: number; x: number; z: number; hw: number }[][] = [];
  edges.forEach((e, idx) => {
    if (e.removed || !proto[e.a].alive || !proto[e.b].alive) {
      samples.push([]);
      return;
    }
    const pts = resample(polyline(proto[e.a], proto[e.b], e.bulge), 1);
    const hw = WIDTH[e.kind] * 0.55;
    const list = pts.map((pt) => ({ e: idx, x: pt.x, z: pt.z, hw }));
    samples.push(list);
    for (const s of list) {
      const key = `${Math.floor(s.x / CELL)},${Math.floor(s.z / CELL)}`;
      let arr = grid.get(key);
      if (!arr) grid.set(key, (arr = []));
      arr.push(s);
    }
  });
  const conflicts = new Set<string>();
  const out: [number, number][] = [];
  edges.forEach((e, idx) => {
    for (const s of samples[idx]) {
      const gx = Math.floor(s.x / CELL);
      const gz = Math.floor(s.z / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = grid.get(`${gx + dx},${gz + dz}`);
          if (!arr) continue;
          for (const o of arr) {
            if (o.e <= idx) continue;
            const f = edges[o.e];
            if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
            if (Math.hypot(o.x - s.x, o.z - s.z) < s.hw + o.hw + 1.5) {
              const key = `${idx}:${o.e}`;
              if (!conflicts.has(key)) {
                conflicts.add(key);
                out.push([idx, o.e]);
              }
            }
          }
        }
      }
    }
  });
  // edges passing too close to unrelated nodes
  edges.forEach((e, idx) => {
    for (let k = 0; k < proto.length; k++) {
      const n = proto[k];
      if (!n.alive || k === e.a || k === e.b) continue;
      for (const s of samples[idx]) {
        if (Math.hypot(n.x - s.x, n.z - s.z) < s.hw + 3.5) {
          // blame the stub leading to that node when there is one (it is removable)
          const stubEdge = n.stub ? edges.findIndex((f) => !f.removed && f.stub && f.b === k) : -1;
          out.push(stubEdge >= 0 ? [stubEdge, -1] : [idx, -1]);
          break;
        }
      }
    }
  });
  return out;
}

/** Returns an error string if the world violates any structural guarantee. */
export function validateWorld(w: World): string | null {
  if (w.nodes.length < 10) return 'too few nodes';
  const reach = reachable(w.nodes, w.edges, w.start);
  if (!reach.has(w.home)) return 'home unreachable';
  if (reach.size !== w.nodes.length) return 'disconnected island';
  if (w.stats.loops < 3) return 'not enough loops';
  for (const e of w.edges) {
    if (!(e.length > 1)) return 'degenerate edge';
    if (!w.nodes[e.a].edges.includes(e.id) || !w.nodes[e.b].edges.includes(e.id)) return 'edge index mismatch';
  }
  if (!isFinite(w.distHome[w.start])) return 'no distance to home';
  return null;
}

/** expected shortest-route cost from a node to home */
export function homeCost(w: World, n: number): number {
  return w.distHome[n];
}

export { edgeCost };
