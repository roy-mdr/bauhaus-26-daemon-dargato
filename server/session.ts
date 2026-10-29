// One installation session: lobby -> intro -> journey -> arrival/sleep -> summary -> lobby.
// Owns the authoritative simulation (cat, players, objectives).
import { DEFAULT_CONFIG, clearBand, heartPosition, heartZone, senseCurves, type SessionConfig } from '../shared/config';
import { clamp } from '../shared/graph';
import type { DevInput, DirectorCommand, DirectorState, EndCause, JourneySummary, PhoneInput, PhoneState, PlayerPublic, SensorStatus, Snapshot } from '../shared/protocol';
import { SENSE_ORDER, roleInfo } from '../shared/roles';
import { Rng } from '../shared/rng';
import type { CatInternals, Landmark, Phase, RoleRef, SenseId, World, WorldEvent, WorldEventKind } from '../shared/types';
import { generateWorld } from '../shared/worldgen';
import { CatSim } from './cat';
import { DISCOVERY_TEXT, Narrative } from './narrative';
import { Objectives } from './objectives';
import { SimBrain, applyInput, createPlayer, newSenseState, playerChannels, playerLevel, tickPlayer, type Player, type SimContext } from './players';

export interface Outbox {
  displays(ev: string, data: unknown): void;
  directors(ev: string, data: unknown): void;
  phone(socketId: string, ev: string, data: unknown): void;
  counts(): { displays: number; phones: number; directors: number; debug: number };
}

export const TICK_HZ = 30;

function roundChannels(p: Player): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(playerChannels(p))) out[k] = Math.round(v * 100) / 100;
  return out;
}
const DT = 1 / TICK_HZ;

interface Sim {
  player: Player;
  brain: SimBrain;
  overrideUntil: number;
  /** a key held on the main display (null = none) */
  held: number | null;
}

/** the averaged senses, before smoothing */
interface Senses {
  sight: number;
  paws: number;
  turn: number;
  memory: number;
  instinct: number;
  heartRate: number;
  /** false: nobody (not even a simulation) keeps the heart, so it cannot fail */
  heartKept: boolean;
}

const NEUTRAL_SENSES: Senses = { sight: 0.5, paws: 0, turn: 0, memory: 1, instinct: 0, heartRate: 0, heartKept: false };

const ENDING_TEXT: Record<EndCause, string> = {
  home: 'Dargato is home.',
  slow: 'His heart grew too quiet. He curls up in the street until morning.',
  fast: 'His heart raced too hard. He hides in a doorway until morning.',
  time: 'Not tonight. The street will keep his place.',
};

const SEED_WORDS = ['fog', 'night', 'alley', 'lamp', 'stone', 'echo', 'paw', 'whisker', 'ember', 'dusk', 'roof', 'gutter'];

/** a held dev key, repeated every tick as the gesture its sense understands */
function heldInput(sense: SenseId, v: number): PhoneInput | null {
  if (sense === 'speed') return { t: 'scratch', v };
  if (sense === 'instinct') return { t: 'shake', v };
  if (sense === 'heartbeat') return null;
  return { t: 'value', v };
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export class Session {
  config: SessionConfig;
  seed: string;
  world!: World;
  cat!: CatSim;
  narrative!: Narrative;
  players = new Map<string, Player>();
  sims = new Map<SenseId, Sim>();
  bots = new Map<string, SimBrain>();
  objectives: Objectives;
  phase: Phase = 'lobby';
  phaseT = 0;
  journeyT = 0;
  /** how close he is to home, 0 at the start .. 1 at home (eased); SIGHT and MEMORY ask for more as it rises */
  near = 0;
  paused = false;
  events: WorldEvent[] = [];
  summary: JourneySummary | null = null;
  ending: null | 'home' | 'sleep' = null;
  endCause: EndCause | null = null;
  senses: Senses = { ...NEUTRAL_SENSES };
  aggregated: Record<string, number> = {};
  journeyCount = 0;
  autoStartAt = 0;
  tickMs = 0;
  createdAt = Date.now();
  /** simulated clock (ms); advances with ticks so headless tests can run faster than real time */
  now = Date.now();
  private rng: Rng;
  private eventId = 1;
  private tickCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastWall = 0;
  private acc = 0;
  private plannedCache: number[] | null = null;

  constructor(
    public code: string,
    config: Partial<SessionConfig>,
    private out: Outbox,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config, sensitivity: { ...DEFAULT_CONFIG.sensitivity, ...(config.sensitivity ?? {}) } };
    this.seed = this.config.seed;
    this.rng = new Rng('session:' + code + ':' + Date.now());
    this.objectives = new Objectives(() => [...this.players.values()]);
    for (const sense of SENSE_ORDER) {
      const p = createPlayer(`sim-${sense}`, 'sim', { sense });
      this.sims.set(sense, { player: p, brain: new SimBrain(p, () => this.rng.next(), this.config.simIntensity), overrideUntil: 0, held: null });
    }
    this.generate(this.seed);
  }

  // ---------------- lifecycle ----------------

  run() {
    this.lastWall = performance.now();
    this.timer = setInterval(() => {
      const t = performance.now();
      this.acc += Math.min(0.25, (t - this.lastWall) / 1000);
      this.lastWall = t;
      let steps = 0;
      while (this.acc >= DT && steps < 5) {
        this.acc -= DT;
        this.step();
        steps++;
      }
      this.tickMs = this.tickMs * 0.95 + (performance.now() - t) * 0.05;
    }, 1000 / TICK_HZ);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  generate(seed: string) {
    this.seed = seed;
    this.world = generateWorld(seed);
    this.cat = new CatSim(this.world, this.catHooks(), `${seed}:${this.journeyCount}`);
    this.cat.cfgSpeed = this.config.catSpeed;
    this.near = 0;
    this.narrative = new Narrative(this.world, new Rng('story:' + seed + ':' + this.journeyCount));
    this.events = [];
    this.plannedCache = null;
    this.out.displays('world', this.world);
    this.out.directors('world', this.world);
  }

  private randomSeed(): string {
    return `${this.rng.pick(SEED_WORDS)}-${this.rng.int(100, 999)}`;
  }

  start() {
    if (this.phase !== 'lobby') return;
    this.setPhase('intro');
    this.journeyT = 0;
    this.ending = null;
    this.endCause = null;
    this.summary = null;
    this.autoStartAt = 0;
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  toLobby(keepSeed = false) {
    this.journeyCount++;
    const seed = keepSeed || this.config.lockSeed ? this.seed : this.randomSeed();
    this.setPhase('lobby');
    this.paused = false;
    this.ending = null;
    this.endCause = null;
    this.summary = null;
    this.journeyT = 0;
    if (this.config.reshuffleRoles && !keepSeed) this.reshuffleRoles();
    for (const p of this.players.values()) {
      p.stats = { inputs: 0, pulses: p.stats.pulses };
      this.objectives.assign(p, this.rng);
    }
    this.generate(seed);
  }

  private endJourney(cause: EndCause) {
    if (this.phase !== 'journey' && this.phase !== 'intro') return;
    const kind = cause === 'home' ? 'home' : 'sleep';
    this.ending = kind;
    this.endCause = cause;
    this.cat.speed = 0;
    if (kind === 'home') {
      const home = this.world.nodes[this.world.home];
      this.cat.x = home.x;
      this.cat.z = home.z;
    }
    this.cat.state = kind === 'home' ? 'arriving' : 'sleeping';
    const real = [...this.players.values()].filter((p) => p.kind !== 'sim');
    this.summary = {
      ending: kind,
      cause,
      durationSec: Math.round(this.journeyT),
      distance: Math.round(this.cat.distance),
      streets: this.cat.visits.size,
      detours: this.cat.detours,
      discoveries: this.cat.discovered.size,
      landmarks: this.cat.seenLandmarks.size,
      players: real.map((p) => this.objectives.summary(p)),
    };
    this.setPhase(kind === 'home' ? 'arrival' : 'sleep');
    // the ending line itself is shown large on the display, so the event carries no whisper
    this.emit(kind === 'home' ? 'home-chorus' : 'distant-red-light', this.cat.x, this.cat.z, 8, 1);
  }

  // ---------------- players ----------------

  private holders(exclude?: Player): Player[] {
    const graceMs = this.config.reconnectGraceSec * 1000;
    return [...this.players.values()].filter((p) => p !== exclude && p.kind !== 'sim' && (p.connected || this.now - p.disconnectedAt < graceMs));
  }

  /** the next free sense; beyond six players the least-held sense (inputs of a sense are averaged) */
  private nextRole(held: Player[]): RoleRef {
    let best: SenseId = SENSE_ORDER[0];
    let bestN = Infinity;
    for (const s of SENSE_ORDER) {
      const n = held.filter((p) => p.role.sense === s).length;
      if (n < bestN) {
        bestN = n;
        best = s;
      }
    }
    return { sense: best };
  }

  private reshuffleRoles() {
    const list = this.rng.shuffle(this.holders());
    const assigned: Player[] = [];
    for (const p of list) {
      p.role = this.nextRole(assigned);
      p.sense = newSenseState(p.role.sense);
      assigned.push(p);
    }
  }

  join(nickname: string, token: string | undefined, socketId: string): Player {
    if (token) {
      const existing = [...this.players.values()].find((p) => p.token === token);
      if (existing) {
        existing.socketId = socketId;
        existing.connected = true;
        if (nickname) existing.nickname = existing.nickname || nickname;
        return existing;
      }
    }
    const role = this.nextRole(this.holders());
    const p = createPlayer(nickname, 'phone', role);
    p.socketId = socketId;
    p.connected = true;
    this.objectives.assign(p, this.rng);
    this.players.set(p.id, p);
    return p;
  }

  disconnect(socketId: string) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        p.socketId = null;
        p.disconnectedAt = this.now;
      }
    }
  }

  playerBySocket(socketId: string): Player | undefined {
    for (const p of this.players.values()) if (p.socketId === socketId) return p;
    return undefined;
  }

  input(socketId: string, input: PhoneInput) {
    const p = this.playerBySocket(socketId);
    if (!p) return;
    applyInput(p, input, this.now);
  }

  sensorStatus(socketId: string, status: SensorStatus) {
    const p = this.playerBySocket(socketId);
    if (!p || !status || typeof status.sensor !== 'string') return;
    p.sensor = { sensor: String(status.sensor).slice(0, 20), state: status.state, calibrated: !!status.calibrated };
  }

  setPing(socketId: string, ms: number) {
    const p = this.playerBySocket(socketId);
    if (p && Number.isFinite(ms)) p.ping = Math.round(clamp(ms, 0, 99999));
  }

  devInput(d: DevInput) {
    const sim = this.sims.get(d.sense);
    if (!sim || !this.config.displayKeyboard) return;
    if ('input' in d) applyInput(sim.player, d.input, this.now);
    else {
      // a held key (arrows for direction, scratching keys) repeats every tick until released
      sim.held = d.hold === null || !Number.isFinite(d.hold) ? null : clamp(Number(d.hold), -1, 1);
      if (sim.held === null && (d.sense === 'direction' || d.sense === 'memory')) applyInput(sim.player, { t: 'value', v: 0 }, this.now);
    }
    sim.overrideUntil = this.now + 5000;
  }

  setBots(count: number) {
    const n = Math.max(0, Math.min(16, Math.floor(count)));
    const bots = [...this.players.values()].filter((p) => p.kind === 'bot');
    while (bots.length > n) {
      const b = bots.pop()!;
      this.players.delete(b.id);
      this.bots.delete(b.id);
    }
    for (let i = bots.length; i < n; i++) {
      const p = createPlayer(`bot-${i + 1}`, 'bot', this.nextRole(this.holders()));
      this.objectives.assign(p, this.rng);
      this.players.set(p.id, p);
      this.bots.set(p.id, new SimBrain(p, () => this.rng.next(), 1));
    }
  }

  // ---------------- simulation ----------------

  /** averages every sense over its players (and the simulation of senses nobody plays) */
  private aggregate() {
    const groups = new Map<SenseId, { w: number; sums: Record<string, number> }>();
    const add = (key: SenseId, ch: Record<string, number>, w: number) => {
      if (w <= 0) return;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { w: 0, sums: {} }));
      g.w += w;
      for (const [k, v] of Object.entries(ch)) g.sums[k] = (g.sums[k] ?? 0) + v * w;
    };
    for (const p of this.players.values()) if (p.influence > 0.001) add(p.role.sense, playerChannels(p), p.influence);
    for (const [sense, sim] of this.sims) {
      const realW = groups.get(sense)?.w ?? 0;
      const override = sim.held !== null || this.now < sim.overrideUntil;
      const w = override ? 3 : this.config.simulateMissing ? Math.max(0, 1 - realW) : 0;
      sim.player.influence = w;
      add(sense, playerChannels(sim.player), w);
    }
    const has = (k: SenseId) => (groups.get(k)?.w ?? 0) > 0.01;
    const g = (k: SenseId, ch: string, def: number) => {
      const gr = groups.get(k);
      return gr && gr.w > 0.01 ? (gr.sums[ch] ?? 0) / gr.w : def;
    };
    const sens = this.config.sensitivity;
    // a sense nobody plays (simulation off) leaves Dargato as he is: he walks, sees and remembers
    this.senses = {
      sight: clamp(0.5 + (g('sight', 'v', 0.5) - 0.5) * sens.sight),
      paws: has('speed') ? clamp(g('speed', 'drive', 0) * sens.speed) : 0.5,
      turn: clamp(g('direction', 'x', 0) * sens.direction, -1, 1),
      memory: has('memory') ? clamp(g('memory', 'level', 0) * sens.memory) : 1,
      instinct: clamp(g('instinct', 'drive', 0) * sens.instinct),
      heartRate: g('heartbeat', 'bpm', 0),
      heartKept: has('heartbeat'),
    };
    this.aggregated = { ...this.senses, heartKept: this.senses.heartKept ? 1 : 0 };
  }

  /** turns the averaged senses into what Dargato feels (smoothed), and checks his heart */
  private updateInternals(dt: number) {
    const I = this.cat.I;
    const S = this.senses;
    const cfg = this.config;
    const ease = (cur: number, target: number, up: number, down = up) => cur + (target - cur) * Math.min(1, dt * (target > cur ? up : down));
    // far from home little light and sound are enough; nearing home he needs more of both
    const d0 = this.world.distHome[this.world.start] || 1;
    this.near = ease(this.near, clamp(1 - this.cat.distanceToHome / d0), 0.5);
    const curve = senseCurves(this.near, cfg.sightWidth, cfg.soundWidth);
    // SIGHT: a comfortable band; below it the night closes in, above it the glare
    I.sight = ease(I.sight, S.sight, 3);
    I.light = 0.06 + 0.94 * smoothstep(curve.dark[0], curve.dark[1], I.sight);
    I.glare = smoothstep(curve.glare[0], curve.glare[1], I.sight);
    I.paws = S.paws;
    I.turn = S.turn;
    // MEMORY: sound pulls the paths together; in silence they come apart, more slowly
    I.cohesion = ease(I.cohesion, smoothstep(curve.sound[0], curve.sound[1], S.memory), 1.4, 0.45);
    // INSTINCT; in the final stretch the way home starts to glow by itself
    const late = this.journeyT > cfg.maxDurationSec ? 0.35 + 0.5 * clamp((this.journeyT - cfg.maxDurationSec) / Math.max(1, cfg.finalGraceSec)) : 0;
    I.instinct = ease(I.instinct, Math.max(S.instinct, late), 2.5, 0.4);
    // HEARTBEAT: off the beat (or no taps) builds strain; on the beat it recovers
    I.heartRate = S.heartRate;
    I.heart = S.heartKept ? heartPosition(S.heartRate, cfg.heartBpm) : 0;
    const zone = heartZone(cfg.heartWidth);
    const off = clamp((Math.abs(I.heart) - zone) / 0.4);
    if (this.phase !== 'journey' || this.journeyT < 4) I.strain = ease(I.strain, 0, 1);
    else if (Math.abs(I.heart) > zone) I.strain = clamp(I.strain + (dt * (0.35 + 0.65 * off)) / cfg.heartFailSec);
    else I.strain = clamp(I.strain - dt / (cfg.heartFailSec * 0.8));
  }

  emit(kind: WorldEventKind, x: number, z: number, dur: number, strength: number, text?: string, data?: WorldEvent['data']) {
    const ev: WorldEvent = { id: this.eventId++, kind, x, z, t0: this.now, dur, strength, text: this.config.whispers ? text : undefined, data };
    this.events.push(ev);
    if (this.events.length > 30) this.events.shift();
    this.out.displays('ev', ev);
  }

  private catHooks() {
    return {
      onHome: () => this.endJourney('home'),
      onDiscovery: (n: number, kind: keyof typeof DISCOVERY_TEXT) => {
        const node = this.world.nodes[n];
        this.emit('discovery', node.x, node.z, 5, 1, DISCOVERY_TEXT[kind], { kind });
        this.objectives.onDiscovery(this.now);
      },
      onDetour: () => this.objectives.onDetour(this.now),
      onRecovered: () => this.emit('recovered', this.cat.x, this.cat.z, 3, 1, 'he finds his way again'),
      onLandmarkNear: (lm: Landmark) => {
        this.narrative.onLandmarkNear(lm, { emit: (...a) => this.emit(...a) });
        if (lm.kind.startsWith('red')) this.objectives.onLandmarkVisit(this.now);
      },
      onStreet: (edge: number, fresh: boolean) => this.objectives.onStreet(this.world.edges[edge].kind, fresh, this.now),
    };
  }

  /** one fixed simulation step */
  step() {
    const dt = DT;
    this.now += dt * 1000;
    this.tickCount++;
    const graceSec = this.config.reconnectGraceSec;

    // players: decay, cleanup, bots, sims
    for (const p of [...this.players.values()]) {
      tickPlayer(p, dt, this.now, graceSec);
      if (p.kind === 'phone' && !p.connected && this.now - p.disconnectedAt > graceSec * 1000) this.players.delete(p.id);
    }
    const ctx: SimContext = { steer: this.phase === 'journey' ? this.cat.steerHome() : 0, heartBpm: this.config.heartBpm, clear: clearBand(this.near, this.config.sightWidth), sound: senseCurves(this.near, 1, this.config.soundWidth).sound };
    for (const [id, brain] of this.bots) {
      if (this.players.has(id)) brain.think(dt, this.now, ctx);
    }
    for (const [sense, sim] of this.sims) {
      tickPlayer(sim.player, dt, this.now, graceSec);
      sim.brain.intensity = this.config.simIntensity;
      if (sim.held !== null) {
        const inp = heldInput(sense, sim.held);
        if (inp) applyInput(sim.player, inp, this.now);
        sim.overrideUntil = this.now + 5000;
      } else if (this.now >= sim.overrideUntil) sim.brain.think(dt, this.now, ctx);
    }

    if (!this.paused) {
      this.phaseT += dt;
      this.aggregate();
      this.updateInternals(dt);
      switch (this.phase) {
        case 'lobby': {
          const real = this.holders().length;
          if (this.config.autoStart && real >= this.config.autoStartMinPlayers) {
            if (!this.autoStartAt) this.autoStartAt = this.now + this.config.autoStartDelaySec * 1000;
            if (this.now >= this.autoStartAt) this.start();
          } else this.autoStartAt = 0;
          break;
        }
        case 'intro':
          if (this.phaseT >= 6) {
            this.setPhase('journey');
            this.cat.begin();
          }
          break;
        case 'journey':
          this.stepJourney(dt);
          break;
        case 'arrival':
          if (this.phaseT > 3) this.cat.state = 'home';
          if (this.phaseT >= 12) this.setPhase('summary');
          break;
        case 'sleep':
          this.cat.state = 'sleeping';
          if (this.phaseT >= 12) this.setPhase('summary');
          break;
        case 'summary':
          if (this.phaseT >= this.config.summarySec) this.toLobby();
          break;
      }
    }

    if (this.tickCount % 2 === 0) this.out.displays('snap', this.snapshot());
    if (this.tickCount % 8 === 0) {
      for (const p of this.players.values()) if (p.socketId) this.out.phone(p.socketId, 'phone', this.phoneState(p));
      this.out.directors('dir', this.directorState());
    }
  }

  private stepJourney(dt: number) {
    this.journeyT += dt;
    const cfg = this.config;
    const I = this.cat.I;
    this.cat.cfgSpeed = cfg.catSpeed;
    this.cat.update(dt, { paws: this.senses.paws, turn: this.senses.turn, cohesion: I.cohesion });
    if (this.phase !== 'journey') return;
    this.narrative.update({
      now: this.now,
      journeyT: this.journeyT,
      maxDur: cfg.maxDurationSec,
      overtime: this.journeyT > cfg.maxDurationSec,
      lost: I.lost,
      cat: this.cat,
      distanceToHome: this.cat.distanceToHome,
      emit: (...a) => this.emit(...a),
      startle: (x, z) => this.cat.react(x, z),
    });
    this.objectives.tick(dt, this.now, {
      clearSight: I.light > 0.85 && I.glare < 0.15,
      fast: this.cat.speed > cfg.catSpeed * 0.6,
      pathsHeld: I.cohesion > 0.7,
      wayShown: I.instinct > 0.5,
      onBeat: Math.abs(I.heart) < heartZone(this.config.heartWidth),
    });
    if (I.strain >= 1) this.endJourney(I.heart < 0 ? 'slow' : 'fast');
    else if (this.journeyT > this.hardLimit()) this.endJourney('time');
  }

  hardLimit(): number {
    return this.config.maxDurationSec + this.config.finalGraceSec;
  }

  // ---------------- views ----------------

  private homeReveal(): number {
    const d0 = this.world.distHome[this.world.start] || 1;
    const ratio = 1 - this.cat.distanceToHome / d0;
    const s = clamp((ratio - 0.45) / 0.5);
    const late = this.journeyT > this.config.maxDurationSec * 0.75 ? 0.2 : 0;
    const over = this.journeyT > this.config.maxDurationSec ? 0.6 : 0;
    if (this.phase === 'arrival' || this.phase === 'summary') return 1;
    return clamp(0.08 + s * s * (3 - 2 * s) * 0.75 + this.cat.I.lost * 0.25 + late + over);
  }

  publicPlayers(): PlayerPublic[] {
    const list: PlayerPublic[] = [];
    for (const p of this.players.values()) {
      list.push({
        id: p.id,
        nickname: p.nickname,
        role: p.role,
        roleName: roleInfo(p.role).name,
        connected: p.connected,
        sim: p.kind === 'bot',
        level: playerLevel(p),
        sensor: p.sensor,
        ping: p.ping,
        lastInputAgo: p.lastInputAt ? Math.round((this.now - p.lastInputAt) / 100) / 10 : -1,
        objective: this.objectives.view(p),
        influence: p.influence,
        ch: roundChannels(p),
        pulses: p.stats.pulses,
      });
    }
    for (const [sense, sim] of this.sims) {
      if (sim.player.influence < 0.5) continue;
      list.push({
        id: 'sim-' + sense,
        nickname: 'simulated',
        role: { sense },
        roleName: roleInfo({ sense }).name,
        connected: true,
        sim: true,
        level: playerLevel(sim.player),
        influence: sim.player.influence,
        ch: roundChannels(sim.player),
        pulses: sim.player.stats.pulses,
      });
    }
    return list;
  }

  snapshot(): Snapshot {
    const max = this.config.maxDurationSec;
    return {
      t: this.now,
      code: this.code,
      phase: this.phase,
      phaseT: this.phaseT,
      journeyT: this.journeyT,
      remaining: max - this.journeyT,
      hardRemaining: this.hardLimit() - this.journeyT,
      overtime: this.journeyT > max,
      paused: this.paused,
      cat: this.cat.snapshot(),
      inner: this.cat.I,
      planned: this.tickCount % 15 === 0 || !this.plannedCache ? (this.plannedCache = this.cat.plannedRoute()) : this.plannedCache,
      homeReveal: this.homeReveal(),
      near: this.near,
      loudness: this.senses.memory,
      targets: {
        sight: clearBand(this.near, this.config.sightWidth),
        sound: senseCurves(this.near, 1, this.config.soundWidth).sound,
        heart: heartZone(this.config.heartWidth),
      },
      heartBpm: this.config.heartBpm,
      players: this.publicPlayers(),
      realPlayers: this.holders().length,
      render: { fog: this.config.fogDensity, light: this.config.lightIntensity, whispers: this.config.whispers, keyboard: this.config.displayKeyboard },
      autoStartIn: this.autoStartAt ? Math.max(0, Math.ceil((this.autoStartAt - this.now) / 1000)) : -1,
      ending: this.ending,
      endCause: this.endCause,
      summary: this.phase === 'summary' ? this.summary : null,
    };
  }

  phoneState(p: Player): PhoneState {
    const info = roleInfo(p.role);
    return {
      playerId: p.id,
      token: p.token,
      nickname: p.nickname,
      code: this.code,
      role: p.role,
      roleName: info.name,
      instruction: info.instruction,
      objective: this.objectives.view(p),
      phase: this.phase,
      paused: this.paused,
      players: this.holders().length,
      cue: { level: levelFor(p.role.sense, this.cat.I, this.cat.speed / Math.max(0.1, this.config.catSpeed)), tempo: this.config.heartBpm, band: clearBand(this.near, this.config.sightWidth), heartZone: heartZone(this.config.heartWidth) },
      feedback: this.feedbackFor(p),
      sensitivity: this.config.sensitivity[p.role.sense],
      summary: (this.phase === 'summary' || this.phase === 'arrival' || this.phase === 'sleep') && this.summary ? this.summary.players.find((s) => s.playerId === p.id) ?? null : null,
      catState: this.cat.state,
    };
  }

  private feedbackFor(p: Player): string {
    if (this.phase === 'lobby') return this.holders().length < 2 ? 'Try your sense while more players join...' : 'Try your sense. The journey begins soon.';
    if (this.phase === 'intro') return 'Dargato wakes up.';
    if (this.phase === 'arrival') return 'Dargato is home.';
    if (this.phase === 'sleep' || this.phase === 'summary') return this.endCause ? ENDING_TEXT[this.endCause] : 'The journey is over.';
    if (this.paused) return 'Paused.';
    const I = this.cat.I;
    const c = this.cat;
    switch (p.role.sense) {
      case 'sight':
        return I.light < 0.5 ? 'Too dark: he sees nothing.' : I.glare > 0.4 ? 'Too bright: the fog blinds him.' : 'He sees the streets clearly.';
      case 'speed':
        return I.cohesion < 0.3 && I.paws > 0.15 ? 'His paws move, but there is no path under them.' : c.state === 'trotting' ? 'He runs!' : c.speed > 0.2 ? 'He walks.' : 'He stands still.';
      case 'direction':
        return I.turn < -0.3 ? 'He turns left...' : I.turn > 0.3 ? 'He turns right...' : 'He goes straight on.';
      case 'memory':
        return I.cohesion > 0.7 ? 'He remembers the streets.' : I.cohesion > 0.3 ? 'The paths are fading...' : 'The streets have fallen apart.';
      case 'instinct':
        if (I.instinct > 0.15 && (I.light < 0.5 || I.glare > 0.4)) return 'The way glows, but his eyes cannot see it.';
        return I.instinct > 0.5 ? 'The way home glows red.' : I.instinct > 0.15 ? 'A faint red pull...' : 'His instinct sleeps.';
      case 'heartbeat':
        return I.heart < -heartZone(this.config.heartWidth) ? 'Faster: his heart is fading!' : I.heart > heartZone(this.config.heartWidth) ? 'Slower: his heart is racing!' : 'His heart beats steadily.';
    }
  }

  directorState(): DirectorState {
    const max = this.config.maxDurationSec;
    return {
      code: this.code,
      config: this.config,
      phase: this.phase,
      paused: this.paused,
      journeyT: this.journeyT,
      remaining: max - this.journeyT,
      hardRemaining: this.hardLimit() - this.journeyT,
      cat: this.cat.snapshot(),
      inner: this.cat.I,
      planned: this.plannedCache ?? [],
      players: this.publicPlayers(),
      aggregated: this.aggregated,
      diagnostics: {
        tickMs: Math.round(this.tickMs * 100) / 100,
        clients: this.out.counts(),
        uptimeSec: Math.round((Date.now() - this.createdAt) / 1000),
        distanceToHome: Math.round(this.cat.distanceToHome),
        bestDistanceToHome: Math.round(this.cat.bestDHome),
        progress: clamp(1 - this.cat.distanceToHome / (this.world.distHome[this.world.start] || 1)),
        visitedEdges: this.cat.visits.size,
        detours: this.cat.detours,
        estDurationSec: this.world.stats.estDurationSec,
        worldStats: this.world.stats,
      },
      events: this.events.slice(-10),
      summary: this.summary,
    };
  }

  // ---------------- director ----------------

  command(cmd: DirectorCommand) {
    switch (cmd.c) {
      case 'start':
        this.start();
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.paused = false;
        break;
      case 'reset':
        this.toLobby(true);
        break;
      case 'setSeed': {
        const seed = String(cmd.seed ?? '').trim().slice(0, 40) || this.randomSeed();
        this.config.seed = seed;
        if (this.phase === 'lobby') this.generate(seed);
        else {
          this.seed = seed;
          this.toLobby(true);
        }
        break;
      }
      case 'regenerate': {
        const seed = cmd.seed?.trim() ? cmd.seed.trim().slice(0, 40) : this.randomSeed();
        if (this.phase !== 'lobby') {
          this.seed = seed;
          this.toLobby(true);
        } else this.generate(seed);
        break;
      }
      case 'config': {
        const patch = cmd.patch ?? {};
        const { sensitivity, ...rest } = patch;
        Object.assign(this.config, sanitizeConfig(rest));
        if (sensitivity) for (const [k, v] of Object.entries(sensitivity)) if (k in this.config.sensitivity && Number.isFinite(v)) this.config.sensitivity[k as SenseId] = clamp(Number(v), 0, 3);
        this.cat.cfgSpeed = this.config.catSpeed;
        break;
      }
      case 'event': {
        const home = this.world.nodes[this.world.home];
        const c = this.cat;
        if (cmd.kind === 'distant-red-light') this.emit('distant-red-light', home.x, home.z, 7, 1, 'a red light, far away');
        else if (cmd.kind === 'red-balloon') this.emit('red-balloon', c.x + Math.sin(c.heading) * 6, c.z + Math.cos(c.heading) * 6, 20, 1, 'something red drifts away', { tx: home.x, tz: home.z });
        else if (cmd.kind === 'home-chorus') this.emit('home-chorus', home.x, home.z, 4, 1, 'voices of cats');
        else if (cmd.kind === 'startle') {
          const x = c.x + Math.cos(c.heading) * 4;
          const z = c.z - Math.sin(c.heading) * 4;
          this.emit('startle', x, z, 1.5, 1);
          c.react(x, z);
        }
        break;
      }
      case 'teleport':
        if (Number.isInteger(cmd.node) && cmd.node >= 0 && cmd.node < this.world.nodes.length) {
          this.cat.teleport(cmd.node);
          if (this.phase === 'lobby') this.cat.state = 'idle';
        }
        break;
      case 'ending':
        if (this.phase === 'lobby') this.start();
        this.setPhase('journey');
        this.endJourney(cmd.kind === 'sleep' ? 'time' : 'home');
        break;
      case 'kick': {
        const p = this.players.get(cmd.playerId);
        if (p) {
          if (p.socketId) this.out.phone(p.socketId, 'kicked', 'You were removed by the host.');
          this.players.delete(p.id);
          this.bots.delete(p.id);
        }
        break;
      }
      case 'reassign': {
        const p = this.players.get(cmd.playerId);
        if (p && SENSE_ORDER.includes(cmd.sense)) {
          p.role = { sense: cmd.sense };
          p.sense = newSenseState(p.role.sense);
          this.objectives.assign(p, this.rng);
        }
        break;
      }
      case 'bots':
        this.setBots(cmd.count);
        break;
      case 'debugOverlay':
        this.out.displays('debugOverlay', !!cmd.on);
        break;
      case 'newSession':
        // handled by the manager
        break;
    }
  }
}

/** a phone's meter: what its sense does to Dargato right now */
function levelFor(sense: SenseId, I: CatInternals, moving: number): number {
  switch (sense) {
    case 'sight':
      return I.sight;
    case 'speed':
      return clamp(moving);
    case 'direction':
      return I.turn;
    case 'memory':
      return I.cohesion;
    case 'instinct':
      return I.instinct;
    case 'heartbeat':
      return I.heart;
  }
}

function sanitizeConfig(patch: Partial<SessionConfig>): Partial<SessionConfig> {
  const out: Partial<SessionConfig> = {};
  const num = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : undefined);
  const set = <K extends keyof SessionConfig>(k: K, v: SessionConfig[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  if ('lockSeed' in patch) set('lockSeed', !!patch.lockSeed);
  if ('maxDurationSec' in patch) set('maxDurationSec', num(patch.maxDurationSec, 60, 1800));
  if ('finalGraceSec' in patch) set('finalGraceSec', num(patch.finalGraceSec, 0, 600));
  if ('catSpeed' in patch) set('catSpeed', num(patch.catSpeed, 0.5, 8));
  if ('heartBpm' in patch) set('heartBpm', num(patch.heartBpm, 40, 140));
  if ('heartFailSec' in patch) set('heartFailSec', num(patch.heartFailSec, 1, 60));
  if ('sightWidth' in patch) set('sightWidth', num(patch.sightWidth, 0.2, 1.5));
  if ('soundWidth' in patch) set('soundWidth', num(patch.soundWidth, 0.2, 1.5));
  if ('heartWidth' in patch) set('heartWidth', num(patch.heartWidth, 0.2, 1.5));
  if ('fogDensity' in patch) set('fogDensity', num(patch.fogDensity, 0, 0.1));
  if ('lightIntensity' in patch) set('lightIntensity', num(patch.lightIntensity, 0.1, 3));
  if ('simulateMissing' in patch) set('simulateMissing', !!patch.simulateMissing);
  if ('simIntensity' in patch) set('simIntensity', num(patch.simIntensity, 0, 1));
  if ('reshuffleRoles' in patch) set('reshuffleRoles', !!patch.reshuffleRoles);
  if ('autoStart' in patch) set('autoStart', !!patch.autoStart);
  if ('autoStartDelaySec' in patch) set('autoStartDelaySec', num(patch.autoStartDelaySec, 5, 600));
  if ('autoStartMinPlayers' in patch) set('autoStartMinPlayers', num(patch.autoStartMinPlayers, 1, 16));
  if ('summarySec' in patch) set('summarySec', num(patch.summarySec, 5, 300));
  if ('displayKeyboard' in patch) set('displayKeyboard', !!patch.displayKeyboard);
  if ('whispers' in patch) set('whispers', !!patch.whispers);
  if ('reconnectGraceSec' in patch) set('reconnectGraceSec', num(patch.reconnectGraceSec, 5, 3600));
  return out;
}
