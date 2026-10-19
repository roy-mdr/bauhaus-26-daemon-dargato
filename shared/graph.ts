import type { GraphEdge, GraphNode, Vec2, World } from './types';

export const TAU = Math.PI * 2;

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function otherNode(e: GraphEdge, n: number): number {
  return e.a === n ? e.b : e.a;
}

export function edgeCost(e: GraphEdge): number {
  return e.length * e.traversability;
}

export function computeCum(points: Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  return cum;
}

/**
 * Point and tangent heading at distance s along an edge, measured from node `from`.
 * Heading convention: angle = atan2(dx, dz) (0 = +z, PI/2 = +x).
 */
export function sampleEdge(e: GraphEdge, from: number, s: number): { x: number; z: number; heading: number } {
  const L = e.length;
  const sc = Math.max(0, Math.min(L, s));
  const forward = e.a === from;
  const d = forward ? sc : L - sc;
  const pts = e.points;
  const cum = e.cum;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const p0 = pts[i - 1];
  const p1 = pts[i];
  const segLen = cum[i] - cum[i - 1] || 1e-6;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / segLen));
  const x = p0.x + (p1.x - p0.x) * t;
  const z = p0.z + (p1.z - p0.z) * t;
  let dx = p1.x - p0.x;
  let dz = p1.z - p0.z;
  if (!forward) {
    dx = -dx;
    dz = -dz;
  }
  return { x, z, heading: Math.atan2(dx, dz) };
}

/** heading of an edge when leaving node n (looking a few units into the edge) */
export function leaveHeading(e: GraphEdge, n: number, look = 4): number {
  const p0 = sampleEdge(e, n, 0);
  const p1 = sampleEdge(e, n, Math.min(look, e.length));
  return Math.atan2(p1.x - p0.x, p1.z - p0.z);
}

/** heading when arriving into node n along edge e */
export function arriveHeading(e: GraphEdge, n: number, look = 4): number {
  const from = otherNode(e, n);
  const p0 = sampleEdge(e, from, Math.max(0, e.length - look));
  const p1 = sampleEdge(e, from, e.length);
  return Math.atan2(p1.x - p0.x, p1.z - p0.z);
}

class MinHeap {
  private items: { k: number; v: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(v: number, k: number) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { k: number; v: number } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function dijkstra(
  nodes: GraphNode[],
  edges: GraphEdge[],
  source: number,
  cost: (e: GraphEdge) => number = edgeCost,
): number[] {
  const dist = new Array(nodes.length).fill(Infinity);
  dist[source] = 0;
  const heap = new MinHeap();
  heap.push(source, 0);
  while (heap.size) {
    const { v, k } = heap.pop()!;
    if (k > dist[v]) continue;
    for (const eid of nodes[v].edges) {
      const e = edges[eid];
      const w = otherNode(e, v);
      const nd = k + cost(e);
      if (nd < dist[w]) {
        dist[w] = nd;
        heap.push(w, nd);
      }
    }
  }
  return dist;
}

/** A* path search; returns node ids and edge ids (empty if unreachable) */
export function astar(
  nodes: GraphNode[],
  edges: GraphEdge[],
  from: number,
  to: number,
  cost: (e: GraphEdge) => number = edgeCost,
): { nodes: number[]; edges: number[]; cost: number } {
  const g = new Map<number, number>();
  const came = new Map<number, { n: number; e: number }>();
  const h = (n: number) => Math.hypot(nodes[n].x - nodes[to].x, nodes[n].z - nodes[to].z);
  const heap = new MinHeap();
  g.set(from, 0);
  heap.push(from, h(from));
  const closed = new Set<number>();
  while (heap.size) {
    const { v } = heap.pop()!;
    if (v === to) break;
    if (closed.has(v)) continue;
    closed.add(v);
    for (const eid of nodes[v].edges) {
      const e = edges[eid];
      const w = otherNode(e, v);
      const ng = g.get(v)! + cost(e);
      if (ng < (g.get(w) ?? Infinity)) {
        g.set(w, ng);
        came.set(w, { n: v, e: eid });
        heap.push(w, ng + h(w));
      }
    }
  }
  if (!g.has(to)) return { nodes: [], edges: [], cost: Infinity };
  const pathNodes = [to];
  const pathEdges: number[] = [];
  let cur = to;
  while (cur !== from) {
    const c = came.get(cur)!;
    pathEdges.push(c.e);
    pathNodes.push(c.n);
    cur = c.n;
  }
  pathNodes.reverse();
  pathEdges.reverse();
  return { nodes: pathNodes, edges: pathEdges, cost: g.get(to)! };
}

export function reachable(nodes: GraphNode[], edges: GraphEdge[], from: number): Set<number> {
  const seen = new Set<number>([from]);
  const stack = [from];
  while (stack.length) {
    const v = stack.pop()!;
    for (const eid of nodes[v].edges) {
      const w = otherNode(edges[eid], v);
      if (!seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
    }
  }
  return seen;
}

/** Stable fingerprint of the navigation graph (used to verify seed determinism). */
export function graphFingerprint(w: World): string {
  const parts: string[] = [];
  for (const n of w.nodes) parts.push(`n${n.id}:${n.x.toFixed(3)},${n.z.toFixed(3)},${n.kind},${n.edges.join('.')}`);
  for (const e of w.edges) parts.push(`e${e.id}:${e.a}-${e.b},${e.kind},${e.width},${e.length.toFixed(3)}`);
  parts.push(`s${w.start}h${w.home}`);
  let h = 0x811c9dc5;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
