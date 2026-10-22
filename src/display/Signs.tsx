// Environmental events, rendered subtly in the world (a red balloon, startled dust).
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { WorldEvent } from '../../shared/types';
import { PAL } from './palette';
import { serverNow, store } from './store';

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
        return null;
      })}
    </group>
  );
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
