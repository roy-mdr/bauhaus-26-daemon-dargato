// Dargato's intrusive thoughts: one small swarm of particles per sense around the cat.
// Each swarm moves according to its player's live channels (simulated senses included),
// and discrete gestures (scratches, shakes, heartbeat taps) make it flare.
// The first player of each sense to fulfil their wish gets their name there instead of dots.
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { INTRO, heartPosition } from '../../shared/config';
import { wrapAngle } from '../../shared/graph';
import type { PlayerPublic } from '../../shared/protocol';
import { hashString } from '../../shared/rng';
import type { SenseId } from '../../shared/types';
import { PAL } from './palette';
import { store } from './store';

const PER = 16;
const MAX_SWARMS = 20;
const MAX = PER * MAX_SWARMS;
const TAU = Math.PI * 2;

const SENSE_SLOT: Record<SenseId, number> = { sight: 0, speed: 1, direction: 2, memory: 3, instinct: 4, heartbeat: 5 };
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
  /** this player's name replaces the dots */
  named: boolean;
  /** 0 dots .. 1 name */
  nameEnv: number;
  label?: THREE.Sprite;
}

/** the player's name as a flat label floating by Dargato: a red square, then the name in capitals */
function makeLabel(name: string): THREE.Sprite {
  const text = name.toUpperCase().slice(0, 18);
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d')!;
  const font = '500 56px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.font = font;
  const spacing = 10;
  const w = Math.ceil(ctx.measureText(text).width + spacing * text.length + 70);
  cv.width = w;
  cv.height = 80;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PAL.red;
  ctx.fillRect(4, 26, 28, 28);
  ctx.fillStyle = PAL.black;
  let x = 50;
  for (const ch of text) {
    ctx.fillText(ch, x, 42);
    x += ctx.measureText(ch).width + spacing;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
  const sprite = new THREE.Sprite(mat);
  const h = 0.3;
  sprite.scale.set((h * w) / cv.height, h, 1);
  sprite.renderOrder = 3;
  return sprite;
}

function disposeLabel(s: THREE.Sprite) {
  s.removeFromParent();
  s.material.map?.dispose();
  s.material.dispose();
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
    sense: p.role.sense,
    slot: (SENSE_SLOT[p.role.sense] / 6) * TAU + ((h % 100) / 100 - 0.5) * 0.5,
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
    named: false,
    nameEnv: 0,
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

/** what a swarm needs to know about the world around him this frame */
interface Ctx {
  /** direction of home, cat-local (0 = ahead, + = left) */
  homeA: number;
  heartBpm: number;
}

function shape(sw: Swarm, i: number, t: number, o: Out, ctx: Ctx) {
  const u1 = sw.seed[i * 3];
  const u2 = sw.seed[i * 3 + 1];
  const u3 = sw.seed[i * 3 + 2];
  const ch = sw.ch;
  o.ox = 0;
  o.oz = 0;
  o.f = -1;
  o.stiff = 10;
  o.shape = SHAPE_DOT;
  switch (sw.sense) {
    case 'sight': {
      // eyes: dark shrinks the rings to a dim huddle, glare blows them wide and faint
      const v = ch.v ?? 0.5;
      const glare = Math.max(0, (v - 0.65) / 0.35);
      o.a = sw.slot + (u1 - 0.5) * 1.8 + t * 0.12;
      o.r = 0.6 + 0.6 * v + u2 * (0.6 + 2.2 * glare);
      o.y = 0.3 + v * 1.1 + 0.2 * wob(t * 0.5, u3);
      o.size = 0.05 + 0.1 * v + 0.12 * glare;
      o.alpha = (0.1 + 0.8 * Math.min(1, v * 1.6)) * (1 - 0.6 * glare);
      o.shape = SHAPE_RING;
      o.color = C.charcoal;
      o.stiff = 6;
      break;
    }
    case 'speed': {
      // sparks around the paws, spinning and thrown forward by the scratching
      const d = ch.drive ?? 0;
      o.a = u1 * TAU + t * (0.3 + 3 * d);
      o.r = 0.45 + u2 * 0.5 + d * 0.4;
      o.y = 0.08 + u3 * 0.2 + d * 0.4 * Math.abs(Math.sin(t * 11 + u1 * 20));
      const j = 0.03 + 0.15 * d;
      o.ox = j * Math.sin(t * 23 + u2 * 40);
      o.oz = j * Math.sin(t * 19 + u3 * 40) + d * 0.8;
      o.size = 0.035 + 0.035 * d;
      o.alpha = 0.2 + 0.7 * d;
      o.color = C.black;
      o.stiff = 22;
      break;
    }
    case 'direction': {
      // a stream of thoughts pouring toward the side he turns to
      const x = ch.x ?? 0;
      const ax = Math.min(1, Math.abs(x));
      const f = frac(t * (0.25 + 0.45 * ax) + u1);
      o.f = f;
      o.a = -x * 1.45 + (u2 - 0.5) * (1.5 - ax * 1.1);
      o.r = 0.9 + f * (0.5 + 2.0 * ax);
      o.y = 0.5 + 0.35 * Math.sin(f * Math.PI) + (u3 - 0.5) * 0.3;
      o.size = 0.055;
      o.alpha = (0.2 + 0.7 * ax) * Math.sin(f * Math.PI);
      o.color = C.black;
      o.stiff = 14;
      break;
    }
    case 'memory': {
      // remembering: a tidy ring of dust under him; forgetting: it floats up and apart
      const L = Math.min(1, (ch.level ?? 0) / 0.42);
      const loose = 1 - L;
      o.a = (i / PER) * TAU + t * (0.25 + 0.2 * L) + loose * (u1 - 0.5) * 3;
      o.r = 0.75 + loose * (0.4 + 2.2 * u2);
      o.y = 0.05 + loose * (0.4 + 1.8 * u3 + 0.3 * wob(t * 0.4, u1));
      o.size = 0.045 + 0.02 * loose;
      o.alpha = 0.3 + 0.5 * L;
      o.color = C.gray;
      o.stiff = 3 + 6 * L;
      break;
    }
    case 'instinct': {
      // red sparks streaming toward home (as the crow flies), shaken loose by the phone
      const d = ch.drive ?? 0;
      const f = frac(t * (0.3 + 0.8 * d) + u1);
      o.f = f;
      o.a = ctx.homeA + (u2 - 0.5) * (1.6 - d * 1.2);
      o.r = 0.5 + f * (0.4 + 2.6 * d);
      o.y = 0.35 + (u3 - 0.5) * 0.4 + 0.25 * Math.sin(f * Math.PI);
      const j = 0.02 + 0.1 * d;
      o.ox = j * Math.sin(t * 37 + u2 * 50);
      o.oz = j * Math.sin(t * 41 + u3 * 50);
      o.size = 0.04 + 0.04 * d;
      o.alpha = (0.1 + 0.85 * d) * Math.sin(f * Math.PI);
      o.color = C.red;
      o.stiff = 16;
      break;
    }
    default: {
      // heartbeat: a red throb at his chest, at the rate it is tapped; off the beat it stutters
      const bpm = ch.bpm ?? 0;
      const pos = heartPosition(bpm, ctx.heartBpm);
      const off = Math.max(0, Math.abs(pos) - 0.3) / 0.7;
      const b = bpm > 0 ? Math.pow(Math.max(0, Math.cos(t * TAU * (bpm / 60))), 10) : 0;
      const th = u1 * TAU;
      const ph = Math.acos(2 * u2 - 1);
      const r = 0.3 + 0.18 * b + off * 0.08 * Math.sin(t * 29 + u3 * 30);
      o.a = 0;
      o.r = 0;
      o.ox = Math.sin(th) * Math.sin(ph) * r;
      o.oz = 0.2 + Math.cos(th) * Math.sin(ph) * r;
      o.y = 0.55 + Math.cos(ph) * r;
      o.size = 0.035 + 0.035 * b;
      o.alpha = 0.15 + 0.7 * (0.4 + 0.6 * b) * (1 - 0.5 * off);
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
  const labels = useRef<THREE.Group>(null!);
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
    const pe = phase === 'journey' ? 1 : phase === 'intro' ? Math.min(1, Math.max(0, ((snap?.phaseT ?? 0) - INTRO.home - INTRO.fly * 0.5) / 4)) : phase === 'lobby' || phase === 'tutorial' ? 0.5 : 0;
    phaseEnv.current += (pe - phaseEnv.current) * (1 - Math.exp(-dt * 0.8));

    // sync swarms with the players in the latest snapshot
    const map = swarms.current;
    for (const sw of map.values()) sw.alive = false;
    for (const p of snap?.players ?? []) {
      let sw = map.get(p.id);
      if (sw && p.role.sense !== sw.sense) {
        if (sw.label) disposeLabel(sw.label);
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
      const named = !!p.named;
      // the wish is fulfilled: the dots burst once as they give way to the name
      if (named && !sw.named) sw.imp = 1;
      sw.named = named;
      if (named && !sw.label) labels.current.add((sw.label = makeLabel(p.nickname)));
    }

    const mdx = lastCat.current.init ? cat.x - lastCat.current.x : 0;
    const mdz = lastCat.current.init ? cat.z - lastCat.current.z : 0;
    const jump = Math.hypot(mdx, mdz) > 6;
    lastCat.current = { x: cat.x, z: cat.z, init: true };
    // thoughts travel with him; only a little of his motion is left to the springs, as a trail
    const carry = 0.85;
    const cosH = Math.cos(cat.heading);
    const sinH = Math.sin(cat.heading);
    const home = store.world?.nodes[store.world.home];
    const ctx: Ctx = { homeA: home ? wrapAngle(Math.atan2(home.x - cat.x, home.z - cat.z) - cat.heading) : 0, heartBpm: snap?.heartBpm ?? 72 };

    let n = 0;
    for (const [id, sw] of map) {
      sw.env += ((sw.alive ? sw.influence : 0) - sw.env) * (1 - Math.exp(-dt * 1.2));
      if (!sw.alive && sw.env < 0.01) {
        if (sw.label) disposeLabel(sw.label);
        map.delete(id);
        continue;
      }
      sw.nameEnv += ((sw.named ? 1 : 0) - sw.nameEnv) * (1 - Math.exp(-dt * 1.5));
      if (sw.label) {
        // the name floats where the dots were, at the swarm's place around him
        const a = sw.slot + 0.15 * Math.sin(t * 0.3 + sw.seed[0] * 10);
        const r = 1.5;
        const lx = Math.sin(a) * r;
        const lz = Math.cos(a) * r;
        sw.label.position.set(cat.x + lx * cosH + lz * sinH, 1.25 + 0.08 * Math.sin(t * 0.8 + sw.seed[1] * 10), cat.z + lz * cosH - lx * sinH);
        sw.label.material.opacity = sw.nameEnv * sw.env * phaseEnv.current;
        sw.label.visible = sw.label.material.opacity > 0.01;
        if (!sw.named && sw.nameEnv < 0.01) {
          disposeLabel(sw.label);
          sw.label = undefined;
        }
      }
      for (const k in sw.target) {
        const cur = sw.ch[k] ?? sw.target[k];
        sw.ch[k] = cur + (sw.target[k] - cur) * (1 - Math.exp(-dt * 6));
      }
      const kick = sw.imp >= 1;
      sw.imp *= Math.exp(-dt * 2.5);
      if (kick) sw.imp = 0.999;

      for (let i = 0; i < PER; i++) {
        shape(sw, i, t, out, ctx);
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
        attr.al.array[n] = Math.min(0.9, Math.max(0, out.alpha) * (1 + sw.imp * 0.8)) * sw.env * phaseEnv.current * (1 - sw.nameEnv);
        attr.sh.array[n] = out.shape;
        n++;
      }
      sw.init = true;
    }
    geo.setDrawRange(0, n);
    for (const a of Object.values(attr)) a.needsUpdate = true;
  });

  return (
    <>
      <points geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />
      <group ref={labels} />
    </>
  );
}
