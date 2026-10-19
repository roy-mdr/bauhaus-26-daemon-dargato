// Headless journeys at accelerated time: checks that Dargato reaches home in a
// normal session, never gets permanently stuck, and that the night-ending fallback works.
import { Session, TICK_HZ, type Outbox } from '../server/session';

const nullOut: Outbox = { displays() {}, directors() {}, phone() {}, counts: () => ({ displays: 0, phones: 0, directors: 0, debug: 0 }) };

interface Result {
  seed: string;
  bots: number;
  ending: string;
  t: number;
  detours: number;
  decisions: number;
  hints: number;
  memories: number;
}

function runJourney(seed: string, bots: number, adversarial = false): Result {
  // the saboteur also holds REST forever and taps RESTRAINT nonstop (both must stay bounded)
  const s = new Session('TEST', { seed, lockSeed: true }, nullOut);
  s.setBots(bots);
  s.start();
  const maxSteps = TICK_HZ * 60 * 20;
  for (let i = 0; i < maxSteps; i++) {
    if (adversarial && s.cat.mode === 'node' && s.cat.options.length) {
      // a saboteur: always tilt toward the street that leads furthest from home
      const w = s.world;
      const worst = s.cat.options.reduce((a, b) => (w.distHome[b.toNode] > w.distHome[a.toNode] ? b : a));
      s.devInput({ sense: 'direction', hold: Math.max(-1, Math.min(1, -worst.turn / (Math.PI / 2))) });
    }
    if (adversarial && i % 15 === 0) {
      for (const p of s.players.values()) {
        if (p.role.sense === 'emotion' && p.role.variant) p.sense.hold = true;
        if (p.role.sense === 'instinct' && p.role.variant) p.sense.tapTimes.push(s.now);
      }
    }
    s.step();
    if (s.phase === 'arrival' || s.phase === 'sleep') break;
  }
  return {
    seed,
    bots,
    ending: s.ending ?? 'none',
    t: Math.round(s.journeyT),
    detours: s.cat.detours,
    decisions: s.cat.decisions,
    hints: s.hintsSeen,
    memories: s.memories,
  };
}

const seeds = Number(process.argv[2] ?? 30);
const configs: [number, boolean][] = [[0, false], [6, false], [10, false], [13, true]];
let bad = 0;
for (const [bots, adv] of configs) {
  const results: Result[] = [];
  for (let i = 0; i < seeds; i++) results.push(runJourney(`sim-${i}`, bots, adv));
  const home = results.filter((r) => r.ending === 'home');
  const times = home.map((r) => r.t).sort((a, b) => a - b);
  const none = results.filter((r) => r.ending === 'none');
  const inRange = times.filter((t) => t >= 150 && t <= 600).length;
  const avg = (k: keyof Result) => (results.reduce((a, r) => a + (r[k] as number), 0) / results.length).toFixed(1);
  console.log(
    `players=${bots.toString().padStart(2)}${adv ? '+saboteur' : '         '}  home ${home.length}/${results.length}  sleep ${results.filter((r) => r.ending === 'sleep').length}  stuck ${none.length}` +
      `  time min/med/max ${times[0]}/${times[times.length >> 1]}/${times[times.length - 1]}s  in 2.5-10min ${inRange}/${home.length}` +
      `  avg detours ${avg('detours')} decisions ${avg('decisions')} hints ${avg('hints')} memories ${avg('memories')}`,
  );
  if (none.length) bad++;
  if (!adv && home.length < results.length * 0.85) bad++;
}
if (bad) {
  console.log('FAIL');
  process.exit(1);
}
console.log('OK');
