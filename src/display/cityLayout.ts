// Visual layer generation around the (server-provided) navigation graph:
// facades lining the streets, back buildings filling the blocks, sparse street
// furniture. Seeded so a seed looks the same each time, but purely cosmetic:
// nothing here can block or alter the navigation graph.
import { Rng } from '../../shared/rng';
import { leaveHeading, sampleEdge } from '../../shared/graph';
import type { World } from '../../shared/types';

export interface Box {
  x: number;
  z: number;
  y: number;
  sx: number;
  sy: number;
  sz: number;
  rot: number;
  shade: number; // 0..1 gray value index
}

export interface CityLayout {
  buildings: Box[];
  doors: Box[];
  lamps: { x: number; z: number; rot: number }[];
  bollards: { x: number; z: number }[];
  benches: { x: number; z: number; rot: number }[];
  fences: Box[];
}

interface Obstacle {
  x: number;
  z: number;
  r: number;
}

class Corridors {
  private cell = 6;
  private grid = new Map<string, Obstacle[]>();
  add(o: Obstacle) {
    const k = `${Math.floor(o.x / this.cell)},${Math.floor(o.z / this.cell)}`;
    let a = this.grid.get(k);
    if (!a) this.grid.set(k, (a = []));
    a.push(o);
  }
  /** true if the oriented box (with margin) touches any corridor sample */
  hits(b: { x: number; z: number; hx: number; hz: number; rot: number }, margin: number): boolean {
    const reach = Math.hypot(b.hx, b.hz) + 12;
    const c = Math.cos(-b.rot);
    const s = Math.sin(-b.rot);
    const gx0 = Math.floor((b.x - reach) / this.cell);
    const gx1 = Math.floor((b.x + reach) / this.cell);
    const gz0 = Math.floor((b.z - reach) / this.cell);
    const gz1 = Math.floor((b.z + reach) / this.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const arr = this.grid.get(`${gx},${gz}`);
        if (!arr) continue;
        for (const o of arr) {
          const dx = o.x - b.x;
          const dz = o.z - b.z;
          // into box-local space (box rotated by rot around y; local x = across, z = along)
          const lx = dx * c + dz * s;
          const lz = -dx * s + dz * c;
          const ex = Math.max(Math.abs(lx) - b.hx, 0);
          const ez = Math.max(Math.abs(lz) - b.hz, 0);
          if (Math.hypot(ex, ez) < o.r + margin) return true;
        }
      }
    }
    return false;
  }
}

export function buildCityLayout(world: World): CityLayout {
  const rng = new Rng('visual:' + world.seed);
  const cor = new Corridors();
  for (const e of world.edges) {
    const n = Math.ceil(e.length / 1);
    for (let k = 0; k <= n; k++) {
      const p = sampleEdge(e, e.a, (k / n) * e.length);
      cor.add({ x: p.x, z: p.z, r: e.width / 2 + 0.7 });
    }
  }
  for (const nd of world.nodes) cor.add({ x: nd.x, z: nd.z, r: nd.r + 0.8 });
  for (const l of world.landmarks) cor.add({ x: l.x, z: l.z, r: 1.6 });
  const home = world.nodes[world.home];
  cor.add({ x: home.x, z: home.z, r: home.r + 3 });

  const buildings: Box[] = [];
  const doors: Box[] = [];
  const lamps: CityLayout['lamps'] = [];
  const bollards: CityLayout['bollards'] = [];
  const benches: CityLayout['benches'] = [];
  const fences: Box[] = [];
  const placed = new Corridors();

  const tryPlace = (b: Box, margin = 0.15): boolean => {
    const hb = { x: b.x, z: b.z, hx: b.sx / 2, hz: b.sz / 2, rot: b.rot };
    if (cor.hits(hb, margin)) return false;
    buildings.push(b);
    placed.add({ x: b.x, z: b.z, r: Math.min(b.sx, b.sz) / 2 });
    return true;
  };

  // ---- facades lining every street ----
  for (const e of world.edges) {
    const narrow = e.kind === 'alley' || e.kind === 'path';
    for (const side of [1, -1]) {
      let s = rng.range(0, 3);
      while (s < e.length) {
        const frontage = e.curved ? rng.range(3.5, 6) : narrow ? rng.range(4, 9) : rng.range(6, 13);
        const mid = Math.min(e.length, s + frontage / 2);
        const p = sampleEdge(e, e.a, mid);
        const h = p.heading;
        const depth = rng.range(6, 12);
        const setback = e.width / 2 + (narrow ? 0.35 : 1.1);
        const off = setback + depth / 2;
        // perpendicular (right of travel direction): (cos h, -sin h)
        const x = p.x + Math.cos(h) * off * side;
        const z = p.z - Math.sin(h) * off * side;
        const tall = e.kind === 'main' ? rng.range(9, 20) : narrow ? rng.range(5, 12) : rng.range(6, 15);
        const b: Box = { x, z, y: 0, sx: depth, sy: tall, sz: frontage, rot: h, shade: rng.next() };
        if (tryPlace(b)) {
          if (!narrow && rng.chance(0.12)) {
            // a dark doorway on the street facade
            const fx = p.x + Math.cos(h) * (setback + 0.03) * side;
            const fz = p.z - Math.sin(h) * (setback + 0.03) * side;
            doors.push({ x: fx, z: fz, y: 0, sx: 0.12, sy: 2.3, sz: 1.2, rot: h, shade: 0 });
          }
        } else if (narrow && rng.chance(0.35)) {
          // where no building fits along an alley, a low wall
          const wx = p.x + Math.cos(h) * (e.width / 2 + 0.5) * side;
          const wz = p.z - Math.sin(h) * (e.width / 2 + 0.5) * side;
          const w: Box = { x: wx, z: wz, y: 0, sx: 0.35, sy: rng.range(1.6, 2.6), sz: Math.min(frontage, 4), rot: h, shade: 0.3 };
          if (!cor.hits({ x: w.x, z: w.z, hx: 0.18, hz: w.sz / 2, rot: h }, -0.2)) fences.push(w);
        }
        s += frontage + (rng.chance(0.15) ? rng.range(2.5, 5) : rng.range(0, 0.8));
      }
    }
    // lamp posts on wider streets
    if (e.kind === 'main' || e.kind === 'street') {
      const every = e.kind === 'main' ? 15 : 22;
      for (let s = rng.range(4, 9); s < e.length - 3; s += every) {
        const p = sampleEdge(e, e.a, s);
        const side = rng.chance(0.5) ? 1 : -1;
        const off = e.width / 2 - 0.25;
        lamps.push({ x: p.x + Math.cos(p.heading) * off * side, z: p.z - Math.sin(p.heading) * off * side, rot: p.heading + (side > 0 ? 0 : Math.PI) });
      }
    }
  }

  // ---- bollards at alley mouths, benches on plazas ----
  for (const nd of world.nodes) {
    for (const eid of nd.edges) {
      const e = world.edges[eid];
      if (e.kind !== 'alley' && e.kind !== 'path') continue;
      if (!rng.chance(0.35)) continue;
      const h = leaveHeading(e, nd.id);
      const fwd = nd.r + 0.8;
      for (const side of [1, -1]) {
        bollards.push({ x: nd.x + Math.sin(h) * fwd + Math.cos(h) * (e.width / 2 - 0.2) * side, z: nd.z + Math.cos(h) * fwd - Math.sin(h) * (e.width / 2 - 0.2) * side });
      }
    }
    if (nd.kind === 'plaza') {
      const k = rng.int(1, 3);
      for (let i = 0; i < k; i++) {
        const a = rng.range(0, Math.PI * 2);
        // keep benches out of the street directions
        const blocked = nd.edges.some((eid) => Math.abs(Math.atan2(Math.sin(a - leaveHeading(world.edges[eid], nd.id)), Math.cos(a - leaveHeading(world.edges[eid], nd.id)))) < 0.6);
        if (blocked) continue;
        benches.push({ x: nd.x + Math.sin(a) * (nd.r - 1.2), z: nd.z + Math.cos(a) * (nd.r - 1.2), rot: a });
      }
    }
  }

  // ---- back buildings filling blocks and the district edge ----
  const bd = world.stats.bounds;
  const pad = 34;
  for (let x = bd.minX - pad; x < bd.maxX + pad; x += 7.5) {
    for (let z = bd.minZ - pad; z < bd.maxZ + pad; z += 7.5) {
      const bx = x + rng.range(-2, 2);
      const bz = z + rng.range(-2, 2);
      const outside = bx < bd.minX - 8 || bx > bd.maxX + 8 || bz < bd.minZ - 8 || bz > bd.maxZ + 8;
      const b: Box = {
        x: bx,
        z: bz,
        y: 0,
        sx: rng.range(6, 10),
        sy: outside ? rng.range(10, 26) : rng.range(4, 16),
        sz: rng.range(6, 10),
        rot: rng.range(-0.2, 0.2),
        shade: rng.next(),
      };
      tryPlace(b, 0.3);
    }
  }
  return { buildings, doors, lamps, bollards, benches, fences };
}
