// Route hints and environmental events, rendered subtly in the world.
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { sampleEdge } from '../../shared/graph';
import type { Hint, World, WorldEvent } from '../../shared/types';
import { CatFigure, newPose } from './CatFigure';
import { PAL } from './palette';
import { serverNow, store } from './store';
import { glowTexture } from './WorldMesh';

function useLiveList<T extends { id: number }>(get: () => T[], hz = 5): T[] {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    let prev = '';
    const t = setInterval(() => {
      const l = get();
      const key = l.map((x) => x.id).join(',');
      if (key !== prev) {
        prev = key;
        setList(l);
      }
    }, 1000 / hz);
    return () => clearInterval(t);
  }, [get, hz]);
  return list;
}

const getHints = () => store.latest?.hints ?? [];

export function Hints({ world }: { world: World }) {
  const hints = useLiveList<Hint>(getHints);
  return (
    <group>
      {hints.map((h) => (
        <HintVisual key={h.id} hint={h} world={world} />
      ))}
    </group>
  );
}

/** smoothed visibility of a hint (by id) from the latest snapshot */
function useVisibility(id: number) {
  const v = useRef(0);
  return (dt: number) => {
    const h = store.latest?.hints.find((x) => x.id === id);
    const target = h ? Math.min(1.2, h.visible) : 0;
    v.current += (target - v.current) * (1 - Math.exp(-dt * 2.5));
    return v.current;
  };
}

function HintVisual({ hint, world }: { hint: Hint; world: World }) {
  const e = world.edges[hint.edgeId];
  const n = world.nodes[hint.nodeId];
  const vis = useVisibility(hint.id);
  const at = (d: number) => sampleEdge(e, n.id, Math.min(e.length, d));
  switch (hint.kind) {
    case 'red-glow':
      return <RedGlow p={at(n.r + 3)} vis={vis} width={e.width} />;
    case 'reflection':
      return <Strip e={e} from={n.id} start={n.r} len={12} color="#ffffff" vis={vis} k={0.32} shimmer />;
    case 'clarity':
      return <Strip e={e} from={n.id} start={n.r} len={16} color={PAL.offwhite} vis={vis} k={0.5} />;
    case 'pawprints':
      return <PawPrints e={e} from={n.id} start={n.r + 0.5} vis={vis} />;
    case 'sound':
      return <SoundRings p={at(Math.min(9, e.length * 0.5))} vis={vis} />;
    case 'silhouette':
      return <Silhouette p={at(n.r + 6)} vis={vis} />;
  }
}

function RedGlow({ p, vis, width }: { p: { x: number; z: number; heading: number }; vis: (dt: number) => number; width: number }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  const spr = useRef<THREE.SpriteMaterial>(null!);
  useFrame((_, dt) => {
    const v = vis(dt);
    const pulse = 0.85 + Math.sin(performance.now() / 700) * 0.15;
    mat.current.opacity = Math.min(0.75, v * 0.6 * pulse);
    spr.current.opacity = Math.min(0.8, v * 0.55 * pulse);
  });
  const side = width / 2 + 0.3;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[p.x, 0.06, p.z]}>
        <circleGeometry args={[Math.max(2.4, width * 0.8), 24]} />
        <meshBasicMaterial ref={mat} map={glowTexture} color={PAL.red} transparent opacity={0} depthWrite={false} />
      </mesh>
      <sprite position={[p.x + Math.cos(p.heading) * side, 1.6, p.z - Math.sin(p.heading) * side]} scale={[2.2, 2.2, 2.2]}>
        <spriteMaterial ref={spr} map={glowTexture} color="#ff2a20" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}

function Strip({ e, from, start, len, color, vis, k, shimmer }: { e: World['edges'][number]; from: number; start: number; len: number; color: string; vis: (dt: number) => number; k: number; shimmer?: boolean }) {
  const geo = useMemo(() => {
    const pos: number[] = [];
    const uv: number[] = [];
    const steps = 12;
    const w = e.width * 0.55;
    const end = Math.min(e.length, start + len);
    for (let i = 0; i <= steps; i++) {
      const d = start + ((end - start) * i) / steps;
      const p = sampleEdge(e, from, d);
      const nx = Math.cos(p.heading);
      const nz = -Math.sin(p.heading);
      pos.push(p.x + nx * w * 0.5, 0.07, p.z + nz * w * 0.5, p.x - nx * w * 0.5, 0.07, p.z - nz * w * 0.5);
      uv.push(0, i / steps, 1, i / steps);
    }
    const idx: number[] = [];
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }, [e, from, start, len]);
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 64);
    const side = g.createLinearGradient(0, 0, 16, 0);
    side.addColorStop(0, 'rgba(0,0,0,1)');
    side.addColorStop(0.5, 'rgba(0,0,0,0)');
    side.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = side;
    g.fillRect(0, 0, 16, 64);
    return new THREE.CanvasTexture(c);
  }, []);
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame((_, dt) => {
    const v = vis(dt);
    const sh = shimmer ? 0.75 + Math.sin(performance.now() / 260) * 0.25 : 1;
    mat.current.opacity = Math.min(0.8, v * k * sh);
  });
  return (
    <mesh geometry={geo}>
      <meshBasicMaterial ref={mat} map={tex} color={color} transparent opacity={0} depthWrite={false} fog={!!shimmer} />
    </mesh>
  );
}

const pawGeo = new THREE.CircleGeometry(0.11, 8);
function PawPrints({ e, from, start, vis }: { e: World['edges'][number]; from: number; start: number; vis: (dt: number) => number }) {
  const prints = useMemo(() => {
    const out: { x: number; z: number; rot: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const p = sampleEdge(e, from, Math.min(e.length - 0.5, start + i * 0.75));
      const side = i % 2 ? 0.18 : -0.18;
      out.push({ x: p.x + Math.cos(p.heading) * side, z: p.z - Math.sin(p.heading) * side, rot: p.heading });
    }
    return out;
  }, [e, from, start]);
  const mats = useMemo(() => prints.map(() => new THREE.MeshBasicMaterial({ color: PAL.charcoal, transparent: true, opacity: 0, depthWrite: false })), [prints]);
  const t0 = useRef(performance.now());
  useFrame((_, dt) => {
    const v = vis(dt);
    const t = (performance.now() - t0.current) / 1000;
    mats.forEach((m, i) => {
      // prints appear one after another, then slowly fade, then repeat
      const local = (t - i * 0.35) % 7;
      const a = local < 0 ? 0 : local < 0.3 ? local / 0.3 : Math.max(0, 1 - (local - 0.3) / 4);
      m.opacity = Math.min(0.75, a * v * 0.8);
    });
  });
  return (
    <group>
      {prints.map((p, i) => (
        <mesh key={i} geometry={pawGeo} material={mats[i]} position={[p.x, 0.07, p.z]} rotation={[-Math.PI / 2, 0, p.rot]} scale={[1, 1.4, 1]} />
      ))}
    </group>
  );
}

const ringGeo = new THREE.RingGeometry(0.92, 1, 40);
function SoundRings({ p, vis }: { p: { x: number; z: number }; vis: (dt: number) => number }) {
  const refs = useRef<THREE.Mesh[]>([]);
  const mats = useMemo(() => [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ color: PAL.charcoal, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })), []);
  useFrame((_, dt) => {
    const v = vis(dt);
    const t = performance.now() / 1000;
    refs.current.forEach((m, i) => {
      if (!m) return;
      const k = (t * 0.5 + i / 3) % 1;
      m.scale.setScalar(0.4 + k * 3.2);
      mats[i].opacity = Math.min(0.4, (1 - k) * v * 0.35);
    });
  });
  return (
    <group position={[p.x, 1.2, p.z]}>
      {mats.map((m, i) => (
        <mesh key={i} ref={(r) => { if (r) refs.current[i] = r; }} geometry={ringGeo} material={m} rotation={[-Math.PI / 2, 0, 0]} />
      ))}
    </group>
  );
}

function Silhouette({ p, vis }: { p: { x: number; z: number; heading: number }; vis: (dt: number) => number }) {
  const pose = useMemo(() => {
    const ps = newPose();
    ps.state = 'home';
    return ps;
  }, []);
  const g = useRef<THREE.Group>(null!);
  useFrame((_, dt) => {
    const v = vis(dt);
    g.current.visible = v > 0.05;
    g.current.scale.setScalar(0.4 + Math.min(1, v) * 0.6);
  });
  return (
    <group ref={g} position={[p.x, 0, p.z]} rotation={[0, p.heading + Math.PI, 0]}>
      <CatFigure pose={pose} color="#050505" castShadow={false} />
    </group>
  );
}

// ---------- environmental events ----------

const getEvents = () => {
  const now = serverNow();
  return store.events.filter((e) => now < e.t0 + e.dur * 1000 + 500);
};

export function Events() {
  const events = useLiveList<WorldEvent>(getEvents, 4);
  return (
    <group>
      {events.map((ev) => {
        if (ev.kind === 'red-balloon') return <Balloon key={ev.id} ev={ev} />;
        if (ev.kind === 'startle') return <Dust key={ev.id} ev={ev} />;
        if (ev.kind === 'memory-flash' || ev.kind === 'memory-sound' || ev.kind === 'familiar-sound') return <SoundRings key={ev.id} p={ev} vis={eventVis(ev)} />;
        return null;
      })}
    </group>
  );
}

function eventVis(ev: WorldEvent) {
  return () => {
    const k = (serverNow() - ev.t0) / 1000 / ev.dur;
    return k < 0 || k > 1 ? 0 : Math.sin(k * Math.PI) * ev.strength;
  };
}

function Balloon({ ev }: { ev: WorldEvent }) {
  const g = useRef<THREE.Group>(null!);
  const tx = Number(ev.data?.tx ?? ev.x);
  const tz = Number(ev.data?.tz ?? ev.z);
  useFrame(() => {
    const k = Math.max(0, Math.min(1, (serverNow() - ev.t0) / 1000 / ev.dur));
    const dx = tx - ev.x;
    const dz = tz - ev.z;
    const L = Math.hypot(dx, dz) || 1;
    // drifts a while toward home while rising
    const d = Math.min(L, 40) * k;
    g.current.position.set(ev.x + (dx / L) * d, 1.5 + k * 22 + Math.sin(k * 20) * 0.3, ev.z + (dz / L) * d);
    g.current.rotation.z = Math.sin(k * 14) * 0.15;
  });
  return (
    <group ref={g}>
      <mesh castShadow>
        <sphereGeometry args={[0.45, 14, 12]} />
        <meshStandardMaterial color={PAL.red} roughness={0.4} />
      </mesh>
      <mesh position={[0, -0.9, 0]}>
        <cylinderGeometry args={[0.006, 0.006, 1.4, 3]} />
        <meshBasicMaterial color={PAL.charcoal} />
      </mesh>
    </group>
  );
}

function Dust({ ev }: { ev: WorldEvent }) {
  const refs = useRef<THREE.Mesh[]>([]);
  const parts = useMemo(() => Array.from({ length: 10 }, (_, i) => ({ a: (i / 10) * Math.PI * 2, v: 0.8 + (i % 3) * 0.4 })), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: PAL.charcoal, transparent: true, opacity: 0.5, depthWrite: false }), []);
  useFrame(() => {
    const k = Math.max(0, (serverNow() - ev.t0) / 1000);
    mat.opacity = Math.max(0, 0.5 - k * 0.4);
    refs.current.forEach((m, i) => {
      if (!m) return;
      const p = parts[i];
      m.position.set(Math.sin(p.a) * k * p.v, 0.2 + k * 0.6, Math.cos(p.a) * k * p.v);
    });
  });
  return (
    <group position={[ev.x, 0, ev.z]}>
      {parts.map((_, i) => (
        <mesh key={i} ref={(r) => { if (r) refs.current[i] = r; }} material={mat}>
          <icosahedronGeometry args={[0.12, 0]} />
        </mesh>
      ))}
    </group>
  );
}
