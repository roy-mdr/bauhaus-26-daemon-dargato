// Session lifecycle: night-ending fallbacks, the heartbeat, the senses' effects, director commands, role assignment.
import assert from 'node:assert/strict';
import { Session, TICK_HZ, type Outbox } from '../server/session';
import { INTRO_SEC, clearBand, senseCurves } from '../shared/config';
import type { SenseId } from '../shared/types';

const out: Outbox = { displays() {}, directors() {}, phone() {}, counts: () => ({ displays: 0, phones: 0, directors: 0, debug: 0 }) };
const run = (s: Session, sec: number, until?: () => boolean, each?: (i: number) => void) => {
  for (let i = 0; i < sec * TICK_HZ; i++) {
    each?.(i);
    s.step();
    if (until?.()) return;
  }
};
const roles = (s: Session) => [...s.players.values()].map((p) => p.role.sense);
const ended = (s: Session) => () => s.phase === 'sleep' || s.phase === 'arrival';

// the night ends when time runs out, then summary, then a new world in the lobby
const a = new Session('A', { seed: 'x', maxDurationSec: 60, finalGraceSec: 10, summarySec: 5 }, out);
a.start();
// hold Dargato still so he cannot reach home
run(a, 120, ended(a), () => a.devInput({ sense: 'speed', hold: 0 }));
assert.equal(a.phase, 'sleep');
assert.equal(a.endCause, 'time');
assert.ok(Math.abs(a.journeyT - 70) < 1, `journeyT ${a.journeyT}`);
run(a, 30, () => a.phase === 'lobby');
assert.equal(a.phase, 'lobby');
assert.notEqual(a.seed, 'x');

// HEARTBEAT: nobody tapping ends the night (heart too slow), tapping too fast ends it too
const slow = new Session('S', { seed: 'y', heartFailSec: 6 }, out);
slow.start();
run(slow, 60, ended(slow), () => slow.devInput({ sense: 'heartbeat', hold: 0 }));
assert.equal(slow.endCause, 'slow');
assert.ok(slow.journeyT < 20, `slow ended at ${slow.journeyT}`);

const fast = new Session('F', { seed: 'y', heartFailSec: 6 }, out);
fast.start();
run(fast, 60, ended(fast), (i) => i % 8 === 0 && fast.devInput({ sense: 'heartbeat', input: { t: 'tap' } }));
assert.equal(fast.endCause, 'fast');

// tapping on the beat keeps it alive (the simulated heartbeat does that by itself)
const steady = new Session('H', { seed: 'y', heartFailSec: 6 }, out);
steady.start();
run(steady, 40, ended(steady), () => steady.devInput({ sense: 'speed', hold: 0 }));
assert.equal(steady.phase, 'journey');
assert.ok(steady.cat.I.strain < 0.5, `strain ${steady.cat.I.strain}`);

// MEMORY: silence scatters the paths and he cannot walk, even with his paws moving
const m = new Session('M', { seed: 'z' }, out);
m.start();
run(m, INTRO_SEC + 1);
run(m, 6, undefined, () => {
  m.devInput({ sense: 'memory', hold: 0 });
  m.devInput({ sense: 'speed', hold: 1 });
});
assert.ok(m.cat.I.cohesion < 0.2, `cohesion ${m.cat.I.cohesion}`);
const mx = m.cat.x;
const mz = m.cat.z;
run(m, 2, undefined, () => {
  m.devInput({ sense: 'memory', hold: 0 });
  m.devInput({ sense: 'speed', hold: 1 });
});
assert.ok(Math.hypot(m.cat.x - mx, m.cat.z - mz) < 0.3, 'no path, no walking');
assert.equal(m.cat.state, 'hesitating');
// sound brings the paths back and he walks
run(m, 4, undefined, () => {
  m.devInput({ sense: 'memory', hold: 0.8 });
  m.devInput({ sense: 'speed', hold: 1 });
});
assert.ok(m.cat.I.cohesion > 0.7, `cohesion ${m.cat.I.cohesion}`);
assert.ok(m.cat.speed > 1, `speed ${m.cat.speed}`);

// DIRECTION turns him even while he stands; he never leaves the streets
const h0 = m.cat.heading;
run(m, 1, undefined, () => {
  m.devInput({ sense: 'speed', hold: 0 });
  m.devInput({ sense: 'direction', hold: 1 });
});
assert.ok(Math.abs(m.cat.heading - h0) > 0.5, 'turns right');
run(m, 20, undefined, (i) => {
  m.devInput({ sense: 'speed', hold: 1 });
  m.devInput({ sense: 'memory', hold: 0.8 });
  m.devInput({ sense: 'direction', hold: Math.sin(i / 40) });
  assert.ok(m.cat.walk.inside(m.cat.x, m.cat.z), 'inside the streets');
});

// SIGHT: too dark and too bright both hurt, the middle is clear; INSTINCT lights the way home
run(m, 3, undefined, () => m.devInput({ sense: 'sight', hold: 0 }));
assert.ok(m.cat.I.light < 0.2);
run(m, 3, undefined, () => m.devInput({ sense: 'sight', hold: 1 }));
assert.ok(m.cat.I.glare > 0.8);
const [lo, hi] = clearBand(m.near);
run(m, 3, undefined, () => m.devInput({ sense: 'sight', hold: (lo + hi) / 2 }));
assert.ok(m.cat.I.light > 0.9 && m.cat.I.glare < 0.05);
// far from home a little light already blinds him and a whisper holds the paths; at home he needs more of both
const far = senseCurves(0);
const home = senseCurves(1);
assert.ok(clearBand(0)[1] < clearBand(1)[0], 'the clear band climbs toward home');
assert.ok(far.sound[1] < home.sound[0] + 0.1 && far.sound[1] < home.sound[1], 'more sound is needed near home');
run(m, 2, undefined, () => m.devInput({ sense: 'instinct', hold: 1 }));
assert.ok(m.cat.I.instinct > 0.8);
assert.ok(m.snapshot().planned.length > 0);

// the host's start opens the tutorial first; starting again (or waiting) begins the journey
const tut = new Session('T', { seed: 'z', tutorialSec: 5 }, out);
tut.advance();
assert.equal(tut.phase, 'tutorial');
run(tut, 2);
assert.equal(tut.phase, 'tutorial');
tut.advance();
assert.equal(tut.phase, 'intro');
const tut2 = new Session('T2', { seed: 'z', tutorialSec: 5 }, out);
tut2.advance();
run(tut2, 6);
assert.notEqual(tut2.phase, 'tutorial');
const noTut = new Session('T3', { seed: 'z', tutorial: false }, out);
noTut.advance();
assert.equal(noTut.phase, 'intro');

// director commands
const c = new Session('C', { seed: 'z' }, out);
c.command({ c: 'setSeed', seed: 'weimar' });
assert.equal(c.world.seed, 'weimar');
c.command({ c: 'start' });
run(c, INTRO_SEC + 1);
assert.equal(c.phase, 'journey');
c.command({ c: 'pause' });
const x0 = c.cat.x;
const z0 = c.cat.z;
run(c, 3);
assert.ok(c.cat.x === x0 && c.cat.z === z0, 'paused cat must not move');
c.command({ c: 'resume' });
c.command({ c: 'ending', kind: 'home' });
assert.equal(c.phase, 'arrival');
c.command({ c: 'reset' });
assert.equal(c.phase, 'lobby');
assert.equal(c.world.seed, 'weimar');
c.command({ c: 'config', patch: { catSpeed: 3.3, sensitivity: { sight: 2 } as never } });
assert.equal(c.config.catSpeed, 3.3);
assert.equal(c.config.sensitivity.sight, 2);
assert.equal(c.config.sensitivity.direction, 1);

// role assignment: the six senses, then repeats of the least-held sense (averaged)
c.setBots(9);
const r = roles(c);
assert.deepEqual(r.slice(0, 6), ['direction', 'speed', 'memory', 'heartbeat', 'sight', 'instinct'] as SenseId[]);
assert.deepEqual(r.slice(6), ['direction', 'speed', 'memory'] as SenseId[]);

// two players on the same sense are averaged
const avg = new Session('V', { seed: 'v' }, out);
avg.setBots(8);
const turners = [...avg.players.values()].filter((p) => p.role.sense === 'direction');
assert.equal(turners.length, 2);
avg.bots.clear();
turners[0].sense.value = 1;
turners[1].sense.value = -0.2;
turners.forEach((p) => (p.sense.valueAt = avg.now + 1e6));
avg.step();
assert.ok(Math.abs(avg.senses.turn - 0.4) < 0.01, `turn ${avg.senses.turn}`);

// only the first of a sense to fulfil their wish is named on the main display
const named = () => new Map(avg.publicPlayers().map((p) => [p.id, !!p.named]));
assert.ok(![...named().values()].some(Boolean), 'nobody named before a wish is fulfilled');
turners[1].objective = { ...turners[1].objective, done: true, doneAt: 500 };
turners[0].objective = { ...turners[0].objective, done: true, doneAt: 900 };
assert.equal(named().get(turners[1].id), true);
assert.equal(named().get(turners[0].id), false);
const other = [...avg.players.values()].find((p) => p.role.sense === 'speed')!;
other.objective = { ...other.objective, done: true, doneAt: 1200 };
assert.equal(named().get(other.id), true, 'each sense has its own first');

console.log('lifecycle OK');
