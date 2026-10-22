// Builds the visible town around the navigation graph: not pavement and facades,
// but floating solids where the buildings would be, and particle paths for streets.
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { sampleEdge } from '../../shared/graph';
import { Rng } from '../../shared/rng';
import type { Landmark, World } from '../../shared/types';
import { buildCityLayout, type CityLayout } from './cityLayout';
import { PAL } from './palette';
import { store } from './store';
import { CatFigure, newPose } from './CatFigure';
import { StreetParticles } from './StreetParticles';

type Shape = 'box' | 'cylinder' | 'prism' | 'sphere';
const SHAPES: Shape[] = ['box', 'cylinder', 'prism', 'sphere'];

/** one floating solid; y is the bottom at rest */
interface Piece {
  x: number;
  z: number;
  y: number;
  sx: number;
  sy: number;
  sz: number;
  rot: number;
  color: string;
  phase: number;
  amp: number;
  speed: number;
  sway: number;
}

const unitGeo: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 28),
  prism: new THREE.CylinderGeometry(0.58, 0.58, 1, 3),
  sphere: new THREE.SphereGeometry(0.5, 24, 16),
};

const buildingColor = (shade: number) => PAL.buildings[Math.min(PAL.buildings.length - 1, Math.floor(shade * PAL.buildings.length))];

/**
 * Turns the cosmetic city layout into floating pieces. Footprints only shrink, so
 * nothing ever reaches into a street corridor.
 */
function buildPieces(world: World, layout: CityLayout): Record<Shape, Piece[]> {
  const rng = new Rng('abstract:' + world.seed);
  const out: Record<Shape, Piece[]> = { box: [], cylinder: [], prism: [], sphere: [] };
  const motion = (amp: number) => ({ phase: rng.range(0, Math.PI * 2), amp, speed: rng.range(0.22, 0.55), sway: rng.chance(0.4) ? rng.range(0.01, 0.05) : 0 });

  for (const b of layout.buildings) {
    const r = rng.next();
    const shape: Shape = r < 0.66 ? 'box' : r < 0.8 ? 'cylinder' : r < 0.93 ? 'prism' : 'sphere';
    const shrink = rng.range(0.68, 0.92);
    const lift = rng.range(1.2, 4.2);
    if (shape === 'sphere') {
      const d = Math.min(b.sx, b.sz) * shrink;
      out.sphere.push({ x: b.x, z: b.z, y: lift, sx: d, sy: d, sz: d, rot: b.rot, color: buildingColor(b.shade), ...motion(rng.range(0.15, 0.4)) });
      continue;
    }
    // tall buildings break into a few stacked pieces with air between them
    const total = b.sy * rng.range(0.55, 0.95);
    const parts = total > 11 ? rng.int(1, 3) : total > 5 ? rng.int(1, 2) : 1;
    let y = lift;
    for (let i = 0; i < parts; i++) {
      const h = (total / parts) * rng.range(0.7, 1.15);
      const k = i === 0 ? 1 : rng.range(0.7, 1);
      const s: Shape = i === 0 ? shape : rng.chance(0.8) ? 'box' : shape;
      const round = s !== 'box';
      const d = Math.min(b.sx, b.sz);
      out[s].push({
        x: b.x,
        z: b.z,
        y,
        sx: (round ? d : b.sx) * shrink * k,
        sy: h,
        sz: (round ? d : b.sz) * shrink * k,
        rot: b.rot + rng.range(-0.12, 0.12),
        color: buildingColor(Math.min(0.999, Math.max(0, b.shade + rng.range(-0.15, 0.15)))),
        ...motion(rng.range(0.08, 0.2) * (i + 1)),
      });
      y += h + rng.range(0.9, 2.4);
    }
  }
  // walls along alleys and benches on squares become thin floating plates
  for (const f of layout.fences) {
    out.box.push({ x: f.x, z: f.z, y: rng.range(0.35, 0.8), sx: 0.12, sy: f.sy * 0.8, sz: f.sz * 0.9, rot: f.rot, color: PAL.wall, ...motion(rng.range(0.05, 0.12)) });
  }
  for (const bn of layout.benches) {
    out.box.push({ x: bn.x, z: bn.z, y: rng.range(0.5, 0.9), sx: 1.8, sy: 0.08, sz: 0.45, rot: bn.rot + Math.PI / 2, color: PAL.charcoal, ...motion(0.06) });
  }
  return out;
}

function FloatingSet({ shape, pieces }: { shape: Shape; pieces: Piece[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), s: new THREE.Vector3() }), []);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    pieces.forEach((pc, i) => m.setColorAt(i, c.set(pc.color)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [pieces]);
  // slow, independent bobbing: the town breathes
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    pieces.forEach((pc, i) => {
      const w = t * pc.speed + pc.phase;
      tmp.p.set(pc.x, pc.y + pc.sy / 2 + Math.sin(w) * pc.amp, pc.z);
      tmp.e.set(Math.sin(w * 0.7) * pc.sway, pc.rot + Math.sin(w * 0.5) * pc.sway, Math.cos(w * 0.6) * pc.sway);
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(tmp.p, tmp.q, tmp.s.set(pc.sx, pc.sy, pc.sz));
      m.setMatrixAt(i, tmp.m);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  if (!pieces.length) return null;
  return (
    <instancedMesh ref={ref} args={[unitGeo[shape], undefined, pieces.length]} castShadow receiveShadow frustumCulled={false}>
      <meshStandardMaterial roughness={0.9} flatShading={shape === 'box' || shape === 'prism'} />
    </instancedMesh>
  );
}

export function WorldMesh({ world }: { world: World }) {
  const layout = useMemo(() => buildCityLayout(world), [world]);
  const pieces = useMemo(() => buildPieces(world, layout), [world, layout]);

  const b = world.stats.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 220;

  return (
    <group>
      {/* a pale, almost empty floor that only catches shadows */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color={PAL.ground} roughness={1} />
      </mesh>
      <StreetParticles world={world} />
      {SHAPES.map((s) => (
        <FloatingSet key={s + ':' + world.seed} shape={s} pieces={pieces[s]} />
      ))}
      <Lamps layout={layout} />
      {world.landmarks.map((l) => (
        <LandmarkMesh key={l.id} lm={l} />
      ))}
      <Discoveries world={world} />
    </group>
  );
}

/** street lamps without posts: small hovering lights that answer the HEARTBEAT sense */
function Lamps({ layout }: { layout: CityLayout }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d9d6cf', emissive: '#fff4dc', emissiveIntensity: 0.1 }), []);
  const lamps = useMemo(() => layout.lamps.map((l, i) => ({ ...l, y: 3.4 + ((i * 37) % 10) / 10, phase: i * 1.7 })), [layout]);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(0.22, 0.22, 0.22), up: new THREE.Vector3(0, 1, 0) }), []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const hb = store.latest?.inner.heartbeat ?? 0;
    const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.1)), 8);
    mat.emissiveIntensity = 0.08 + hb * (0.25 + beat * 0.6);
    const m = ref.current;
    if (!m) return;
    lamps.forEach((l, i) => {
      tmp.q.setFromAxisAngle(tmp.up, l.rot + t * 0.2 + l.phase);
      tmp.p.set(l.x, l.y + Math.sin(t * 0.5 + l.phase) * 0.12, l.z);
      m.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s));
    });
    m.instanceMatrix.needsUpdate = true;
  });
  if (!lamps.length) return null;
  return <instancedMesh ref={ref} args={[unitGeo.box, mat, lamps.length]} frustumCulled={false} />;
}

const redMat = new THREE.MeshStandardMaterial({ color: PAL.red, roughness: 0.6 });
const redGlowMat = new THREE.MeshStandardMaterial({ color: PAL.red, emissive: PAL.red, emissiveIntensity: 1.6 });
const darkMat = new THREE.MeshStandardMaterial({ color: PAL.charcoal, roughness: 0.9 });
const blackMat = new THREE.MeshStandardMaterial({ color: PAL.black, roughness: 0.9 });
const wallMat = new THREE.MeshStandardMaterial({ color: PAL.wall, roughness: 1 });

export function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export const glowTexture = typeof document !== 'undefined' ? makeGlowTexture() : (null as unknown as THREE.Texture);

function Glow({ color = PAL.red, size = 2, opacity = 0.6, position }: { color?: string; size?: number; opacity?: number; position: [number, number, number] }) {
  return (
    <sprite position={position} scale={[size, size, size]}>
      <spriteMaterial map={glowTexture} color={color} transparent opacity={opacity} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  );
}

function LandmarkMesh({ lm }: { lm: Landmark }) {
  const sittingPose = useMemo(() => {
    const p = newPose();
    p.state = 'home';
    return p;
  }, []);
  const inner = (() => {
    switch (lm.kind) {
      case 'red-door':
        return (
          <group>
            <mesh material={wallMat} position={[0, 1.7, -0.2]} castShadow receiveShadow>
              <boxGeometry args={[3.2, 3.4, 0.4]} />
            </mesh>
            <mesh material={redMat} position={[0, 1.15, 0.02]}>
              <boxGeometry args={[1.1, 2.3, 0.08]} />
            </mesh>
          </group>
        );
      case 'red-window':
        return (
          <group>
            <mesh material={wallMat} position={[0, 2.5, -0.2]} castShadow receiveShadow>
              <boxGeometry args={[3.4, 5, 0.4]} />
            </mesh>
            <mesh material={redGlowMat} position={[0, 3.2, 0.02]}>
              <boxGeometry args={[0.9, 1.3, 0.06]} />
            </mesh>
            <Glow position={[0, 3.2, 0.3]} size={3} opacity={0.35} />
          </group>
        );
      case 'red-lamp':
        return (
          <group>
            <mesh material={darkMat} position={[0, 2, 0]} castShadow>
              <cylinderGeometry args={[0.06, 0.08, 4, 6]} />
            </mesh>
            <mesh material={redGlowMat} position={[0, 4.1, 0]}>
              <sphereGeometry args={[0.22, 10, 8]} />
            </mesh>
            <Glow position={[0, 4.1, 0]} size={4} opacity={0.55} />
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
              <circleGeometry args={[2.4, 24]} />
              <meshBasicMaterial map={glowTexture} color={PAL.red} transparent opacity={0.25} depthWrite={false} />
            </mesh>
          </group>
        );
      case 'red-chair':
        return (
          <group rotation={[0, 0.6, 0]}>
            <mesh material={redMat} position={[0, 0.45, 0]} castShadow>
              <boxGeometry args={[0.55, 0.06, 0.55]} />
            </mesh>
            <mesh material={redMat} position={[0, 0.8, -0.25]} castShadow>
              <boxGeometry args={[0.55, 0.65, 0.06]} />
            </mesh>
            {[
              [0.24, 0.24],
              [-0.24, 0.24],
              [0.24, -0.24],
              [-0.24, -0.24],
            ].map(([x, z], i) => (
              <mesh key={i} material={redMat} position={[x, 0.22, z]} castShadow>
                <boxGeometry args={[0.05, 0.45, 0.05]} />
              </mesh>
            ))}
          </group>
        );
      case 'red-umbrella':
        return (
          <group rotation={[0.25, 0, 0.15]}>
            <mesh material={darkMat} position={[0, 1, 0]}>
              <cylinderGeometry args={[0.025, 0.025, 2, 4]} />
            </mesh>
            <mesh material={redMat} position={[0, 2, 0]} castShadow>
              <coneGeometry args={[1.1, 0.45, 8, 1, true]} />
            </mesh>
          </group>
        );
      case 'red-bicycle':
        return (
          <group rotation={[0, Math.PI / 2, 0]}>
            {[0.55, -0.55].map((z, i) => (
              <mesh key={i} material={redMat} position={[0, 0.38, z]} rotation={[0, Math.PI / 2, 0]} castShadow>
                <torusGeometry args={[0.36, 0.03, 6, 20]} />
              </mesh>
            ))}
            <mesh material={redMat} position={[0, 0.62, 0]} rotation={[Math.PI / 2 - 0.4, 0, 0]}>
              <cylinderGeometry args={[0.03, 0.03, 1.2, 4]} />
            </mesh>
          </group>
        );
      case 'red-scarf':
        return (
          <group>
            <mesh material={darkMat} position={[0, 0.6, 0]}>
              <boxGeometry args={[2.4, 0.06, 0.06]} />
            </mesh>
            {[-1.1, 1.1].map((x, i) => (
              <mesh key={i} material={darkMat} position={[x, 0.55, 0]}>
                <boxGeometry args={[0.06, 1.1, 0.06]} />
              </mesh>
            ))}
            <ScarfCloth />
          </group>
        );
      case 'silhouette':
        return (
          <group>
            <mesh material={blackMat} position={[0, 1.05, 0]} castShadow>
              <capsuleGeometry args={[0.25, 1.4, 3, 8]} />
            </mesh>
            <mesh material={blackMat} position={[0, 2.15, 0]} castShadow>
              <sphereGeometry args={[0.2, 8, 6]} />
            </mesh>
          </group>
        );
      case 'roof-cat':
        return (
          <group>
            <mesh material={wallMat} position={[0, 2.6, 0]} castShadow receiveShadow>
              <boxGeometry args={[1.2, 5.2, 1.2]} />
            </mesh>
            <group position={[0, 5.2, 0]} scale={0.9}>
              <CatFigure pose={sittingPose} color={PAL.black} />
            </group>
          </group>
        );
    }
  })();
  return (
    <group position={[lm.x, 0, lm.z]} rotation={[0, lm.facing + Math.PI, 0]}>
      {inner}
    </group>
  );
}

function ScarfCloth() {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(() => {
    const t = performance.now() / 1000;
    ref.current.rotation.x = Math.sin(t * 2.1) * 0.25;
    ref.current.rotation.y = Math.sin(t * 1.3) * 0.15;
  });
  return (
    <mesh ref={ref} material={redMat} position={[0.3, 0.35, 0.05]}>
      <boxGeometry args={[0.35, 0.55, 0.02]} />
    </mesh>
  );
}

function Discoveries({ world }: { world: World }) {
  const sleeping = useMemo(() => {
    const p = newPose();
    p.state = 'sleeping';
    return p;
  }, []);
  return (
    <group>
      {world.nodes
        .filter((n) => n.discovery)
        .map((n) => {
          const e = world.edges[n.edges[0]];
          const back = sampleEdge(e, n.id, 0.0);
          // just beyond the end of the street, where he stops to look
          const p: [number, number, number] = [n.x - Math.sin(back.heading) * 0.9, 0, n.z - Math.cos(back.heading) * 0.9];
          switch (n.discovery) {
            case 'fish-bones':
              return (
                <group key={n.id} position={p}>
                  <mesh position={[0, 0.04, 0]} rotation={[0, 0.7, 0]}>
                    <boxGeometry args={[0.7, 0.03, 0.05]} />
                    <meshStandardMaterial color={PAL.offwhite} />
                  </mesh>
                  {[-0.2, 0, 0.2].map((x, i) => (
                    <mesh key={i} position={[x, 0.04, 0]} rotation={[0, 0.7 + Math.PI / 2, 0]}>
                      <boxGeometry args={[0.3, 0.02, 0.03]} />
                      <meshStandardMaterial color={PAL.offwhite} />
                    </mesh>
                  ))}
                </group>
              );
            case 'red-collar':
              return (
                <mesh key={n.id} position={[p[0], 0.04, p[2]]} rotation={[Math.PI / 2, 0, 0]} material={redMat}>
                  <torusGeometry args={[0.18, 0.035, 6, 18]} />
                </mesh>
              );
            case 'sleeping-cat':
              return (
                <group key={n.id} position={p} rotation={[0, 1.2, 0]} scale={0.85}>
                  <CatFigure pose={sleeping} color="#5a5855" />
                </group>
              );
            case 'mirror':
              return (
                <mesh key={n.id} position={[p[0], 1.1, p[2]]} rotation={[0, back.heading, 0]}>
                  <boxGeometry args={[1, 2, 0.05]} />
                  <meshStandardMaterial color="#f4f3ef" metalness={0.9} roughness={0.08} />
                </mesh>
              );
            case 'yarn':
              return (
                <mesh key={n.id} position={[p[0], 0.15, p[2]]} material={redMat}>
                  <icosahedronGeometry args={[0.16, 1]} />
                </mesh>
              );
            case 'empty-bowl':
              return (
                <mesh key={n.id} position={[p[0], 0.06, p[2]]}>
                  <cylinderGeometry args={[0.2, 0.14, 0.12, 12, 1, true]} />
                  <meshStandardMaterial color={PAL.charcoal} side={THREE.DoubleSide} />
                </mesh>
              );
          }
          return null;
        })}
    </group>
  );
}
