// Home: a red, sheltered space where other cats wait. Revealed gradually.
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { leaveHeading, wrapAngle } from '../../shared/graph';
import { Rng } from '../../shared/rng';
import type { World } from '../../shared/types';
import { CatFigure, newPose, type CatPose } from './CatFigure';
import { PAL } from './palette';
import { serverNow, store } from './store';
import { glowTexture } from './WorldMesh';

const CAT_COLORS = ['#2a2928', '#4b4a47', '#6e6c68', '#1a1a1a', '#8f8d88', '#d9d6cf'];

export function Home({ world }: { world: World }) {
  const node = world.nodes[world.home];
  const r = node.r;
  const { walls, cats } = useMemo(() => {
    const rng = new Rng('home:' + world.seed);
    const openings = node.edges.map((eid) => leaveHeading(world.edges[eid], node.id));
    const walls: { a: number; h: number }[] = [];
    const seg = 22;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      if (openings.some((o) => Math.abs(wrapAngle(a - o)) < 0.42)) continue;
      walls.push({ a, h: rng.range(2.2, 4.5) });
    }
    const cats: { a: number; rr: number; color: string; pose: CatPose; face: number }[] = [];
    for (let i = 0; i < 6; i++) {
      let a = rng.range(0, Math.PI * 2);
      for (let k = 0; k < 8 && openings.some((o) => Math.abs(wrapAngle(a - o)) < 0.5); k++) a = rng.range(0, Math.PI * 2);
      const pose = newPose();
      pose.state = 'home';
      cats.push({ a, rr: r * rng.range(0.45, 0.75), color: CAT_COLORS[i % CAT_COLORS.length], pose, face: a + Math.PI + rng.range(-0.6, 0.6) });
    }
    return { walls, cats };
  }, [world, node, r]);

  const beam = useRef<THREE.Mesh>(null!);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null!);
  const glowMat = useRef<THREE.SpriteMaterial>(null!);
  const light = useRef<THREE.PointLight>(null!);
  const catRefs = useRef<THREE.Group[]>([]);
  const st = useRef({ reveal: 0.08, flash: 0, gather: 0 });

  useFrame((_, dt) => {
    const snap = store.latest;
    if (!snap) return;
    const s = st.current;
    s.reveal += (snap.homeReveal - s.reveal) * (1 - Math.exp(-dt * 0.8));
    // distant red light events make the beacon flare
    const now = serverNow();
    let flash = 0;
    for (const ev of store.events) {
      if (ev.kind !== 'distant-red-light') continue;
      const k = (now - ev.t0) / 1000 / ev.dur;
      if (k >= 0 && k <= 1) flash = Math.max(flash, Math.sin(k * Math.PI) * ev.strength);
    }
    s.flash += (flash - s.flash) * (1 - Math.exp(-dt * 3));
    const arriving = snap.phase === 'arrival' || (snap.phase === 'summary' && snap.ending === 'home');
    s.gather += ((arriving ? 1 : 0) - s.gather) * (1 - Math.exp(-dt * 0.7));
    beamMat.current.opacity = Math.min(0.4, s.reveal * 0.2 + s.flash * 0.3) * (1 - s.gather * 0.5);
    glowMat.current.opacity = Math.min(0.7, s.reveal * 0.4 + s.flash * 0.35) * (1 - s.gather * 0.6);
    light.current.intensity = 3 + s.reveal * 10 + s.gather * 14;
    beam.current.scale.x = beam.current.scale.z = 1 + Math.sin(performance.now() / 900) * 0.04;
    // waiting cats turn toward Dargato when he is near, and gather around him
    const c = store.cat;
    const dist = Math.hypot(c.x - node.x, c.z - node.z);
    cats.forEach((cat, i) => {
      const g = catRefs.current[i];
      if (!g) return;
      const rr = cat.rr * (1 - s.gather * 0.45);
      const x = node.x + Math.sin(cat.a) * rr;
      const z = node.z + Math.cos(cat.a) * rr;
      g.position.set(x, 0, z);
      const toCat = Math.atan2(c.x - x, c.z - z);
      const target = dist < 40 || arriving ? toCat : cat.face + Math.sin(performance.now() / 4000 + i) * 0.4;
      g.rotation.y += wrapAngle(target - g.rotation.y) * (1 - Math.exp(-dt * 1.5));
      cat.pose.lookYaw = Math.sin(performance.now() / 2300 + i * 1.7) * 0.35;
      cat.pose.state = arriving && i % 2 === 0 ? 'hesitating' : 'home';
    });
  });

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[node.x, 0.045, node.z]} receiveShadow>
        <circleGeometry args={[r, 40]} />
        <meshStandardMaterial color={PAL.red} roughness={0.85} />
      </mesh>
      {walls.map((w, i) => (
        <mesh key={i} position={[node.x + Math.sin(w.a) * (r + 0.4), w.h / 2, node.z + Math.cos(w.a) * (r + 0.4)]} rotation={[0, w.a, 0]} castShadow receiveShadow>
          <boxGeometry args={[(Math.PI * 2 * (r + 0.4)) / 22 + 0.05, w.h, 0.5]} />
          <meshStandardMaterial color={PAL.redDeep} roughness={0.9} />
        </mesh>
      ))}
      <mesh ref={beam} position={[node.x, 40, node.z]}>
        <cylinderGeometry args={[1.6, 3.2, 80, 16, 1, true]} />
        <meshBasicMaterial ref={beamMat} color={PAL.red} transparent opacity={0.1} depthWrite={false} fog={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>
      <sprite position={[node.x, 6, node.z]} scale={[26, 26, 26]}>
        <spriteMaterial ref={glowMat} map={glowTexture} color={PAL.red} transparent opacity={0.2} depthWrite={false} fog={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <pointLight ref={light} position={[node.x, 3, node.z]} color="#ff3b2e" intensity={10} distance={r * 2.4} decay={2} />
      {cats.map((cat, i) => (
        <group key={i} ref={(g) => { if (g) catRefs.current[i] = g; }}>
          <CatFigure pose={cat.pose} color={cat.color} />
        </group>
      ))}
    </group>
  );
}
