// Validates the procedural generator across many seeds:
// connectivity, reachability of home, determinism, required features, duration estimate.
import { generateWorld, validateWorld } from '../shared/worldgen';
import { graphFingerprint } from '../shared/graph';

const N = Number(process.argv[2] ?? 200);
let failures = 0;
const durations: number[] = [];
const agg = { loops: 0, deadEnds: 0, alleys: 0, paths: 0, curved: 0, plazas: 0, tJunctions: 0, crossroads: 0, attempts: 0 };
const t0 = performance.now();

for (let i = 0; i < N; i++) {
  const seed = `seed-${i}`;
  const w = generateWorld(seed);
  const w2 = generateWorld(seed);
  const problems: string[] = [];
  const v = validateWorld(w);
  if (v) problems.push(v);
  if (graphFingerprint(w) !== graphFingerprint(w2)) problems.push('non-deterministic graph');
  if (w.home === w2.home && w.start !== w2.start) problems.push('non-deterministic start');
  const s = w.stats;
  if (s.loops < 3) problems.push(`loops=${s.loops}`);
  if (s.deadEnds < 1) problems.push('no dead ends');
  if (s.alleys < 1) problems.push('no alleys');
  if (s.tJunctions < 1) problems.push('no T-junctions');
  if (s.crossroads < 1) problems.push('no crossroads');
  if (s.curved < 1) problems.push('no curved paths');
  if (s.estDurationSec < 150 || s.estDurationSec > 480) problems.push(`est duration ${s.estDurationSec}s out of range`);
  if (problems.length) {
    failures++;
    console.log(`FAIL ${seed}: ${problems.join(', ')}`);
  }
  durations.push(s.estDurationSec);
  for (const k of Object.keys(agg) as (keyof typeof agg)[]) agg[k] += k === 'attempts' ? w.attempts : (s as any)[k];
}

const ms = (performance.now() - t0) / (N * 2);
durations.sort((a, b) => a - b);
console.log(`\n${N} seeds, ${failures} failures, ${ms.toFixed(1)} ms/world`);
console.log(
  'avg per world:',
  Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, +(v / N).toFixed(2)])),
);
console.log(`estimated duration (s): min ${durations[0]}, median ${durations[N >> 1]}, max ${durations[N - 1]}`);
const sample = generateWorld('dargato');
console.log('seed "dargato":', graphFingerprint(sample), sample.stats);
if (failures) process.exit(1);
