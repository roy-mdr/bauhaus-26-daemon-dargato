// Builds the visible town around the navigation graph.
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { sampleEdge } from '../../shared/graph';
import type { EdgeKind, Landmark, World } from '../../shared/types';
import { buildCityLayout, type Box } from './cityLayout';
import { PAL } from './palette';
import { store } from './store';
import { CatFigure, newPose } from './CatFigure';

const KIND_COLOR: Record<EdgeKind, string> = { main: PAL.main, street: PAL.street, alley: PAL.alley, path: PAL.path };
const KIND_Y: Record<EdgeKind, number> = { main: 0.03, street: 0.032, alley: 0.034, path: 0.036 };

class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  private c = new THREE.Color();
  tri(a: number[], b: number[], c: number[], color: string) {
    this.c.set(color);
    // callers give clockwise-from-above order; emit counter-clockwise so faces point up
    this.pos.push(...a, ...c, ...b);
    for (let i = 0; i < 3; i++) this.col.push(this.c.r, this.c.g, this.c.b);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

function ribbon(gb: GeoBuilder, pts: { x: number; z: number }[], width: number, y: number, color: string) {
  const hw = width / 2;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(pts.length - 1, i + 1)];
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L;
    const nz = dx / L;
    left.push([pts[i].x + nx * hw, y, pts[i].z + nz * hw]);
    right.push([pts[i].x - nx * hw, y, pts[i].z - nz * hw]);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    gb.tri(left[i], right[i], left[i + 1], color);
    gb.tri(right[i], right[i + 1], left[i + 1], color);
  }
}

function disc(gb: GeoBuilder, x: number, z: number, r: number, y: number, color: string, seg = 28) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    gb.tri([x, y, z], [x + Math.sin(a1) * r, y, z + Math.cos(a1) * r], [x + Math.sin(a0) * r, y, z + Math.cos(a0) * r], color);
  }
}

function useInstances(ref: React.RefObject<THREE.InstancedMesh | null>, boxes: Box[], colorFn?: (b: Box) => string) {
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    boxes.forEach((b, i) => {
      q.setFromAxisAngle(up, b.rot);
      mat.compose(new THREE.Vector3(b.x, b.y + b.sy / 2, b.z), q, new THREE.Vector3(b.sx, b.sy, b.sz));
      m.setMatrixAt(i, mat);
      if (colorFn) {
        c.set(colorFn(b));
        m.setColorAt(i, c);
      }
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [ref, boxes, colorFn]);
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);

export function WorldMesh({ world }: { world: World }) {
  const layout = useMemo(() => buildCityLayout(world), [world]);
  const streets = useMemo(() => {
    const gb = new GeoBuilder();
    for (const e of world.edges) {
      const pts = e.points.length > 2 ? e.points : [e.points[0], e.points[1]];
      if (e.kind === 'main' || e.kind === 'street') ribbon(gb, pts, e.width + 2.2, 0.018, PAL.sidewalk);
      ribbon(gb, pts, e.width, KIND_Y[e.kind], KIND_COLOR[e.kind]);
    }
    for (const n of world.nodes) {
      if (n.id === world.home) continue;
      const maxW = Math.max(...n.edges.map((eid) => world.edges[eid].width));
      const hasWide = n.edges.some((eid) => ['main', 'street'].includes(world.edges[eid].kind));
      if (hasWide) disc(gb, n.x, n.z, n.r + 1.1, 0.02, PAL.sidewalk);
      disc(gb, n.x, n.z, n.kind === 'plaza' ? n.r : Math.max(n.r, maxW / 2 + 0.3), 0.038, n.kind === 'plaza' ? PAL.plaza : PAL.street);
    }
    return gb.build();
  }, [world]);

  const bRef = useRef<THREE.InstancedMesh>(null);
  const dRef = useRef<THREE.InstancedMesh>(null);
  const fRef = useRef<THREE.InstancedMesh>(null);
  const bColor = useMemo(() => (b: Box) => PAL.buildings[Math.min(PAL.buildings.length - 1, Math.floor(b.shade * PAL.buildings.length))], []);
  useInstances(bRef, layout.buildings, bColor);
  useInstances(dRef, layout.doors);
  useInstances(fRef, layout.fences, () => PAL.wall);

  const b = world.stats.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 220;

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color={PAL.ground} roughness={1} />
      </mesh>
      <mesh geometry={streets} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} />
      </mesh>
      <instancedMesh ref={bRef} args={[unitBox, undefined, layout.buildings.length]} castShadow receiveShadow>
        <meshStandardMaterial roughness={0.95} flatShading />
      </instancedMesh>
      {layout.doors.length > 0 && (
        <instancedMesh ref={dRef} args={[unitBox, undefined, layout.doors.length]}>
          <meshStandardMaterial color={PAL.charcoal} roughness={1} />
        </instancedMesh>
      )}
      {layout.fences.length > 0 && (
        <instancedMesh ref={fRef} args={[unitBox, undefined, layout.fences.length]} castShadow receiveShadow>
          <meshStandardMaterial roughness={1} />
        </instancedMesh>
      )}
      <StreetFurniture layout={layout} />
      {world.landmarks.map((l) => (
        <LandmarkMesh key={l.id} lm={l} />
      ))}
      <Discoveries world={world} />
    </group>
  );
}

function StreetFurniture({ layout }: { layout: ReturnType<typeof buildCityLayout> }) {
  const posts = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const bol = useRef<THREE.InstancedMesh>(null);
  const ben = useRef<THREE.InstancedMesh>(null);
  const headMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d9d6cf', emissive: '#fff4dc', emissiveIntensity: 0.1 }), []);
  const lampBoxes = useMemo<Box[]>(() => layout.lamps.map((l) => ({ x: l.x, z: l.z, y: 0, sx: 0.12, sy: 4.4, sz: 0.12, rot: l.rot, shade: 0 })), [layout]);
  const headBoxes = useMemo<Box[]>(() => layout.lamps.map((l) => ({ x: l.x, z: l.z, y: 4.3, sx: 0.5, sy: 0.18, sz: 0.3, rot: l.rot, shade: 0 })), [layout]);
  const bolBoxes = useMemo<Box[]>(() => layout.bollards.map((l) => ({ x: l.x, z: l.z, y: 0, sx: 0.22, sy: 0.85, sz: 0.22, rot: 0, shade: 0 })), [layout]);
  const benBoxes = useMemo<Box[]>(() => layout.benches.map((l) => ({ x: l.x, z: l.z, y: 0.35, sx: 1.8, sy: 0.12, sz: 0.5, rot: l.rot + Math.PI / 2, shade: 0 })), [layout]);
  useInstances(posts, lampBoxes);
  useInstances(heads, headBoxes);
  useInstances(bol, bolBoxes);
  useInstances(ben, benBoxes);
  // street lamps answer the HEARTBEAT sense with a faint pulse
  useFrame(() => {
    const hb = store.latest?.inner.heartbeat ?? 0;
    const t = performance.now() / 1000;
    const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.1)), 8);
    headMat.emissiveIntensity = 0.08 + hb * (0.25 + beat * 0.6);
  });
  return (
    <group>
      {lampBoxes.length > 0 && (
        <>
          <instancedMesh ref={posts} args={[unitBox, undefined, lampBoxes.length]} castShadow>
            <meshStandardMaterial color={PAL.charcoal} roughness={0.8} />
          </instancedMesh>
          <instancedMesh ref={heads} args={[unitBox, headMat, headBoxes.length]} castShadow />
        </>
      )}
      {bolBoxes.length > 0 && (
        <instancedMesh ref={bol} args={[unitBox, undefined, bolBoxes.length]} castShadow>
          <meshStandardMaterial color={PAL.charcoal} roughness={0.8} />
        </instancedMesh>
      )}
      {benBoxes.length > 0 && (
        <instancedMesh ref={ben} args={[unitBox, undefined, benBoxes.length]} castShadow>
          <meshStandardMaterial color={PAL.charcoal} roughness={0.9} />
        </instancedMesh>
      )}
    </group>
  );
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
