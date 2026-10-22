// Dargato as a loose constellation of triangles. An invisible skeleton is animated
// procedurally from a pose object; each triangle follows its bone with its own lag and
// drift, so the shards never touch but always move together. Slow, he walks with a
// diagonal gait; fast, he gallops: legs in pairs, the spine stretching and gathering.
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactElement } from 'react';
import * as THREE from 'three';
import { wrapAngle } from '../../shared/graph';
import type { CatState } from '../../shared/types';

export interface CatPose {
  state: CatState;
  speed: number;
  /** look direction relative to body, radians (+ = left) */
  lookYaw: number;
  lookPitch: number;
  curiosity: number;
  caution: number;
  calm: number;
  fatigue: number;
  /** seconds in current state */
  stateTime: number;
}

export function newPose(): CatPose {
  return { state: 'idle', speed: 0, lookYaw: 0, lookPitch: 0, curiosity: 0.3, caution: 0.2, calm: 0.3, fatigue: 0, stateTime: 0 };
}

const TAIL_SEGS = 7;

type V3 = [number, number, number];
type AnchorId = 'body' | 'chest' | 'haunch' | 'head' | 'earL' | 'earR' | 'leg0' | 'leg1' | 'leg2' | 'leg3' | 'tail0' | 'tail2' | 'tail4';

interface ShardDef {
  anchor: AnchorId;
  /** triangle corners in the anchor's local space */
  pts: [V3, V3, V3];
  /** how quickly the shard catches up with its bone */
  lambda: number;
  eye?: boolean;
}

const leg = (i: number): ShardDef => ({ anchor: `leg${i}` as AnchorId, pts: [[0.045, 0.02, 0], [-0.045, 0.02, 0], [0, -0.4, i < 2 ? 0.03 : -0.03]], lambda: 26 });
const tailShard = (i: 0 | 2 | 4, w: number): ShardDef => ({ anchor: `tail${i}`, pts: [[w, w, 0], [-w, -w, 0], [0, 0, -0.26]], lambda: 9 - i });

const SHARDS: ShardDef[] = [
  // body: chest, spine, belly, haunch
  { anchor: 'chest', pts: [[0, 0.27, 0.4], [0.21, -0.1, 0.24], [-0.21, -0.1, 0.24]], lambda: 16 },
  { anchor: 'body', pts: [[0, 0.21, 0.2], [0.17, 0.13, -0.32], [-0.17, 0.13, -0.32]], lambda: 13 },
  { anchor: 'body', pts: [[0.13, -0.08, 0.12], [-0.13, -0.08, 0.12], [0, -0.17, -0.28]], lambda: 11 },
  { anchor: 'haunch', pts: [[0, 0.2, -0.24], [0.23, -0.16, -0.42], [-0.23, -0.16, -0.42]], lambda: 14 },
  // head: face, two eye slivers, two ears
  { anchor: 'head', pts: [[0.19, 0.1, 0.02], [-0.19, 0.1, 0.02], [0, -0.17, 0.2]], lambda: 12 },
  { anchor: 'head', pts: [[0.11, 0.06, 0.14], [0.05, 0.05, 0.15], [0.075, 0.015, 0.155]], lambda: 12, eye: true },
  { anchor: 'head', pts: [[-0.11, 0.06, 0.14], [-0.05, 0.05, 0.15], [-0.075, 0.015, 0.155]], lambda: 12, eye: true },
  { anchor: 'earL', pts: [[0.07, 0, 0], [-0.06, 0, 0.01], [0.01, 0.22, -0.03]], lambda: 18 },
  { anchor: 'earR', pts: [[-0.07, 0, 0], [0.06, 0, 0.01], [-0.01, 0.22, -0.03]], lambda: 18 },
  leg(0),
  leg(1),
  leg(2),
  leg(3),
  tailShard(0, 0.045),
  tailShard(2, 0.035),
  tailShard(4, 0.026),
];

/** a thin triangular plate (centred on its centroid), so it catches light and casts a shadow */
function plateGeometry(pts: [V3, V3, V3]): { geo: THREE.BufferGeometry; centroid: THREE.Vector3 } {
  const [a, b, c] = pts.map((p) => new THREE.Vector3(...p));
  const centroid = a.clone().add(b).add(c).divideScalar(3);
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize().multiplyScalar(0.009);
  const v = [a, b, c].map((p) => p.clone().sub(centroid));
  const f = v.map((p) => p.clone().add(n));
  const k = v.map((p) => p.clone().sub(n));
  const tris: THREE.Vector3[][] = [
    [f[0], f[1], f[2]],
    [k[0], k[2], k[1]],
  ];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    tris.push([f[i], k[i], k[j]], [f[i], k[j], f[j]]);
  }
  const pos: number[] = [];
  for (const t of tris) for (const p of t) pos.push(p.x, p.y, p.z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return { geo, centroid };
}

interface Props {
  pose: CatPose;
  color?: string;
  eyeColor?: string;
  scale?: number;
  castShadow?: boolean;
}

const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** leg phase offsets: walking in diagonal pairs, galloping front pair against hind pair (slightly staggered) */
const WALK_OFFS = [0, Math.PI, Math.PI, 0];
const RUN_OFFS = [Math.PI * 0.95, Math.PI * 0.95 + 0.4, 0, 0.4];

export function CatFigure({ pose, color = '#121212', eyeColor = '#e9e6dc', scale = 1, castShadow = true }: Props) {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, flatShading: true, side: THREE.DoubleSide }), [color]);
  const eyeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: eyeColor, side: THREE.DoubleSide }), [eyeColor]);
  const plates = useMemo(() => SHARDS.map((d) => plateGeometry(d.pts)), []);
  const root = useRef<THREE.Group>(null!);
  const bodyG = useRef<THREE.Group>(null!);
  const chestG = useRef<THREE.Group>(null!);
  const haunchG = useRef<THREE.Group>(null!);
  const headG = useRef<THREE.Group>(null!);
  const earL = useRef<THREE.Group>(null!);
  const earR = useRef<THREE.Group>(null!);
  const legs = useRef<THREE.Group[]>([]);
  const tail = useRef<THREE.Group[]>([]);
  const shardMeshes = useRef<THREE.Mesh[]>([]);
  const st = useRef({ phase: 0, bodyY: 0.52, pitch: 0, roll: 0, headYaw: 0, headPitch: 0, earUp: 1, tailUp: 0.4, tailPuff: 1, legFold: 0, sit: 0, curl: 0, stretch: 0, t: 0, spread: 0.18, run: 0, yaw: 0, lean: 0, init: false });
  const tmp = useMemo(
    () => ({
      inv: new THREE.Matrix4(),
      rel: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scl: new THREE.Vector3(),
      c: new THREE.Vector3(),
      center: new THREE.Vector3(),
      seeds: SHARDS.map((_, i) => ((i * 7919) % 101) / 101),
    }),
    [],
  );

  useFrame((_, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    const s = st.current;
    const p = pose;
    s.t += dt;
    const sp = p.speed;
    const moving = sp > 0.15;
    // gait: 0 walking .. 1 galloping
    s.run = damp(s.run, moving ? ss(2.0, 3.4, sp) : 0, 4, dt);
    const R = s.run;
    // strides per second: the walk quickens with speed, the gallop keeps a steadier beat with longer strides
    if (moving) s.phase += dt * Math.PI * 2 * lerp(0.35 + sp * 0.55, 2.3 + sp * 0.12, R);
    const ph = s.phase;

    // targets per state
    let bodyY = 0.52;
    let pitch = 0;
    let headPitch = p.lookPitch;
    let headYaw = p.lookYaw;
    let earUp = 1 - p.caution * 0.4;
    let tailUp = 0.25 + p.curiosity * 0.9 - p.caution * 0.6;
    let tailPuff = 1;
    let legFold = 0;
    let sit = 0;
    let curl = 0;
    let stretch = 0;
    let roll = 0;
    switch (p.state) {
      case 'sniffing':
      case 'investigating':
        headPitch = 0.65 + Math.sin(s.t * 9) * 0.06;
        pitch = 0.12;
        tailUp = 0.5;
        break;
      case 'alert':
        earUp = 1.35;
        bodyY = 0.58;
        headPitch = -0.2;
        tailUp = 1.1;
        break;
      case 'frightened':
        bodyY = 0.4;
        pitch = -0.08;
        earUp = 0.5;
        tailUp = -0.3;
        tailPuff = 2.1;
        legFold = 0.35;
        break;
      case 'recovering':
        stretch = p.stateTime < 0.8 ? 1 : 0;
        roll = p.stateTime >= 0.8 ? Math.sin(s.t * 38) * 0.18 * Math.max(0, 1.5 - p.stateTime) : 0;
        break;
      case 'resting':
        bodyY = 0.2;
        legFold = 1;
        tailUp = -0.4;
        headPitch = 0.15;
        break;
      case 'sleeping':
        bodyY = 0.16;
        legFold = 1;
        curl = 1;
        headPitch = 0.4;
        earUp = 0.6;
        break;
      case 'home':
      case 'arriving':
      case 'idle':
        sit = 1;
        tailUp = -0.2;
        break;
      case 'hesitating':
        tailUp += Math.sin(s.t * 3) * 0.15;
        break;
    }
    if (p.fatigue > 0.6 && moving) {
      headPitch += 0.2;
      tailUp -= 0.3;
    }
    // galloping: low and long, ears back, the tail streaming behind
    bodyY -= 0.05 * R;
    earUp *= 1 - 0.3 * R;
    tailUp = lerp(tailUp, 0.05, R * 0.8);

    const L = 7;
    s.bodyY = damp(s.bodyY, bodyY, L, dt);
    s.pitch = damp(s.pitch, pitch, L, dt);
    s.headYaw = damp(s.headYaw, Math.max(-1.3, Math.min(1.3, headYaw)), 5, dt);
    s.headPitch = damp(s.headPitch, headPitch, 6, dt);
    s.earUp = damp(s.earUp, earUp, 10, dt);
    s.tailUp = damp(s.tailUp, tailUp, 4, dt);
    s.tailPuff = damp(s.tailPuff, tailPuff, 8, dt);
    s.legFold = damp(s.legFold, legFold, 5, dt);
    s.sit = damp(s.sit, sit, 4, dt);
    s.curl = damp(s.curl, curl, 2, dt);
    s.stretch = damp(s.stretch, stretch, 6, dt);
    s.roll = damp(s.roll, roll, 20, dt);

    // leaning into turns: how fast his heading changes (turning right = heading decreasing)
    const r = root.current;
    const yaw = Math.atan2(r.matrixWorld.elements[8], r.matrixWorld.elements[10]);
    const yawRate = s.init ? wrapAngle(yaw - s.yaw) / Math.max(dt, 1e-3) : 0;
    s.yaw = yaw;
    s.lean = damp(s.lean, Math.max(-0.3, Math.min(0.3, -yawRate * 0.09 * ss(0.5, 3, sp))), 6, dt);

    // body: walking sways a little; galloping bounds, rocks nose-up / nose-down and
    // stretches (legs reaching apart) and gathers (legs under him) with every stride
    const walkK = moving ? 1 - R : 0;
    const ext = Math.sin(ph) * R;
    const bob = moving ? lerp(Math.abs(Math.sin(ph)) * (0.025 + 0.012 * sp), (0.5 - 0.5 * Math.cos(ph)) * 0.15, R) : Math.sin(s.t * 2) * 0.008;
    const rock = Math.cos(ph) * 0.11 * R + Math.sin(ph * 2) * 0.015 * walkK;
    const b = bodyG.current;
    b.position.y = s.bodyY + bob - s.sit * 0.08;
    b.rotation.x = s.pitch - s.sit * 0.55 + s.stretch * 0.25 + rock;
    b.rotation.z = s.roll + s.lean + Math.sin(ph) * 0.04 * walkK;
    b.rotation.y = s.curl * 0.9 + Math.sin(ph) * 0.05 * walkK;
    b.scale.set(1, 1, 1 + s.stretch * 0.12);
    // the spine arches when gathered (both ends dip) and flattens out when stretched
    chestG.current.position.z = ext * 0.09;
    chestG.current.rotation.x = -ext * 0.2;
    haunchG.current.position.z = -ext * 0.09;
    haunchG.current.rotation.x = ext * 0.2;

    // the head stays steady while the body rocks under it, reaching forward at a run
    const h = headG.current;
    h.position.z = 0.55 + 0.06 * R;
    h.rotation.set(s.headPitch + s.sit * 0.5 - s.stretch * 0.3 - rock * 0.8, s.headYaw, 0, 'YXZ');
    earL.current.scale.y = s.earUp;
    earR.current.scale.y = s.earUp;
    earL.current.rotation.x = earR.current.rotation.x = -0.5 * R;

    // legs: diagonal walk blending into a gallop; each leg folds up as it swings forward
    const ampW = moving ? 0.32 + 0.08 * sp : 0;
    const ampR = moving ? 0.95 : 0;
    legs.current.forEach((g, i) => {
      if (!g) return;
      const front = i < 2;
      const swing = lerp(Math.sin(ph + WALK_OFFS[i]) * ampW, Math.sin(ph + RUN_OFFS[i]) * ampR, R);
      const lift = moving ? lerp(Math.max(0, -Math.cos(ph + WALK_OFFS[i])) * 0.18, Math.max(0, -Math.cos(ph + RUN_OFFS[i])) * 0.45, R) : 0;
      g.rotation.x = swing * (1 - s.legFold) + (front ? -1.4 : 1.4) * s.legFold * 0.9 + (front ? s.sit * 0.5 : -s.sit * 1.2);
      g.position.y = -0.08 - s.legFold * 0.05;
      g.scale.y = 1 - lift * (1 - s.legFold);
    });

    // tail: a chain bending upward, with a curious hook at the tip; at a run it ripples with the stride
    tail.current.forEach((g, i) => {
      if (!g) return;
      const k = i / (TAIL_SEGS - 1);
      const sway = Math.sin(s.t * (moving ? 3 : 1.4) + i * 0.6) * (0.12 + 0.1 * k) * (1 - 0.6 * R);
      g.rotation.x = s.tailUp * 0.42 + (i === TAIL_SEGS - 1 ? p.curiosity * 0.6 : 0) - s.curl * 0.2 + Math.sin(ph - i * 0.8) * 0.1 * R;
      g.rotation.z = sway + s.curl * 0.45;
      g.scale.set(s.tailPuff, 1, s.tailPuff);
    });

    root.current.scale.setScalar(scale);

    // shards: follow the skeleton, loosely.
    // fear pulls the pieces together, calm and curiosity let them drift apart
    let spread = 0.18 + p.curiosity * 0.12 + p.calm * 0.05 - p.caution * 0.08;
    if (p.state === 'frightened') spread = 0.03;
    if (p.state === 'sleeping' || p.state === 'resting') spread = 0.08;
    if (p.state === 'alert') spread *= 0.5;
    s.spread = damp(s.spread, Math.max(0.01, spread), 3, dt);
    const drift = 0.012 + s.spread * 0.12;
    r.updateMatrixWorld(true);
    tmp.inv.copy(r.matrixWorld).invert();
    tmp.center.set(0, s.bodyY, 0);
    SHARDS.forEach((d, i) => {
      const m = shardMeshes.current[i];
      const a = anchorOf(d.anchor);
      if (!m || !a) return;
      tmp.rel.multiplyMatrices(tmp.inv, a.matrixWorld);
      tmp.rel.decompose(tmp.pos, tmp.quat, tmp.scl);
      // push each shard outward from the body's centre, plus its own slow drift
      tmp.c.copy(plates[i].centroid).applyMatrix4(tmp.rel);
      tmp.c.add(tmp.pos.copy(tmp.c).sub(tmp.center).multiplyScalar(s.spread));
      const u = tmp.seeds[i] * 40;
      tmp.c.x += Math.sin(s.t * 1.1 + u) * drift;
      tmp.c.y += Math.sin(s.t * 1.7 + u * 1.3) * drift;
      tmp.c.z += Math.sin(s.t * 0.9 + u * 0.7) * drift;
      if (!s.init) {
        m.position.copy(tmp.c);
        m.quaternion.copy(tmp.quat);
        m.scale.copy(tmp.scl);
        return;
      }
      // at a run the shards keep up with the faster stride
      const k = 1 - Math.exp(-d.lambda * (1 + 1.5 * R) * dt);
      m.position.lerp(tmp.c, k);
      m.quaternion.slerp(tmp.quat, k);
      m.scale.lerp(tmp.scl, k);
    });
    s.init = true;
  });

  const anchorOf = (id: AnchorId): THREE.Object3D | undefined => {
    if (id === 'body') return bodyG.current;
    if (id === 'chest') return chestG.current;
    if (id === 'haunch') return haunchG.current;
    if (id === 'head') return headG.current;
    if (id === 'earL') return earL.current;
    if (id === 'earR') return earR.current;
    if (id.startsWith('leg')) return legs.current[+id.slice(3)];
    return tail.current[+id.slice(4)];
  };

  const tailChain = useMemo(() => {
    // nested bones, each segment offset along its parent
    const build = (i: number): ReactElement | null => {
      if (i >= TAIL_SEGS) return null;
      return (
        <group key={i} position={[0, 0, i === 0 ? 0 : -0.15]} ref={(g) => { if (g) tail.current[i] = g; }}>
          {build(i + 1)}
        </group>
      );
    };
    return build(0);
  }, []);

  const legPos: V3[] = [
    [0.13, 0, 0.34],
    [-0.13, 0, 0.34],
    [0.13, 0, -0.34],
    [-0.13, 0, -0.34],
  ];

  return (
    <group ref={root}>
      {/* invisible skeleton */}
      <group ref={bodyG} position={[0, 0.52, 0]}>
        {/* front half: head and forelegs; back half: hind legs and tail */}
        <group ref={chestG}>
          {legPos.slice(0, 2).map((lp, i) => (
            <group key={i} position={lp} ref={(g) => { if (g) legs.current[i] = g; }} />
          ))}
          <group ref={headG} position={[0, 0.2, 0.55]}>
            <group ref={earL} position={[0.12, 0.11, -0.02]} rotation={[0, 0, -0.3]} />
            <group ref={earR} position={[-0.12, 0.11, -0.02]} rotation={[0, 0, 0.3]} />
          </group>
        </group>
        <group ref={haunchG}>
          {legPos.slice(2).map((lp, i) => (
            <group key={i} position={lp} ref={(g) => { if (g) legs.current[i + 2] = g; }} />
          ))}
          <group position={[0, 0.1, -0.58]}>{tailChain}</group>
        </group>
      </group>
      {/* the visible, disconnected triangles */}
      {SHARDS.map((d, i) => (
        <mesh
          key={i}
          ref={(m) => { if (m) shardMeshes.current[i] = m; }}
          geometry={plates[i].geo}
          material={d.eye ? eyeMat : mat}
          castShadow={castShadow && !d.eye}
        />
      ))}
    </group>
  );
}
