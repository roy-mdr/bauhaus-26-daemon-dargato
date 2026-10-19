// Session lifecycle: night-ending fallback, heartbeat extension, director commands, role assignment.
import assert from 'node:assert/strict';
import { Session, TICK_HZ, type Outbox } from '../server/session';

const out: Outbox = { displays() {}, directors() {}, phone() {}, counts: () => ({ displays: 0, phones: 0, directors: 0, debug: 0 }) };
const run = (s: Session, sec: number, until?: () => boolean) => {
  for (let i = 0; i < sec * TICK_HZ; i++) {
    s.step();
    if (until?.()) return;
  }
};
const roles = (s: Session) => [...s.players.values()].map((p) => (p.role.variant ? p.role.sense + '-b' : p.role.sense));

// the night ends when time runs out, then summary, then a new world in the lobby
const a = new Session('A', { seed: 'x', maxDurationSec: 60, finalGraceSec: 10, maxHeartbeatExtensionSec: 0, summarySec: 5 }, out);
a.start();
run(a, 120, () => a.phase === 'sleep' || a.phase === 'arrival');
assert.equal(a.phase, 'sleep');
assert.ok(Math.abs(a.journeyT - 70) < 1);
run(a, 30, () => a.phase === 'lobby');
assert.equal(a.phase, 'lobby');
assert.notEqual(a.seed, 'x');

// HEARTBEAT extends the night, bounded by its maximum
const b = new Session('B', { seed: 'y', maxDurationSec: 60, finalGraceSec: 10, maxHeartbeatExtensionSec: 40 }, out);
b.start();
for (let i = 0; i < 200 * TICK_HZ; i++) {
  if (i % 26 === 0) b.devInput({ sense: 'heartbeat', input: { t: 'tap' } });
  b.step();
  if (b.phase === 'sleep' || b.phase === 'arrival') break;
}
assert.ok(b.extension > 39 && b.extension <= 40, `extension ${b.extension}`);

// director commands
const c = new Session('C', { seed: 'z' }, out);
c.command({ c: 'setSeed', seed: 'weimar' });
assert.equal(c.world.seed, 'weimar');
c.command({ c: 'start' });
run(c, 10);
assert.equal(c.phase, 'journey');
c.command({ c: 'pause' });
const x0 = c.cat.x;
const z0 = c.cat.z;
run(c, 3);
assert.ok(c.cat.x === x0 && c.cat.z === z0, 'paused cat must not move');
c.command({ c: 'resume' });
c.command({ c: 'hint' });
c.command({ c: 'memory' });
assert.ok(c.hints.hints.some((h) => h.source === 'director'));
assert.ok(c.hints.hints.some((h) => h.source === 'memory'));
c.command({ c: 'ending', kind: 'home' });
assert.equal(c.phase, 'arrival');
c.command({ c: 'reset' });
assert.equal(c.phase, 'lobby');
assert.equal(c.world.seed, 'weimar');
c.command({ c: 'config', patch: { catSpeed: 3.3, sensitivity: { vision: 2 } as never } });
assert.equal(c.config.catSpeed, 3.3);
assert.equal(c.config.sensitivity.vision, 2);
assert.equal(c.config.sensitivity.direction, 1);

// role assignment: 6 core senses, HEARTBEAT, then variants (or averaged repeats)
c.setBots(10);
assert.deepEqual(roles(c), ['vision', 'direction', 'instinct', 'emotion', 'hearing', 'memory', 'heartbeat', 'vision-b', 'direction-b', 'emotion-b']);
c.config.extraPlayerMode = 'average';
c.setBots(0);
c.setBots(10);
assert.deepEqual(roles(c).slice(7), ['vision', 'direction', 'instinct']);

console.log('lifecycle OK');
