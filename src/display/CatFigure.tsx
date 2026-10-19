// An abstract, geometric cat with procedural animation driven by a pose object.
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactElement } from 'react';
import * as THREE from 'three';
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

interface Props {
  pose: CatPose;
  color?: string;
  eyeColor?: string;
  scale?: number;
  castShadow?: boolean;
}

const damp = (cur: number, target: number, lambda: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

export function CatFigure({ pose, color = '#121212', eyeColor = '#e9e6dc', scale = 1, castShadow = true }: Props) {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true }), [color]);
  const eyeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: eyeColor }), [eyeColor]);
  const geo = useMemo(
    () => ({
      body: new THREE.CapsuleGeometry(0.24, 0.62, 3, 8),
      chest: new THREE.IcosahedronGeometry(0.27, 0),
      head: new THREE.IcosahedronGeometry(0.22, 1),
      snout: new THREE.ConeGeometry(0.1, 0.16, 4),
      ear: new THREE.ConeGeometry(0.075, 0.2, 3),
      leg: new THREE.BoxGeometry(0.075, 0.36, 0.075),
      tail: new THREE.CylinderGeometry(0.035, 0.045, 0.16, 5),
      eye: new THREE.SphereGeometry(0.028, 6, 4),
    }),
    [],
  );
  const root = useRef<THREE.Group>(null!);
  const bodyG = useRef<THREE.Group>(null!);
  const headG = useRef<THREE.Group>(null!);
  const earL = useRef<THREE.Mesh>(null!);
  const earR = useRef<THREE.Mesh>(null!);
  const legs = useRef<THREE.Group[]>([]);
  const tail = useRef<THREE.Group[]>([]);
  const st = useRef({ phase: 0, bodyY: 0.52, pitch: 0, roll: 0, headYaw: 0, headPitch: 0, earUp: 1, tailUp: 0.4, tailPuff: 1, legFold: 0, sit: 0, curl: 0, stretch: 0, t: 0 });

  useFrame((_, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    const s = st.current;
    const p = pose;
    s.t += dt;
    const moving = p.speed > 0.15;
    const trot = p.state === 'trotting';
    s.phase += dt * p.speed * (trot ? 5.2 : 4.4);

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

    const bob = moving ? Math.abs(Math.sin(s.phase)) * (trot ? 0.06 : 0.03) : Math.sin(s.t * 2) * 0.008;
    const b = bodyG.current;
    b.position.y = s.bodyY + bob - s.sit * 0.08;
    b.rotation.x = s.pitch - s.sit * 0.55 + s.stretch * 0.25;
    b.rotation.z = s.roll;
    b.rotation.y = s.curl * 0.9;
    b.scale.set(1, 1, 1 + s.stretch * 0.12);

    const h = headG.current;
    h.rotation.set(s.headPitch + s.sit * 0.5 - s.stretch * 0.3, s.headYaw, 0, 'YXZ');
    earL.current.scale.y = s.earUp;
    earR.current.scale.y = s.earUp;

    // legs: diagonal gait
    const amp = moving ? (trot ? 0.75 : 0.5) : 0;
    const offs = [0, Math.PI, Math.PI, 0];
    legs.current.forEach((g, i) => {
      if (!g) return;
      const front = i < 2;
      const swing = Math.sin(s.phase + offs[i]) * amp;
      g.rotation.x = swing * (1 - s.legFold) + (front ? -1.4 : 1.4) * s.legFold * 0.9 + (front ? s.sit * 0.5 : -s.sit * 1.2);
      g.position.y = -0.08 - s.legFold * 0.05;
    });

    // tail: a chain bending upward, with a curious hook at the tip
    tail.current.forEach((g, i) => {
      if (!g) return;
      const k = i / (TAIL_SEGS - 1);
      const sway = Math.sin(s.t * (moving ? 3 : 1.4) + i * 0.6) * (0.12 + 0.1 * k);
      g.rotation.x = s.tailUp * 0.42 + (i === TAIL_SEGS - 1 ? p.curiosity * 0.6 : 0) - s.curl * 0.2;
      g.rotation.z = sway + s.curl * 0.45;
      g.scale.set(s.tailPuff, 1, s.tailPuff);
    });

    root.current.scale.setScalar(scale);
  });

  const tailChain = useMemo(() => {
    // nested groups, each segment offset along its parent
    const build = (i: number): ReactElement | null => {
      if (i >= TAIL_SEGS) return null;
      return (
        <group key={i} position={[0, 0, i === 0 ? 0 : -0.15]} ref={(g) => { if (g) tail.current[i] = g; }}>
          <mesh geometry={geo.tail} material={mat} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.075]} castShadow={castShadow} scale={[1 - i * 0.08, 1, 1 - i * 0.08]} />
          {build(i + 1)}
        </group>
      );
    };
    return build(0);
  }, [geo, mat, castShadow]);

  const legPos: [number, number, number][] = [
    [0.13, 0, 0.34],
    [-0.13, 0, 0.34],
    [0.13, 0, -0.34],
    [-0.13, 0, -0.34],
  ];

  return (
    <group ref={root}>
      <group ref={bodyG} position={[0, 0.52, 0]}>
        <mesh geometry={geo.body} material={mat} rotation={[Math.PI / 2, 0, 0]} castShadow={castShadow} />
        <mesh geometry={geo.chest} material={mat} position={[0, 0.03, 0.3]} castShadow={castShadow} />
        {legPos.map((lp, i) => (
          <group key={i} position={lp} ref={(g) => { if (g) legs.current[i] = g; }}>
            <mesh geometry={geo.leg} material={mat} position={[0, -0.18, 0]} castShadow={castShadow} />
          </group>
        ))}
        <group ref={headG} position={[0, 0.2, 0.52]}>
          <mesh geometry={geo.head} material={mat} castShadow={castShadow} />
          <mesh geometry={geo.snout} material={mat} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.04, 0.2]} />
          <mesh ref={earL} geometry={geo.ear} material={mat} position={[0.11, 0.2, -0.02]} rotation={[0, 0, -0.25]} castShadow={castShadow} />
          <mesh ref={earR} geometry={geo.ear} material={mat} position={[-0.11, 0.2, -0.02]} rotation={[0, 0, 0.25]} castShadow={castShadow} />
          <mesh geometry={geo.eye} material={eyeMat} position={[0.085, 0.04, 0.19]} />
          <mesh geometry={geo.eye} material={eyeMat} position={[-0.085, 0.04, 0.19]} />
        </group>
        <group position={[0, 0.08, -0.52]}>{tailChain}</group>
      </group>
    </group>
  );
}
