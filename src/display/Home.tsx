// Home: an open field of red dots where other cats wait, no walls, no floor. It is
// densest at its heart and thins out into the streets around it; a slow pulse breathes
// outward through it, and a column of rising dots marks it from far away.
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { homeField } from '../../shared/config';
import { wrapAngle } from '../../shared/graph';
import { Rng } from '../../shared/rng';
import type { World } from '../../shared/types';
import { CatFigure, newPose, type CatPose } from './CatFigure';
import { PAL } from './palette';
import { serverNow, store } from './store';
import { glowTexture } from './WorldMesh';

const CAT_COLORS = ['#2a2928', '#4b4a47', '#6e6c68', '#1a1a1a', '#8f8d88', '#d9d6cf'];
const FIELD = 0;
const HOVER = 1;
const COLUMN = 2;
const COLUMN_H = 70;

function buildField(world: World, radius: number): THREE.BufferGeometry {
  const rng = new Rng('home-field:' + world.seed);
  const node = world.nodes[world.home];
  const pos: number[] = [];
  const misc: number[] = []; // phase, size, mode, shade
  const scatter: number[] = [];
  const push = (x: number, y: number, z: number, phase: number, size: number, mode: number, shade: number) => {
    pos.push(x, y, z);
    misc.push(phase, size, mode, shade);
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(1, 6);
    scatter.push(Math.sin(a) * r, rng.range(1.5, 7), Math.cos(a) * r);
  };
  // the field: dots on the ground, thinning out toward its edge
  const n = Math.ceil(radius * radius * 12);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.pow(rng.next(), 0.8) * radius;
    push(node.x + Math.sin(a) * rr, rng.range(0.03, 0.14), node.z + Math.cos(a) * rr, rng.next(), rng.range(0.07, 0.16), FIELD, rng.range(0, 1));
  }
  // a few dots hovering above it, slowly rising
  for (let i = 0; i < n * 0.12; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.pow(rng.next(), 1.1) * radius * 0.85;
    push(node.x + Math.sin(a) * rr, 0, node.z + Math.cos(a) * rr, rng.next(), rng.range(0.08, 0.18), HOVER, rng.range(0, 1));
  }
  // the beacon: a loose column rising out of its heart
  for (let i = 0; i < 900; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.abs(rng.next() + rng.next() - 1) * 2.6;
    push(node.x + Math.sin(a) * rr, 0, node.z + Math.cos(a) * rr, rng.next(), rng.range(0.14, 0.32), COLUMN, rng.range(0, 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aMisc', new THREE.Float32BufferAttribute(misc, 4));
  g.setAttribute('aScatter', new THREE.Float32BufferAttribute(scatter, 3));
  return g;
}

const vertexShader = /* glsl */ `
  attribute vec4 aMisc; // phase, size, mode, shade
  attribute vec3 aScatter;
  uniform float uTime;
  uniform float uScale;
  uniform vec3 uCentre; // x, z, radius
  uniform float uReveal;
  uniform float uFlash;
  uniform float uGather;
  uniform float uDisperse;
  varying float vAlpha;
  varying float vShade;
  varying float vDepth;
  varying float vColumn;
  const float COLUMN_H = ${COLUMN_H.toFixed(1)};
  void main() {
    float phase = aMisc.x;
    float mode = aMisc.z;
    vec3 p = position;
    float d = length(p.xz - uCentre.xy);
    float edge = smoothstep(uCentre.z, uCentre.z * 0.55, d);
    float alpha;
    vColumn = 0.0;
    if (mode < 0.5) {
      // a pulse breathing outward from the heart of the field
      float wave = 0.5 + 0.5 * sin(d * 0.45 - uTime * (1.1 + uGather * 1.4) + phase * 0.8);
      alpha = edge * (0.45 + 0.55 * wave) * (0.75 + 0.25 * sin(uTime * 1.3 + phase * 6.2832));
      p.y += 0.04 * sin(uTime * 0.8 + phase * 30.0);
    } else if (mode < 1.5) {
      // hovering: drifts up and fades, then starts again; on arrival they all lift
      float f = fract(phase + uTime * (0.05 + uGather * 0.06));
      p.y = 0.2 + f * (2.5 + uGather * 5.0);
      p.x += sin(uTime * 0.4 + phase * 12.0) * 0.5;
      p.z += cos(uTime * 0.33 + phase * 9.0) * 0.5;
      alpha = edge * sin(f * 3.14159) * 0.9;
    } else {
      float f = fract(phase + uTime * 0.035);
      p.y = f * COLUMN_H;
      p.xz = uCentre.xy + (p.xz - uCentre.xy) * (1.0 + f * 0.9 + 0.12 * sin(uTime + phase * 20.0));
      alpha = sin(f * 3.14159) * (0.25 + uReveal * 0.45 + uFlash * 0.4) * (1.0 - uGather * 0.5);
      vColumn = 1.0;
    }
    // forgetting lifts the field apart like the streets
    float s = uDisperse * uDisperse * (3.0 - 2.0 * uDisperse) * 0.6 * (1.0 - vColumn);
    p += aScatter * s;
    alpha *= 1.0 - 0.4 * s;
    alpha *= 0.55 + 0.45 * max(uReveal, uGather) + uFlash * 0.3;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aMisc.y * (1.0 + uFlash * 0.4) * uScale / max(0.1, -mv.z));
    vAlpha = alpha;
    vShade = aMisc.w;
    vDepth = -mv.z;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uRed;
  uniform vec3 uDeep;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying float vAlpha;
  varying float vShade;
  varying float vDepth;
  varying float vColumn;
  void main() {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float a = smoothstep(1.0, 0.35, d) * vAlpha;
    if (a < 0.01) discard;
    // the field lies in the fog like everything else; the column cuts through it
    float fog = (1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth)) * (1.0 - 0.75 * vColumn);
    vec3 col = mix(uRed, uDeep, vShade * 0.6);
    gl_FragColor = vec4(mix(col, uFogColor, fog * 0.6), min(1.0, a * 1.2) * (1.0 - fog * 0.4));
  }
`;

export function Home({ world }: { world: World }) {
  const node = world.nodes[world.home];
  const { radius } = homeField(node.r);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const geo = useMemo(() => buildField(world, radius), [world, radius]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uScale: { value: 500 },
          uCentre: { value: new THREE.Vector3(node.x, node.z, radius) },
          uReveal: { value: 0 },
          uFlash: { value: 0 },
          uGather: { value: 0 },
          uDisperse: { value: 0 },
          uRed: { value: new THREE.Color('#e3261c') },
          uDeep: { value: new THREE.Color(PAL.redDeep) },
          uFogColor: { value: new THREE.Color(PAL.fog) },
          uFogDensity: { value: 0.02 },
        },
      }),
    [node, radius],
  );

  const cats = useMemo(() => {
    const rng = new Rng('home:' + world.seed);
    const cats: { x: number; z: number; color: string; pose: CatPose; face: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = rng.range(node.r * 0.4, radius * 0.5);
      const pose = newPose();
      pose.state = 'home';
      cats.push({ x: node.x + Math.sin(a) * rr, z: node.z + Math.cos(a) * rr, color: CAT_COLORS[i % CAT_COLORS.length], pose, face: a + Math.PI + rng.range(-0.6, 0.6) });
    }
    return cats;
  }, [world, node, radius]);

  const glowMat = useRef<THREE.SpriteMaterial>(null!);
  const light = useRef<THREE.PointLight>(null!);
  const catRefs = useRef<THREE.Group[]>([]);
  const st = useRef({ reveal: 0.08, flash: 0, gather: 0 });

  useFrame((state, dt) => {
    const snap = store.latest;
    const cam = state.camera as THREE.PerspectiveCamera;
    const u = mat.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    u.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    u.uDisperse.value = store.fx.disperse;
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density;
    }
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
    u.uReveal.value = s.reveal;
    u.uFlash.value = s.flash;
    u.uGather.value = s.gather;
    glowMat.current.opacity = Math.min(0.6, s.reveal * 0.35 + s.flash * 0.35) * (1 - s.gather * 0.6);
    light.current.intensity = 3 + s.reveal * 10 + s.gather * 14;
    // waiting cats turn toward Dargato when he is near, and drift toward him on arrival
    const c = store.cat;
    const dist = Math.hypot(c.x - node.x, c.z - node.z);
    cats.forEach((cat, i) => {
      const g = catRefs.current[i];
      if (!g) return;
      const k = s.gather * 0.55;
      const x = cat.x + (c.x - cat.x) * k * 0.6;
      const z = cat.z + (c.z - cat.z) * k * 0.6;
      g.position.set(x, 0, z);
      const toCat = Math.atan2(c.x - x, c.z - z);
      const target = dist < radius + 20 || arriving ? toCat : cat.face + Math.sin(performance.now() / 4000 + i) * 0.4;
      g.rotation.y += wrapAngle(target - g.rotation.y) * (1 - Math.exp(-dt * 1.5));
      cat.pose.lookYaw = Math.sin(performance.now() / 2300 + i * 1.7) * 0.35;
      cat.pose.state = arriving && i % 2 === 0 ? 'hesitating' : 'home';
    });
  });

  return (
    <group>
      <points geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />
      <sprite position={[node.x, 6, node.z]} scale={[30, 30, 30]}>
        <spriteMaterial ref={glowMat} map={glowTexture} color={PAL.red} transparent opacity={0.2} depthWrite={false} fog={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <pointLight ref={light} position={[node.x, 3, node.z]} color="#ff3b2e" intensity={10} distance={radius * 1.6} decay={2} />
      {cats.map((cat, i) => (
        <group key={i} ref={(g) => { if (g) catRefs.current[i] = g; }}>
          <CatFigure pose={cat.pose} color={cat.color} />
        </group>
      ))}
    </group>
  );
}
