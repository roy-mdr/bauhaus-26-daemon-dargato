import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { lerpAngle, wrapAngle } from '../../shared/graph';
import { INTRO } from '../../shared/config';
import { hashString } from '../../shared/rng';
import type { World } from '../../shared/types';
import { CatFigure, newPose } from './CatFigure';
import { PAL } from './palette';
import { sampleCat, serverNow, store, updateFx } from './store';

/** smooths the senses' scene effects once per frame, before anything reads them */
export function SenseFx() {
  useFrame((_, dt) => updateFx(Math.min(0.1, dt)), -1);
  return null;
}

/** Dargato: interpolated from server snapshots, animated locally */
export function Dargato() {
  const g = useRef<THREE.Group>(null!);
  const pose = useMemo(() => newPose(), []);
  const vis = useRef({ heading: 0, init: false, lastState: '', stateSince: 0 });
  useFrame((_, dt) => {
    const c = sampleCat();
    const v = vis.current;
    if (!v.init) {
      v.heading = c.heading;
      v.init = true;
    }
    v.heading = lerpAngle(v.heading, c.heading, 1 - Math.exp(-dt * 8));
    g.current.position.set(c.x, 0, c.z);
    g.current.rotation.y = v.heading;
    const t = performance.now() / 1000;
    if (c.state !== v.lastState) {
      v.lastState = c.state;
      v.stateSince = t;
    }
    pose.state = c.state;
    pose.stateTime = t - v.stateSince;
    // paws keep moving even when there is no path to walk on (treading, never galloping on the spot)
    pose.speed = c.state === 'hesitating' ? Math.min(c.paws, 1.6) : Math.max(c.speed, c.paws);
    if (c.look) {
      const rel = wrapAngle(Math.atan2(c.look[0] - c.x, c.look[1] - c.z) - v.heading);
      pose.lookYaw = rel;
      pose.lookPitch = 0;
    } else {
      pose.lookYaw *= 0.9;
    }
    // forgetting scatters his shards, a strained heart pulls them together
    const fx = store.fx;
    pose.curiosity = fx.disperse;
    pose.caution = fx.strain;
    pose.calm = fx.steady;
  });
  return (
    <group ref={g}>
      <CatFigure pose={pose} color={PAL.black} />
    </group>
  );
}

export function CameraRig() {
  const camera = useThree((s) => s.camera);
  const st = useRef({ pos: new THREE.Vector3(0, 30, 30), target: new THREE.Vector3(), yaw: 0, init: false, orbit: 0, lift: 0, intro: false });
  useFrame((_, rawDt) => {
    const dt = Math.min(0.1, rawDt);
    const s = st.current;
    const snap = store.latest;
    const c = store.cat;
    if (!snap || !store.world) return;
    const phase = snap.phase;
    const phaseT = snap.phaseT + Math.max(0, (serverNow() - snap.t) / 1000);
    if (!s.init) {
      s.yaw = c.heading;
      s.pos.set(c.x - Math.sin(c.heading) * 30, 40, c.z - Math.cos(c.heading) * 30);
      s.init = true;
    }
    s.yaw = lerpAngle(s.yaw, c.heading, 1 - Math.exp(-dt * 1.1));
    const fwd = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const desiredPos = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3(c.x, 0.8, c.z);
    let rate = 2.4;
    const hesitating = c.state === 'hesitating';
    s.lift += ((hesitating ? 1 : 0) - s.lift) * (1 - Math.exp(-dt * 1.5));
    if (phase !== 'intro') s.intro = false;

    if (phase === 'lobby' || phase === 'tutorial') {
      // a slow, high orbit: the district seen from above the roofs
      s.orbit += dt * 0.05;
      desiredPos.set(c.x + Math.sin(s.orbit) * 9, 44, c.z + Math.cos(s.orbit) * 9);
      rate = 1.2;
    } else if (phase === 'intro') {
      // it begins at home, flies over the roofs to where Dargato wakes, and settles behind him
      const home = store.world.nodes[store.world.home];
      const smooth = (v: number) => {
        const x = Math.min(1, Math.max(0, v));
        return x * x * (3 - 2 * x);
      };
      // home seen from a little way off: one slow turn around it, ending on the side facing Dargato
      const a = Math.atan2(c.x - home.x, c.z - home.z) + Math.PI * 2 * smooth(phaseT / INTRO.home);
      const homePos = new THREE.Vector3(home.x + Math.sin(a) * 16, 9, home.z + Math.cos(a) * 16);
      const homeTarget = new THREE.Vector3(home.x, 2, home.z);
      // high above and behind Dargato, then down to the walking view
      const catHigh = new THREE.Vector3(c.x - fwd.x * 22, 20, c.z - fwd.z * 22);
      const catTarget = desiredTarget.clone().addScaledVector(fwd, 4.5);
      const catPos = new THREE.Vector3(c.x - fwd.x * 8.5, 4.6, c.z - fwd.z * 8.5);
      const f = smooth((phaseT - INTRO.home) / INTRO.fly);
      const g = smooth((phaseT - INTRO.home - INTRO.fly) / INTRO.settle);
      desiredPos.lerpVectors(homePos, catHigh, f).lerp(catPos, g);
      // the flight climbs early and stays high over the roofs (stacked pieces reach ~45 up)
      desiredPos.y += Math.pow(Math.sin(f * Math.PI), 0.5) * 42;
      desiredTarget.lerpVectors(homeTarget, catTarget, f);
      if (!s.intro) {
        // the tutorial covered the screen: cut straight to home
        s.pos.copy(homePos);
        s.target.copy(homeTarget);
        s.intro = true;
      }
      rate = 6;
    } else if (phase === 'arrival' || (phase === 'summary' && snap.ending === 'home')) {
      const home = store.world.nodes[store.world.home];
      s.orbit += dt * 0.12;
      const r = 12 + Math.min(phaseT, 12) * 0.6;
      desiredPos.set(home.x + Math.sin(s.orbit) * r, 6 + Math.min(phaseT, 12) * 0.5, home.z + Math.cos(s.orbit) * r);
      desiredTarget.set(home.x, 0.6, home.z);
      rate = 0.9;
    } else if (phase === 'sleep' || phase === 'summary') {
      desiredPos.set(c.x - fwd.x * 6, 8 + Math.min(phaseT, 20) * 0.6, c.z - fwd.z * 6);
      rate = 0.8;
    } else {
      const dist = 8.5 + c.speed * 0.5 + s.lift * 2.5;
      const h = 4.6 + s.lift * 3.2;
      desiredPos.set(c.x - fwd.x * dist, h, c.z - fwd.z * dist);
      desiredTarget.addScaledVector(fwd, 4.5 + s.lift * 2);
    }
    const k = 1 - Math.exp(-dt * rate);
    s.pos.lerp(desiredPos, k);
    s.target.lerp(desiredTarget, 1 - Math.exp(-dt * rate * 1.5));
    camera.position.copy(s.pos);
    camera.lookAt(s.target);
  });
  return null;
}

/** fog, sky and long low-sun shadows that follow the cat */
export function Atmosphere({ world }: { world: World }) {
  const scene = useThree((s) => s.scene);
  const sun = useRef<THREE.DirectionalLight>(null!);
  const hemi = useRef<THREE.HemisphereLight>(null!);
  const fog = useMemo(() => new THREE.FogExp2(PAL.fog, 0.02), []);
  const bg = useMemo(() => new THREE.Color(PAL.fog), []);
  const tmp = useMemo(
    () => ({ base: new THREE.Color(PAL.fog), arr: new THREE.Color(PAL.fogArrival), sleep: new THREE.Color(PAL.fogSleep), dark: new THREE.Color('#090909'), glare: new THREE.Color('#fbfaf6'), mix: 0, sleepMix: 0, density: 0.02 }),
    [],
  );
  const sunDir = useMemo(() => {
    const az = (hashString(world.seed) % 628) / 100;
    const el = 0.36;
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  }, [world.seed]);
  useEffect(() => {
    scene.fog = fog;
    scene.background = bg;
    sun.current.target.position.set(0, 0, 0);
    scene.add(sun.current.target);
  }, [scene, fog, bg]);
  useFrame((_, dt) => {
    const snap = store.latest;
    const c = store.cat;
    const fx = store.fx;
    const base = snap?.render.fog ?? 0.022;
    const phase = snap?.phase;
    // SIGHT: too bright and the glare fog thickens, too dark and the night closes in
    const m = phase === 'lobby' || phase === 'tutorial' ? 0.8 : phase === 'intro' ? 1.2 : phase === 'arrival' ? 0.6 : 1;
    const target = base * m * (1 + 4.5 * fx.glare + 0.6 * (1 - fx.light));
    tmp.density += (target - tmp.density) * (1 - Math.exp(-dt * 1.5));
    fog.density = tmp.density;
    const arrival = phase === 'arrival' || (phase === 'summary' && snap?.ending === 'home') ? 1 : 0;
    const sleeping = phase === 'sleep' || (phase === 'summary' && snap?.ending === 'sleep') ? 1 : 0;
    tmp.mix += (arrival - tmp.mix) * (1 - Math.exp(-dt * 0.6));
    tmp.sleepMix += (sleeping + (snap?.overtime ? 0.35 : 0) - tmp.sleepMix) * (1 - Math.exp(-dt * 0.3));
    fog.color
      .copy(tmp.base)
      .lerp(tmp.arr, tmp.mix)
      .lerp(tmp.sleep, Math.min(1, tmp.sleepMix))
      .lerp(tmp.dark, (1 - fx.light) * 0.97)
      .lerp(tmp.glare, fx.glare * 0.85);
    bg.copy(fog.color);
    const light = (snap?.render.light ?? 1) * (0.02 + 0.98 * fx.light * fx.light);
    sun.current.intensity = 2.3 * light * (1 - 0.5 * Math.min(1, tmp.sleepMix)) * (1 - 0.4 * fx.glare);
    hemi.current.intensity = 1.25 * light * (1 + 0.5 * fx.glare);
    sun.current.position.set(c.x + sunDir.x * 60, sunDir.y * 60, c.z + sunDir.z * 60);
    sun.current.target.position.set(c.x, 0, c.z);
  });
  return (
    <>
      <hemisphereLight ref={hemi} args={['#f4f2ee', '#8d8a85', 1.2]} />
      <directionalLight
        ref={sun}
        color="#fffaf0"
        intensity={2.3}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={45}
        shadow-camera-bottom={-45}
        shadow-camera-near={1}
        shadow-camera-far={160}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
    </>
  );
}

/** hidden during normal play: graph, planned route, option scores */
export function DebugOverlay({ world }: { world: World }) {
  const base = useMemo(() => {
    const pts: number[] = [];
    for (const e of world.edges) {
      for (let i = 0; i < e.points.length - 1; i++) pts.push(e.points[i].x, 0.3, e.points[i].z, e.points[i + 1].x, 0.3, e.points[i + 1].z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [world]);
  const route = useMemo(() => new THREE.BufferGeometry(), []);
  const nodes = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(world.nodes.flatMap((n) => [n.x, 0.35, n.z]), 3));
    return g;
  }, [world]);
  const last = useRef('');
  const grp = useRef<THREE.Group>(null!);
  useFrame(() => {
    grp.current.visible = store.debug;
    if (!store.debug || !store.latest) return;
    const key = store.latest.planned.join(',');
    if (key === last.current) return;
    last.current = key;
    const pts: number[] = [];
    for (const eid of store.latest.planned) {
      const e = world.edges[eid];
      if (!e) continue;
      for (let i = 0; i < e.points.length - 1; i++) pts.push(e.points[i].x, 0.45, e.points[i].z, e.points[i + 1].x, 0.45, e.points[i + 1].z);
    }
    route.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  });
  return (
    <group ref={grp} visible={false}>
      <lineSegments geometry={base}>
        <lineBasicMaterial color="#1f6fd1" fog={false} depthTest={false} transparent opacity={0.7} />
      </lineSegments>
      <lineSegments geometry={route}>
        <lineBasicMaterial color="#ff2a1f" fog={false} depthTest={false} />
      </lineSegments>
      <points geometry={nodes}>
        <pointsMaterial color="#1f6fd1" size={6} sizeAttenuation={false} fog={false} depthTest={false} />
      </points>
    </group>
  );
}
