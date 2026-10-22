// Headless journeys at accelerated time: checks that Dargato reaches home when the
// senses are simulated (or played by bots), that he never leaves the streets, and
// that a saboteur on the heartbeat ends the night.
import { Session, TICK_HZ, type Outbox } from '../server/session';

const nullOut: Outbox = { displays() {}, directors() {}, phone() {}, counts: () => ({ displays: 0, phones: 0, directors: 0, debug: 0 }) };

interface Result {
  seed: string;
  ending: string;
  t: number;
  detours: number;
  streets: number;
  escaped: boolean;
}

function runJourney(seed: string, bots: number, saboteur = false): Result {
  const s = new Session('TEST', { seed, lockSeed: true }, nullOut);
  s.setBots(bots);
  s.start();
  let escaped = false;
  const maxSteps = TICK_HZ * 60 * 20;
  for (let i = 0; i < maxSteps; i++) {
    // a saboteur rushes the heart
    if (saboteur && i % 9 === 0) s.devInput({ sense: 'heartbeat', input: { t: 'tap' } });
    s.step();
    if (!s.cat.walk.inside(s.cat.x, s.cat.z)) escaped = true;
    if (s.phase === 'arrival' || s.phase === 'sleep') break;
  }
  return { seed, ending: s.endCause ?? 'none', t: Math.round(s.journeyT), detours: s.cat.detours, streets: s.cat.visits.size, escaped };
}

const seeds = Number(process.argv[2] ?? 30);
const configs: [number, boolean][] = [[0, false], [6, false], [9, false], [6, true]];
let bad = 0;
for (const [bots, sab] of configs) {
  const results: Result[] = [];
  for (let i = 0; i < seeds; i++) results.push(runJourney(`sim-${i}`, bots, sab));
  const home = results.filter((r) => r.ending === 'home');
  const times = home.map((r) => r.t).sort((a, b) => a - b);
  const count = (e: string) => results.filter((r) => r.ending === e).length;
  const escaped = results.filter((r) => r.escaped).length;
  const inRange = times.filter((t) => t >= 120 && t <= 600).length;
  const avg = (k: keyof Result) => (results.reduce((a, r) => a + (r[k] as number), 0) / results.length).toFixed(1);
  console.log(
    `players=${bots.toString().padStart(2)}${sab ? '+saboteur' : '         '}  home ${home.length}/${results.length}  slow ${count('slow')} fast ${count('fast')} time ${count('time')} stuck ${count('none')}  escaped ${escaped}` +
      `  time min/med/max ${times[0] ?? '-'}/${times[times.length >> 1] ?? '-'}/${times[times.length - 1] ?? '-'}s  in 2-10min ${inRange}/${home.length}  avg detours ${avg('detours')} streets ${avg('streets')}`,
  );
  if (count('none') || escaped) bad++;
  if (!sab && home.length < results.length * 0.85) bad++;
  if (sab && count('fast') < results.length * 0.9) bad++;
}
if (bad) {
  console.log('FAIL');
  process.exit(1);
}
console.log('OK');
