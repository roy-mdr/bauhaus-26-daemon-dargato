// Dargato's intrusive thoughts: one small swarm of particles per sense around the cat.
// Each swarm moves according to its player's live channels (simulated senses included),
// and discrete gestures (taps, beats, knocks, flinches) make it flare.
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { PlayerPublic } from '../../shared/protocol';
import { roleKey } from '../../shared/roles';
import { hashString } from '../../shared/rng';
import type { SenseId } from '../../shared/types';
import { PAL } from './palette';
import { store } from './store';

const PER = 16;
const MAX_SWARMS = 20;
const MAX = PER * MAX_SWARMS;
const TAU = Math.PI * 2;

const SENSE_SLOT: Record<SenseId, number> = { vision: 0, direction: 1, instinct: 2, emotion: 3, hearing: 4, memory: 5, heartbeat: 6 };
const SHAPE_DOT = 0;
const SHAPE_RING = 1;

const C = {
  black: new THREE.Color(PAL.black),
  charcoal: new THREE.Color(PAL.charcoal),
  gray: new THREE.Color('#6f6d69'),
  red: new THREE.Color(PAL.red),
  redDeep: new THREE.Color(PAL.redDeep),
};

interface Swarm {
  id: string;
  key: string;
  sense: SenseId;
  slot: number;
  env: number;
  alive: boolean;
  /** smoothed channels */
  ch: Record<string, number>;
  target: Record<string, number>;
  influence: number;
  pulses: number;
  imp: number;
  pos: Float32Array;
  vel: Float32Array;
  seed: Float32Array;
  prevF: Float32Array;
  init: boolean;
}

function newSwarm(p: PlayerPublic): Swarm {
  const h = hashString(p.id);
  const seed = new Float32Array(PER * 3);
  let s = h || 1;
  for (let i = 0; i < seed.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    seed[i] = s / 4294967296;
  }
  return {
    id: p.id,
    key: roleKey(p.role),
    sense: p.role.sense,
    slot: (SENSE_SLOT[p.role.sense] / 7) * TAU + (p.role.variant ? 0.45 : 0) + ((h % 100) / 100 - 0.5) * 0.3,
    env: 0,
    alive: true,
    ch: { ...p.ch },
    target: { ...p.ch },
    influence: p.influence,
    pulses: p.pulses,
    imp: 0,
    pos: new Float32Array(PER * 3),
    vel: new Float32Array(PER * 3),
    seed,
    prevF: new Float32Array(PER),
    init: false,
  };
}

const frac = (x: number) => x - Math.floor(x);
const wob = (t: number, a: number) => Math.sin(t * 1.3 + a * 17) * 0.6 + Math.sin(t * 2.9 + a * 31) * 0.4;

/** output of one particle in cat-local polar coordinates (a: 0 = ahead, + = left) */
interface Out {
  a: number;
  r: number;
  y: number;
  /** extra local offsets (lateral, forward) */
  ox: number;
  oz: number;
  size: number;
  alpha: number;
  shape: number;
  color: THREE.Color;
  /** cyclic phase; a wrap snaps the particle instead of springing back across */
  f: number;
  stiff: number;
}

function shape(sw: Swarm, i: number, t: number, o: Out) {
  const u1 = sw.seed[i * 3];
  const u2 = sw.seed[i * 3 + 1];
  const u3 = sw.seed[i * 3 + 2];
  const ch = sw.ch;
  o.ox = 0;
  o.oz = 0;
  o.f = -1;
  o.stiff = 10;
  o.shape = SHAPE_DOT;
  switch (sw.key) {
    case 'vision':
    case 'vision-b': {
      // brightness opens the eyes: wider, higher, clearer rings
      const v = ch.v ?? 0.5;
      o.a = sw.slot + (u1 - 0.5) * 1.8 + t * 0.12;
      o.r = 0.7 + 0.45 * v + u2 * 1.0 * v;
      o.y = 0.3 + v * 1.15 + 0.2 * wob(t * 0.5, u3);
      o.size = 0.05 + 0.1 * v;
      o.alpha = 0.12 + 0.75 * v;
      o.shape = SHAPE_RING;
      o.color = sw.key === 'vision' ? C.charcoal : C.redDeep;
      o.stiff = 6;
      break;
    }
    case 'direction':
    case 'direction-b': {
      // a stream of thoughts pouring toward the preferred side
      const x = ch.x ?? 0;
      const ax = Math.min(1, Math.abs(x));
      const f = frac(t * (0.25 + 0.45 * ax) + u1);
      o.f = f;
      o.a = -x * 1.45 + (u2 - 0.5) * (1.5 - ax * 1.1);
      if (sw.key === 'direction-b') o.a += Math.PI * 0.18 * Math.sign(x);
      o.r = 0.9 + f * (0.5 + 2.0 * ax);
      o.y = 0.5 + 0.35 * Math.sin(f * Math.PI) + (u3 - 0.5) * 0.3;
      o.size = 0.055;
      o.alpha = (0.2 + 0.7 * ax) * Math.sin(f * Math.PI);
      o.color = sw.key === 'direction' ? C.black : C.gray;
      o.stiff = 14;
      break;
    }
    case 'instinct': {
      // restless sparks around the paws, thrown forward by drive and scratching
      const d = ch.drive ?? 0;
      const sc = ch.scratch ?? 0;
      o.a = u1 * TAU + t * (0.3 + 2.4 * d);
      o.r = 0.45 + u2 * 0.5 + d * 0.5;
      o.y = 0.08 + u3 * 0.25 + d * 0.45 * Math.abs(Math.sin(t * 9 + u1 * 20));
      const j = 0.03 + 0.3 * sc + 0.12 * d;
      o.ox = j * Math.sin(t * 23 + u2 * 40);
      o.oz = j * Math.sin(t * 19 + u3 * 40) + d * 0.7;
      o.size = 0.035 + 0.035 * d;
      o.alpha = 0.25 + 0.65 * Math.max(d, sc);
      o.color = C.charcoal;
      o.stiff = 22;
      break;
    }
    case 'instinct-b': {
      // restraint: heavy thoughts that cling behind him
      const d = ch.drive ?? 0;
      o.a = Math.PI + (u1 - 0.5) * (1.6 - d);
      o.r = 0.9 - 0.35 * d + u2 * 0.4;
      o.y = 0.15 + u3 * (0.6 - 0.4 * d);
      o.size = 0.05 + 0.03 * d;
      o.alpha = 0.2 + 0.65 * d;
      o.color = C.gray;
      o.stiff = 5;
      break;
    }
    case 'emotion': {
      const calm = ch.calm ?? 0;
      const cur = ch.curiosity ?? 0;
      const cau = ch.caution ?? 0;
      const wb = Math.max(0, 1 - calm - cur - cau);
      const tot = wb + calm + cur + cau || 1;
      // loose: a mild cloud
      let lx = 0, lz = 0, ly = 0;
      const add = (a: number, r: number, y: number, w: number) => {
        lx += Math.sin(a) * r * w;
        lz += Math.cos(a) * r * w;
        ly += y * w;
      };
      add(sw.slot + (u1 - 0.5) * 2 + t * 0.2 + 0.3 * wob(t * 0.3, u2), 1.2 + u2 * 0.6, 0.6 + u3 * 0.8 + 0.2 * wob(t * 0.4, u1), wb / tot);
      // calm: a still, level halo above his back
      add(u1 * TAU + t * 0.22, 0.85, 1.15 + 0.03 * Math.sin(u1 * TAU * 3 + t), calm / tot);
      // curiosity: drifting far ahead
      add((u1 - 0.5) * 1.9 + 0.4 * wob(t * 0.6, u3), 1.8 + u2 * 1.5, 0.35 + u3 * 1.3 + 0.3 * wob(t * 0.5, u2), cur / tot);
      // caution: a tight trembling huddle
      add(u1 * TAU, 0.42 + u2 * 0.15, 0.2 + u3 * 0.35, cau / tot);
      o.a = 0;
      o.r = 0;
      o.ox = lx + cau * 0.04 * Math.sin(t * 31 + u2 * 50);
      o.oz = lz + cau * 0.04 * Math.sin(t * 27 + u3 * 50);
      o.y = ly;
      o.size = 0.05 + 0.02 * calm;
      o.alpha = 0.22 + 0.65 * Math.max(calm, cur, cau);
      o.color = C.gray;
      o.stiff = 4 + 10 * cau;
      break;
    }
    case 'emotion-b': {
      // rest: the thoughts settle onto the stones around him
      const rest = ch.rest ?? 0;
      o.a = u1 * TAU + t * 0.08 * (1 - rest);
      o.r = 0.7 + u2 * 0.7;
      o.y = (1 - rest) * (0.5 + u3 * 0.8 + 0.2 * wob(t * 0.4, u1)) + 0.03;
      o.size = 0.05;
      o.alpha = 0.2 + 0.6 * rest;
      o.color = C.gray;
      o.stiff = 3;
      break;
    }
    case 'hearing':
    case 'hearing-b': {
      // listening: rings that widen from his ears
      const A = ch.acuity ?? 0.25;
      const far = sw.key === 'hearing-b';
      const f = frac(t * 0.4 + (i % 3) / 3);
      o.f = f;
      o.a = (i / PER) * TAU * 3 + u2 * 0.4 + sw.slot;
      o.r = (far ? 1.6 : 0.35) + f * ((far ? 2.0 : 1.0) + 2.0 * A);
      o.y = 0.78 + (u3 - 0.5) * 0.1;
      o.size = 0.06 + 0.04 * A;
      o.alpha = (0.1 + 0.8 * A) * Math.min(1, f * 6) * (1 - f);
      o.shape = SHAPE_RING;
      o.color = far ? C.gray : C.charcoal;
      o.stiff = 30;
      break;
    }
    case 'memory':
    case 'memory-b': {
      // red embers rising from his head, louder rooms make more of them
      const L = ch.level ?? 0.2;
      const f = frac(t * (0.1 + 0.3 * L) + u1);
      o.f = f;
      o.a = sw.slot + (u2 - 0.5) * 1.1;
      o.r = 0.35 + u3 * 0.5 + f * 0.7;
      o.y = 0.75 + f * (0.9 + 1.6 * L);
      o.size = 0.04 + 0.045 * L;
      o.alpha = (0.2 + 0.7 * L) * Math.sin(f * Math.PI);
      o.shape = sw.key === 'memory' ? SHAPE_DOT : SHAPE_RING;
      o.color = C.red;
      o.stiff = 8;
      break;
    }
    default: {
      // heartbeat: a small red throb at his chest, in time with the vignette
      const q = ch.quality ?? 0;
      const b = Math.pow(Math.max(0, Math.sin(t * TAU * 1.1)), 10);
      const th = u1 * TAU;
      const ph = Math.acos(2 * u2 - 1);
      const r = 0.3 + 0.18 * b * (0.3 + q);
      o.a = 0;
      o.r = 0;
      o.ox = Math.sin(th) * Math.sin(ph) * r;
      o.oz = 0.2 + Math.cos(th) * Math.sin(ph) * r;
      o.y = 0.55 + Math.cos(ph) * r;
      o.size = 0.035 + 0.03 * b;
      o.alpha = 0.12 + 0.7 * q * (0.5 + 0.5 * b);
      o.color = C.redDeep;
      o.stiff = 40;
    }
  }
}

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aShape;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying float vShape;
  varying vec3 vColor;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uScale / max(0.1, -mv.z));
    vAlpha = aAlpha;
    vShape = aShape;
    vColor = aColor;
    vDepth = -mv.z;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying float vAlpha;
  varying float vShape;
  varying vec3 vColor;
  varying float vDepth;
  void main() {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float a = vShape < 0.5 ? smoothstep(1.0, 0.45, d) : smoothstep(0.28, 0.0, abs(d - 0.68));
    a *= vAlpha;
    if (a < 0.01) discard;
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    gl_FragColor = vec4(mix(vColor, uFogColor, fog), a);
  }
`;

export function Thoughts() {
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const swarms = useRef(new Map<string, Swarm>());
  const phaseEnv = useRef(0);
  const lastCat = useRef({ x: 0, z: 0, init: false });

  const { geo, mat, attr } = useMemo(() => {
    const pos = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3);
    const sz = new THREE.BufferAttribute(new Float32Array(MAX), 1);
    const al = new THREE.BufferAttribute(new Float32Array(MAX), 1);
    const sh = new THREE.BufferAttribute(new Float32Array(MAX), 1);
    for (const a of [pos, col, sz, al, sh]) a.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', pos);
    geo.setAttribute('aColor', col);
    geo.setAttribute('aSize', sz);
    geo.setAttribute('aAlpha', al);
    geo.setAttribute('aShape', sh);
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 500 }, uFogColor: { value: new THREE.Color(PAL.fog) }, uFogDensity: { value: 0.02 } },
    });
    return { geo, mat, attr: { pos, col, sz, al, sh } };
  }, []);

  const out = useMemo<Out>(() => ({ a: 0, r: 0, y: 0, ox: 0, oz: 0, size: 0, alpha: 0, shape: 0, color: C.black, f: -1, stiff: 10 }), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    const snap = store.latest;
    const cat = store.cat;
    const t = state.clock.elapsedTime;

    // uniforms
    const cam = state.camera as THREE.PerspectiveCamera;
    mat.uniforms.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      mat.uniforms.uFogColor.value.copy(fog.color);
      mat.uniforms.uFogDensity.value = fog.density;
    }

    // thoughts are quiet once he is home or asleep
    const phase = snap?.phase ?? 'lobby';
    const pe = phase === 'journey' ? 1 : phase === 'intro' ? Math.min(1, (snap?.phaseT ?? 0) / 4) : phase === 'lobby' ? 0.5 : 0;
    phaseEnv.current += (pe - phaseEnv.current) * (1 - Math.exp(-dt * 0.8));

    // sync swarms with the players in the latest snapshot
    const map = swarms.current;
    for (const sw of map.values()) sw.alive = false;
    for (const p of snap?.players ?? []) {
      let sw = map.get(p.id);
      if (sw && roleKey(p.role) !== sw.key) {
        map.delete(p.id);
        sw = undefined;
      }
      if (!sw) {
        if (map.size >= MAX_SWARMS) continue;
        map.set(p.id, (sw = newSwarm(p)));
      }
      sw.alive = true;
      sw.target = p.ch;
      sw.influence = p.connected ? Math.min(1, p.influence) : Math.min(0.5, p.influence);
      if (p.pulses > sw.pulses) sw.imp = 1;
      sw.pulses = p.pulses;
    }

    const mdx = lastCat.current.init ? cat.x - lastCat.current.x : 0;
    const mdz = lastCat.current.init ? cat.z - lastCat.current.z : 0;
    const jump = Math.hypot(mdx, mdz) > 6;
    lastCat.current = { x: cat.x, z: cat.z, init: true };
    // thoughts travel with him; only a little of his motion is left to the springs, as a trail
    const carry = 0.85;
    const cosH = Math.cos(cat.heading);
    const sinH = Math.sin(cat.heading);

    let n = 0;
    for (const [id, sw] of map) {
      sw.env += ((sw.alive ? sw.influence : 0) - sw.env) * (1 - Math.exp(-dt * 1.2));
      if (!sw.alive && sw.env < 0.01) {
        map.delete(id);
        continue;
      }
      for (const k in sw.target) {
        const cur = sw.ch[k] ?? sw.target[k];
        sw.ch[k] = cur + (sw.target[k] - cur) * (1 - Math.exp(-dt * 6));
      }
      const kick = sw.imp >= 1;
      sw.imp *= Math.exp(-dt * 2.5);
      if (kick) sw.imp = 0.999;

      for (let i = 0; i < PER; i++) {
        shape(sw, i, t, out);
        const lx = Math.sin(out.a) * out.r + out.ox;
        const lz = Math.cos(out.a) * out.r + out.oz;
        // local (lateral +left, forward) -> world
        const tx = cat.x + lx * cosH + lz * sinH;
        const tz = cat.z + lz * cosH - lx * sinH;
        const ty = out.y;
        const j = i * 3;
        const P = sw.pos;
        const V = sw.vel;
        const wrapped = out.f >= 0 && out.f < sw.prevF[i];
        sw.prevF[i] = out.f;
        if (!sw.init || jump || wrapped) {
          P[j] = tx;
          P[j + 1] = ty;
          P[j + 2] = tz;
          V[j] = V[j + 1] = V[j + 2] = 0;
        } else {
          if (kick) {
            // a gesture throws the thoughts outward and up
            const dx = P[j] - cat.x;
            const dz = P[j + 2] - cat.z;
            const dl = Math.hypot(dx, dz) || 1;
            const s = 1.6 + sw.seed[j] * 1.6;
            V[j] += (dx / dl) * s;
            V[j + 1] += 0.8 + sw.seed[j + 1] * 1.2;
            V[j + 2] += (dz / dl) * s;
          }
          P[j] += mdx * carry;
          P[j + 2] += mdz * carry;
          const k = out.stiff;
          const damp = 2 * Math.sqrt(k) * 0.75;
          V[j] += ((tx - P[j]) * k - V[j] * damp) * dt;
          V[j + 1] += ((ty - P[j + 1]) * k - V[j + 1] * damp) * dt;
          V[j + 2] += ((tz - P[j + 2]) * k - V[j + 2] * damp) * dt;
          P[j] += V[j] * dt;
          P[j + 1] = Math.max(0.02, P[j + 1] + V[j + 1] * dt);
          P[j + 2] += V[j + 2] * dt;
        }
        const o = n * 3;
        attr.pos.array[o] = P[j];
        attr.pos.array[o + 1] = P[j + 1];
        attr.pos.array[o + 2] = P[j + 2];
        attr.col.array[o] = out.color.r;
        attr.col.array[o + 1] = out.color.g;
        attr.col.array[o + 2] = out.color.b;
        attr.sz.array[n] = out.size * 1.3 * (1 + sw.imp * 0.6);
        attr.al.array[n] = Math.min(0.9, Math.max(0, out.alpha) * (1 + sw.imp * 0.8)) * sw.env * phaseEnv.current;
        attr.sh.array[n] = out.shape;
        n++;
      }
      sw.init = true;
    }
    geo.setDrawRange(0, n);
    for (const a of Object.values(attr)) a.needsUpdate = true;
  });

  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />;
}
