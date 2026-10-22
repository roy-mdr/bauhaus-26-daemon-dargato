// Streets as particle paths: the navigation graph drawn as slow drifting dust
// instead of pavement. Edges flow, junctions swirl, wider streets get dotted edges.
// All motion happens in the vertex shader; the buffers are built once per world.
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { sampleEdge } from '../../shared/graph';
import { Rng } from '../../shared/rng';
import type { EdgeKind, World } from '../../shared/types';
import { PAL } from './palette';

const MODE_FLOW = 0;
const MODE_ORBIT = 1;
const MODE_TWINKLE = 2;

/** particles per square metre, and how dark they are (0 = pale, 1 = near-black) */
const KIND: Record<EdgeKind, { dens: number; shade: number; size: number }> = {
  main: { dens: 1.05, shade: 0.5, size: 0.11 },
  street: { dens: 1.2, shade: 0.6, size: 0.1 },
  alley: { dens: 1.7, shade: 0.8, size: 0.085 },
  path: { dens: 1.3, shade: 0.7, size: 0.075 },
};

function buildParticles(world: World): THREE.BufferGeometry {
  const rng = new Rng('paths:' + world.seed);
  const pos: number[] = [];
  const dir: number[] = [];
  const misc: number[] = [];
  const shade: number[] = [];
  const push = (x: number, y: number, z: number, dx: number, dy: number, dz: number, phase: number, speed: number, mode: number, size: number, sh: number) => {
    pos.push(x, y, z);
    dir.push(dx, dy, dz);
    misc.push(phase, speed, mode, size);
    shade.push(sh);
  };

  for (const e of world.edges) {
    const k = KIND[e.kind];
    const hw = e.width / 2;
    // the body of the street: dust flowing along it, thicker near the middle
    const n = Math.ceil(e.length * e.width * k.dens);
    for (let i = 0; i < n; i++) {
      const p = sampleEdge(e, e.a, rng.range(0, e.length));
      const tx = Math.sin(p.heading);
      const tz = Math.cos(p.heading);
      const u = (rng.next() + rng.next() - 1) * hw;
      const speed = rng.range(0.25, 0.7) * (rng.chance(0.5) ? 1 : -1);
      push(p.x + tz * u, rng.range(0.03, 0.12), p.z - tx * u, tx, 0, tz, rng.next(), speed, MODE_FLOW, k.size * rng.range(0.6, 1.3), k.shade + rng.range(-0.15, 0.15));
    }
    // dotted edges on the wider streets
    if (e.kind === 'main' || e.kind === 'street') {
      for (let s = 0; s < e.length; s += 0.7) {
        const p = sampleEdge(e, e.a, s);
        for (const side of [1, -1]) {
          const ox = Math.cos(p.heading) * hw * side;
          const oz = -Math.sin(p.heading) * hw * side;
          push(p.x + ox, 0.04, p.z + oz, 0, 0, 0, rng.next(), rng.range(0.4, 1.2), MODE_TWINKLE, 0.05, 0.35);
        }
      }
    }
  }

  // junctions and squares: a slow swirl
  for (const nd of world.nodes) {
    if (nd.id === world.home) continue;
    const maxW = Math.max(...nd.edges.map((eid) => world.edges[eid].width));
    const r = nd.kind === 'plaza' ? nd.r : Math.max(nd.r, maxW / 2 + 0.3);
    const n = Math.ceil(Math.PI * r * r * 0.8);
    const w = rng.range(0.05, 0.14) * (rng.chance(0.5) ? 1 : -1);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(rng.next()) * r;
      push(nd.x + Math.sin(a) * rr, rng.range(0.03, 0.1), nd.z + Math.cos(a) * rr, nd.x, 0, nd.z, rng.next(), w * rng.range(0.7, 1.3), MODE_ORBIT, rng.range(0.06, 0.11), 0.5 + rng.range(-0.15, 0.15));
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3));
  g.setAttribute('aMisc', new THREE.Float32BufferAttribute(misc, 4));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  return g;
}

const vertexShader = /* glsl */ `
  attribute vec3 aDir;
  attribute vec4 aMisc; // phase, speed, mode, size
  attribute float aShade;
  uniform float uTime;
  uniform float uScale;
  varying float vAlpha;
  varying float vShade;
  varying float vDepth;
  const float TRAVEL = 2.2;
  void main() {
    float phase = aMisc.x;
    float speed = aMisc.y;
    float mode = aMisc.z;
    vec3 p = position;
    float alpha = 1.0;
    if (mode < 0.5) {
      // flow: a short drift along the street, fading in and out
      float f = fract(phase + uTime * abs(speed) / TRAVEL);
      p += aDir * (f - 0.5) * TRAVEL * sign(speed);
      alpha = sin(f * 3.14159);
    } else if (mode < 1.5) {
      // orbit around the junction centre (stored in aDir)
      vec2 rel = p.xz - aDir.xz;
      float a = uTime * speed;
      float c = cos(a), s = sin(a);
      p.xz = aDir.xz + vec2(rel.x * c - rel.y * s, rel.x * s + rel.y * c);
      alpha = 0.65 + 0.35 * sin(uTime * 0.7 + phase * 6.2832);
    } else {
      alpha = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * speed + phase * 6.2832));
    }
    p.y += 0.03 * sin(uTime * 0.9 + phase * 40.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aMisc.w * uScale / max(0.1, -mv.z));
    vAlpha = alpha;
    vShade = aShade;
    vDepth = -mv.z;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uPale;
  uniform vec3 uDark;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying float vAlpha;
  varying float vShade;
  varying float vDepth;
  void main() {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float a = smoothstep(1.0, 0.4, d) * vAlpha * 0.85;
    if (a < 0.01) discard;
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    vec3 col = mix(uPale, uDark, clamp(vShade, 0.0, 1.0));
    gl_FragColor = vec4(mix(col, uFogColor, fog), a * (1.0 - fog * 0.6));
  }
`;

export function StreetParticles({ world }: { world: World }) {
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const geo = useMemo(() => buildParticles(world), [world]);
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
          uPale: { value: new THREE.Color('#9a9893') },
          uDark: { value: new THREE.Color(PAL.black) },
          uFogColor: { value: new THREE.Color(PAL.fog) },
          uFogDensity: { value: 0.02 },
        },
      }),
    [],
  );
  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      mat.uniforms.uFogColor.value.copy(fog.color);
      mat.uniforms.uFogDensity.value = fog.density;
    }
  });
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={1} />;
}
