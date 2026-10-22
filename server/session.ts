// One installation session: lobby -> intro -> journey -> arrival/sleep -> summary -> lobby.
// Owns the authoritative simulation (cat, hints, players, objectives).
import { DEFAULT_CONFIG, type SessionConfig } from '../shared/config';
import { clamp, sampleEdge, wrapAngle } from '../shared/graph';
import type { DevInput, DirectorCommand, DirectorState, JourneySummary, PhoneInput, PhoneState, PlayerPublic, SensorStatus, Snapshot } from '../shared/protocol';
import { CORE_SENSES, SENSE_ORDER, VARIANT_ORDER, roleInfo, roleKey } from '../shared/roles';
import { Rng } from '../shared/rng';
import type { Landmark, Phase, RoleRef, SenseId, World, WorldEvent, WorldEventKind } from '../shared/types';
import { generateWorld } from '../shared/worldgen';
import { CatSim, type Decision } from './cat';
import { HintSystem } from './hints';
import { DISCOVERY_TEXT, Narrative } from './narrative';
import { Objectives } from './objectives';
import { SimBrain, applyInput, createPlayer, isActive, newSenseState, playerChannels, playerLevel, tickPlayer, type Player } from './players';
import { NEUTRAL_INFLUENCES, TERM_SOURCES, type Influences } from './routeChoice';

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
  heldOverride: boolean;
}

const SEED_WORDS = ['fog', 'night', 'alley', 'lamp', 'stone', 'echo', 'paw', 'whisker', 'ember', 'dusk', 'roof', 'gutter'];

export class Session {
  config: SessionConfig;
  seed: string;
  world!: World;
  cat!: CatSim;
  hints!: HintSystem;
  narrative!: Narrative;
  players = new Map<string, Player>();
  sims = new Map<SenseId, Sim>();
  bots = new Map<string, SimBrain>();
  objectives: Objectives;
  phase: Phase = 'lobby';
  phaseT = 0;
  journeyT = 0;
  extension = 0;
  paused = false;
  events: WorldEvent[] = [];
  decisions: { t: number; node: number; chosen: number; terms: Record<string, number>; decisive: string; margin: number }[] = [];
  summary: JourneySummary | null = null;
  ending: null | 'home' | 'sleep' = null;
  inf: Influences = { ...NEUTRAL_INFLUENCES };
  aggregated: Record<string, number> = {};
  journeyCount = 0;
  autoStartAt = 0;
  tickMs = 0;
  hintsSeen = 0;
  memories = 0;
  createdAt = Date.now();
  /** simulated clock (ms); advances with ticks so headless tests can run faster than real time */
  now = Date.now();
  private rng: Rng;
  private eventId = 1;
  private memoryCooldownUntil = 0;
  private lastMemoryBy = new Map<string, number>();
  private tickCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastWall = 0;
  private acc = 0;

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
      const p = createPlayer(`sim-${sense}`, 'sim', { sense, variant: false });
      this.sims.set(sense, { player: p, brain: new SimBrain(p, () => this.rng.next(), this.config.simIntensity), overrideUntil: 0, heldOverride: false });
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
    const wr = new Rng('hints:' + seed + ':' + this.journeyCount);
    this.hints = new HintSystem(this.world, wr.fork('h'));
    this.narrative = new Narrative(this.world, wr.fork('n'));
    this.events = [];
    this.decisions = [];
    this.hintsSeen = 0;
    this.memories = 0;
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
    this.extension = 0;
    this.ending = null;
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
    this.summary = null;
    this.journeyT = 0;
    this.extension = 0;
    if (this.config.reshuffleRoles && !keepSeed) this.reshuffleRoles();
    for (const p of this.players.values()) {
      p.stats = { inputs: 0, decisive: 0, memories: 0, pulses: p.stats.pulses };
      this.objectives.assign(p, this.rng);
    }
    this.generate(seed);
  }

  private endJourney(kind: 'home' | 'sleep') {
    if (this.phase !== 'journey' && this.phase !== 'intro') return;
    this.ending = kind;
    this.objectives.finish();
    this.cat.state = kind === 'home' ? 'arriving' : 'sleeping';
    this.cat.speed = 0;
    if (kind === 'home' && this.cat.mode === 'edge') this.cat.teleport(this.world.home);
    if (kind === 'home') this.cat.state = 'arriving';
    const real = [...this.players.values()].filter((p) => p.kind !== 'sim');
    this.summary = {
      ending: kind,
      durationSec: Math.round(this.journeyT),
      distance: Math.round(this.cat.distance),
      junctions: this.cat.junctions,
      detours: this.cat.detours,
      hintsSeen: this.hintsSeen,
      memories: this.memories,
      players: real.map((p) => this.objectives.summary(p)),
    };
    this.setPhase(kind === 'home' ? 'arrival' : 'sleep');
    this.emit(kind === 'home' ? 'home-chorus' : 'distant-red-light', this.cat.x, this.cat.z, 8, 1, kind === 'home' ? 'Dargato is home.' : 'Not tonight. The street will keep his place.');
  }

  // ---------------- players ----------------

  private holders(exclude?: Player): Player[] {
    const graceMs = this.config.reconnectGraceSec * 1000;
    return [...this.players.values()].filter((p) => p !== exclude && p.kind !== 'sim' && (p.connected || this.now - p.disconnectedAt < graceMs));
  }

  private nextRole(held: Player[]): RoleRef {
    const has = (sense: SenseId, variant: boolean) => held.some((p) => p.role.sense === sense && p.role.variant === variant);
    for (const s of SENSE_ORDER) if (!has(s, false)) return { sense: s, variant: false };
    if (this.config.extraPlayerMode === 'variant') for (const s of VARIANT_ORDER) if (!has(s, true)) return { sense: s, variant: true };
    // repeat the least-held core sense; inputs of the same role are averaged
    let best: SenseId = CORE_SENSES[0];
    let bestN = Infinity;
    for (const s of CORE_SENSES) {
      const n = held.filter((p) => p.role.sense === s && !p.role.variant).length;
      if (n < bestN) {
        bestN = n;
        best = s;
      }
    }
    return { sense: best, variant: false };
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
        // release held controls
        p.sense.hold = false;
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
    if ('input' in d) {
      applyInput(sim.player, d.input, this.now);
      sim.overrideUntil = this.now + 5000;
    } else {
      // held continuous override (e.g. arrow keys for direction)
      if (d.hold === null) sim.heldOverride = false;
      else {
        sim.heldOverride = true;
        applyInput(sim.player, { t: 'value', v: d.hold }, this.now);
        sim.overrideUntil = this.now + 5000;
      }
    }
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

  private aggregate() {
    const groups = new Map<string, { w: number; sums: Record<string, number> }>();
    const add = (key: string, ch: Record<string, number>, w: number) => {
      if (w <= 0) return;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { w: 0, sums: {} }));
      g.w += w;
      for (const [k, v] of Object.entries(ch)) g.sums[k] = (g.sums[k] ?? 0) + v * w;
    };
    for (const p of this.players.values()) if (p.influence > 0.001) add(roleKey(p.role), playerChannels(p), p.influence);
    for (const [sense, sim] of this.sims) {
      const realW = groups.get(sense)?.w ?? 0;
      const override = sim.heldOverride || this.now < sim.overrideUntil;
      const w = override ? 3 : this.config.simulateMissing && sense !== 'heartbeat' ? Math.max(0, 1 - realW) : 0;
      sim.player.influence = w;
      add(sense, playerChannels(sim.player), w);
    }
    const has = (k: string) => (groups.get(k)?.w ?? 0) > 0.01;
    const g = (k: string, ch: string, def: number) => {
      const gr = groups.get(k);
      return gr && gr.w > 0.01 ? (gr.sums[ch] ?? 0) / gr.w : def;
    };
    const sens = this.config.sensitivity;
    const inf: Influences = {
      perception: clamp(0.5 + (g('vision', 'v', 0.5) - 0.5) * sens.vision),
      redGain: has('vision-b') ? clamp(1 + (g('vision-b', 'v', 0.5) - 0.5) * 1.6 * sens.vision, 0.2, 1.8) : 1,
      dir: clamp(g('direction', 'x', 0) * sens.direction, -1, 1),
      explore: has('direction-b') ? clamp(-g('direction-b', 'x', 0) * sens.direction, -1, 1) : 0,
      energyDrive: clamp(g('instinct', 'drive', 0) * sens.instinct),
      scratch: clamp(g('instinct', 'scratch', 0) * sens.instinct),
      restraint: has('instinct-b') ? clamp(g('instinct-b', 'drive', 0) * sens.instinct) : 0,
      calmDrive: clamp(g('emotion', 'calm', 0) * sens.emotion),
      curiosityDrive: clamp(g('emotion', 'curiosity', 0) * sens.emotion),
      cautionDrive: clamp(g('emotion', 'caution', 0) * sens.emotion),
      rest: has('emotion-b') ? clamp(g('emotion-b', 'rest', 0) * sens.emotion) : 0,
      acuity: clamp(g('hearing', 'acuity', 0.25) * sens.hearing),
      farHearing: has('hearing-b') ? clamp(((g('hearing-b', 'acuity', 0) - 0.3) / 0.7) * sens.hearing) : 0,
      soundGain: has('memory-b') ? clamp(0.4 + 1.4 * g('memory-b', 'level', 0.4) * sens.memory, 0.3, 1.8) : 1,
      heartbeat: clamp(g('heartbeat', 'quality', 0) * sens.heartbeat),
      memoryLevel: clamp(g('memory', 'level', 0.2) * sens.memory),
    };
    this.inf = inf;
    this.aggregated = { ...(inf as unknown as Record<string, number>) };
  }

  private homewardBase(): number {
    const max = this.config.maxDurationSec;
    let h = 0.45 + 0.55 * Math.pow(clamp(this.journeyT / max), 1.6);
    if (this.journeyT > max) h += 1.2 + 1.5 * clamp((this.journeyT - max) / Math.max(1, this.config.finalGraceSec));
    return h;
  }

  private nextJunction(): { node: number; arrive: number } {
    return this.cat.mode === 'edge' ? { node: this.cat.to, arrive: this.cat.edge } : { node: this.cat.node, arrive: this.cat.arriveEdge };
  }

  private sideWord(x: number, z: number): string {
    const rel = wrapAngle(Math.atan2(x - this.cat.x, z - this.cat.z) - this.cat.heading);
    return rel > 0.5 ? 'to the left' : rel < -0.5 ? 'to the right' : 'ahead';
  }

  triggerMemory(p: Player | null, strength: number, rhythm: boolean, force = false): boolean {
    if (this.phase !== 'journey') return false;
    if (!force) {
      if (this.now < this.memoryCooldownUntil) return false;
      if (p && this.now - (this.lastMemoryBy.get(p.id) ?? 0) < 9000) return false;
    }
    const { node, arrive } = this.nextJunction();
    const h = this.hints.soundFrom(node, arrive, clamp((0.55 + 0.35 * strength) * (rhythm ? 1.25 : 1), 0, 1.3), this.now, this.landmarksByNode(), 'memory');
    if (!h) return false;
    if (rhythm) this.hints.add('silhouette', h.edgeId, node, 0.9, this.now, 10, 'memory');
    const e = this.world.edges[h.edgeId];
    const pos = sampleEdge(e, node, Math.min(9, e.length * 0.5));
    this.emit(rhythm ? 'memory-flash' : 'memory-sound', pos.x, pos.z, rhythm ? 6 : 4, h.strength, `a sound he once knew, ${this.sideWord(pos.x, pos.z)}`, { edge: h.edgeId, node });
    this.cat.react(pos.x, pos.z, 0.6);
    this.memoryCooldownUntil = this.now + 6000;
    this.memories++;
    if (p) {
      this.lastMemoryBy.set(p.id, this.now);
      p.stats.memories++;
      this.objectives.onMemory(p);
    }
    return true;
  }

  private lmCache: Map<number, Landmark[]> | null = null;
  private lmWorld: World | null = null;
  private landmarksByNode(): Map<number, Landmark[]> {
    if (this.lmWorld !== this.world || !this.lmCache) {
      this.lmCache = new Map();
      for (const l of this.world.landmarks) {
        if (!this.lmCache.has(l.nodeId)) this.lmCache.set(l.nodeId, []);
        this.lmCache.get(l.nodeId)!.push(l);
      }
      this.lmWorld = this.world;
    }
    return this.lmCache;
  }

  emit(kind: WorldEventKind, x: number, z: number, dur: number, strength: number, text?: string, data?: WorldEvent['data']) {
    const ev: WorldEvent = { id: this.eventId++, kind, x, z, t0: this.now, dur, strength, text: this.config.whispers ? text : undefined, data };
    this.events.push(ev);
    if (this.events.length > 30) this.events.shift();
    this.out.displays('ev', ev);
  }

  private catHooks() {
    return {
      onDecision: (d: Decision) => this.onDecision(d),
      onArriveNode: (n: number) => {
        const node = this.world.nodes[n];
        if (node.edges.length >= 3) this.hints.prepareJunction(n, this.cat.arriveEdge, this.hintCtx());
        if ((this.landmarksByNode().get(n) ?? []).some((l) => l.kind.startsWith('red'))) this.objectives.onLandmarkVisit(this.now);
      },
      onApproach: (n: number, edge: number) => this.hints.prepareJunction(n, edge, this.hintCtx()),
      onHome: () => this.endJourney('home'),
      onDiscovery: (n: number, kind: keyof typeof DISCOVERY_TEXT) => {
        const node = this.world.nodes[n];
        this.emit('discovery', node.x, node.z, 5, 1, DISCOVERY_TEXT[kind], { kind });
      },
      onDetour: () => this.objectives.onDetour(this.now),
      onRecovered: () => this.emit('recovered', this.cat.x, this.cat.z, 3, 1, 'he finds his way again'),
      onLandmarkNear: (lm: Landmark) => this.narrative.onLandmarkNear(lm, { emit: (...a) => this.emit(...a) }),
      hints: () => this.hints.hints,
    };
  }

  private hintCtx() {
    return { now: this.now, timeFrac: clamp(this.journeyT / this.config.maxDurationSec), lost: this.cat.I.lost, overtime: this.journeyT > this.config.maxDurationSec };
  }

  private onDecision(d: Decision) {
    const chosen = d.options[0];
    const runner = d.options[1];
    this.decisions.push({ t: d.t, node: d.node, chosen: d.chosen, terms: chosen.terms, decisive: d.decisive, margin: d.margin });
    if (this.decisions.length > 25) this.decisions.shift();
    const sources = TERM_SOURCES[d.decisive];
    if (sources) {
      for (const p of this.players.values()) if (sources.includes(roleKey(p.role)) && isActive(p, this.now, 10000)) p.stats.decisive++;
    }
    const e = this.world.edges[d.chosen];
    const fresh = !this.cat.shortestEdges.has(d.chosen) && (this.cat.visits.get(d.chosen) ?? 0) === 0;
    this.objectives.onDecision(chosen, e, runner, fresh, this.now);
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
    const ctx = { approaching: this.cat.approached, hesitating: this.cat.state === 'hesitating' };
    for (const [id, brain] of this.bots) {
      const p = this.players.get(id);
      if (p) brain.think(dt, this.now, ctx);
    }
    for (const [sense, sim] of this.sims) {
      tickPlayer(sim.player, dt, this.now, graceSec);
      sim.brain.intensity = this.config.simIntensity;
      const override = sim.heldOverride || this.now < sim.overrideUntil;
      if (!override && sense !== 'heartbeat') sim.brain.think(dt, this.now, ctx);
    }

    if (!this.paused) {
      this.phaseT += dt;
      this.aggregate();
      this.processMemoryOnsets();
      switch (this.phase) {
        case 'lobby': {
          const real = this.holders().length;
          if (this.config.autoStart && real >= this.config.autoStartMinPlayers) {
            if (!this.autoStartAt) this.autoStartAt = this.now + this.config.autoStartDelaySec * 1000;
            if (this.now >= this.autoStartAt) this.start();
          } else this.autoStartAt = 0;
          this.cat.lastInf = this.inf;
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

  private processMemoryOnsets() {
    const all = [...this.players.values(), ...[...this.sims.values()].map((s) => s.player)];
    for (const p of all) {
      if (p.role.sense !== 'memory' || !p.sense.pendingOnsets.length) continue;
      const onsets = p.sense.pendingOnsets.splice(0);
      if (p.role.variant) continue; // ECHO uses loudness only
      if (p.kind === 'sim' && p.influence < 0.5) continue;
      const best = onsets.reduce((a, b) => (b.rhythm || b.v > a.v ? b : a));
      this.triggerMemory(p, best.v * this.config.sensitivity.memory, best.rhythm);
    }
  }

  private stepJourney(dt: number) {
    this.journeyT += dt;
    const cfg = this.config;
    this.cat.cfgSpeed = cfg.catSpeed;
    this.cat.update(dt, this.inf, this.homewardBase());
    this.hints.update(this.now, this.cat.I, cfg.hintVisibility, { mode: this.cat.mode, from: this.cat.from, s: this.cat.s, node: this.cat.node });
    for (const h of this.hints.hints) {
      if (h.visible >= 0.5 && h.kind !== 'sound' && !this.hints.revealed.has(h.id)) {
        this.hints.revealed.add(h.id);
        this.hintsSeen++;
        this.objectives.onHintRevealed(this.now);
      }
    }
    this.narrative.update({
      now: this.now,
      journeyT: this.journeyT,
      maxDur: cfg.maxDurationSec,
      overtime: this.journeyT > cfg.maxDurationSec,
      lost: this.cat.I.lost,
      caution: this.cat.I.caution,
      cat: this.cat,
      distanceToHome: this.cat.distanceToHome,
      emit: (...a) => this.emit(...a),
      familiarSound: () => {
        const { node, arrive } = this.nextJunction();
        const h = this.hints.soundFrom(node, arrive, 0.35 + 0.3 * this.cat.I.lost, this.now, this.landmarksByNode(), 'familiar', true);
        if (h) {
          const e = this.world.edges[h.edgeId];
          const pos = sampleEdge(e, node, Math.min(12, e.length * 0.6));
          this.emit('familiar-sound', pos.x, pos.z, 4, h.strength, undefined, { edge: h.edgeId, node });
        }
      },
      startle: (x, z) => {
        this.cat.react(x, z, 1);
        this.cat.maybeReverse();
      },
    });
    this.objectives.tick(dt, this.now, { fast: this.cat.speed > cfg.catSpeed * 1.2, calm: this.cat.I.calm, fatigue: this.cat.I.fatigue });
    this.extension = Math.min(cfg.maxHeartbeatExtensionSec, this.extension + dt * 0.5 * this.inf.heartbeat);
    if (this.journeyT > this.hardLimit()) this.endJourney('sleep');
  }

  hardLimit(): number {
    return this.config.maxDurationSec + this.config.finalGraceSec + this.extension;
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
        role: { sense, variant: false },
        roleName: roleInfo({ sense, variant: false }).name,
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
      hints: this.hints.hints,
      options: this.cat.state === 'hesitating' ? this.cat.options : [],
      planned: this.tickCount % 30 === 0 || !this.plannedCache ? (this.plannedCache = this.cat.plannedRoute()) : this.plannedCache,
      homeReveal: this.homeReveal(),
      extension: this.extension,
      players: this.publicPlayers(),
      realPlayers: this.holders().length,
      render: { fog: this.config.fogDensity, light: this.config.lightIntensity, hintVisibility: this.config.hintVisibility, whispers: this.config.whispers, keyboard: this.config.displayKeyboard },
      autoStartIn: this.autoStartAt ? Math.max(0, Math.ceil((this.autoStartAt - this.now) / 1000)) : -1,
      ending: this.ending,
      summary: this.phase === 'summary' ? this.summary : null,
    };
  }
  private plannedCache: number[] | null = null;

  phoneState(p: Player): PhoneState {
    const info = roleInfo(p.role);
    const I = this.cat.I;
    const sense = p.role.sense;
    // HEARING cue: where the strongest sound is (FAR EAR: where home is)
    let side = 0;
    const { node } = this.nextJunction();
    const sound = this.hints.hints.filter((h) => h.kind === 'sound' && h.nodeId === node).sort((a, b) => b.strength - a.strength)[0];
    let target: { x: number; z: number } | null = null;
    if (p.role.variant && sense === 'hearing') target = this.world.nodes[this.world.home];
    else if (sound) target = sampleEdge(this.world.edges[sound.edgeId], node, 8);
    if (target) {
      const rel = wrapAngle(Math.atan2(target.x - this.cat.x, target.z - this.cat.z) - this.cat.heading);
      side = rel > 0.35 ? -1 : rel < -0.35 ? 1 : 0;
    } else side = Math.floor(this.now / 3200) % 3 === 0 ? -1 : Math.floor(this.now / 3200) % 3 === 1 ? 1 : 0;

    const feedback = this.feedbackFor(p);
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
      cue: {
        approaching: this.cat.approached || this.cat.state === 'hesitating',
        side,
        tempo: 72 + Math.round(I.energy * 30),
        cooldown: Math.max(0, Math.ceil((Math.max(this.memoryCooldownUntil, (this.lastMemoryBy.get(p.id) ?? 0) + 9000) - this.now) / 1000)),
        level: this.levelFor(p),
      },
      feedback,
      sensitivity: this.config.sensitivity[sense],
      summary: (this.phase === 'summary' || this.phase === 'arrival' || this.phase === 'sleep') && this.summary ? this.summary.players.find((s) => s.playerId === p.id) ?? null : null,
      catState: this.cat.state,
    };
  }

  private levelFor(p: Player): number {
    const I = this.cat.I;
    switch (roleKey(p.role)) {
      case 'vision':
        return I.perception;
      case 'vision-b':
        return clamp(I.redGain / 1.8);
      case 'direction':
        return I.direction;
      case 'direction-b':
        return I.explore;
      case 'instinct':
        return I.energy;
      case 'instinct-b':
        return I.caution;
      case 'emotion':
        return I.calm - I.curiosity;
      case 'emotion-b':
        return I.rest;
      case 'hearing':
        return I.acuity;
      case 'hearing-b':
        return I.farHearing;
      case 'memory':
        return I.memory;
      case 'memory-b':
        return clamp(I.soundGain / 1.8);
      default:
        return clamp(this.extension / Math.max(1, this.config.maxHeartbeatExtensionSec));
    }
  }

  private feedbackFor(p: Player): string {
    if (this.phase === 'lobby') return this.holders().length < 2 ? 'Waiting for more senses...' : 'Waiting for the journey to begin.';
    if (this.phase === 'intro') return 'Dargato wakes up.';
    if (this.phase === 'arrival') return 'Dargato is home.';
    if (this.phase === 'sleep') return 'Dargato sleeps. The night is over.';
    if (this.phase === 'summary') return 'The journey is over.';
    if (this.paused) return 'Paused.';
    const I = this.cat.I;
    const c = this.cat;
    switch (roleKey(p.role)) {
      case 'vision':
        return I.perception > 0.7 ? 'The streets are clear to him.' : I.perception > 0.45 ? 'The streets are hazy.' : 'He sees almost nothing.';
      case 'vision-b':
        return I.redGain > 1.2 ? 'Red burns bright in his eyes.' : I.redGain < 0.8 ? 'Red fades to grey for him.' : 'Red is just red.';
      case 'direction':
      case 'direction-b': {
        if (c.state === 'hesitating' && c.options.length) {
          const t = c.options[0].turn;
          return t > 0.5 ? 'He leans to the left...' : t < -0.5 ? 'He leans to the right...' : 'He looks straight ahead...';
        }
        return c.approached ? 'A junction is coming.' : 'He walks on.';
      }
      case 'instinct':
        return I.fatigue > 0.75 ? 'He is exhausted.' : c.state === 'trotting' ? 'He trots!' : c.state === 'resting' ? 'He rests.' : 'He walks.';
      case 'instinct-b':
        return I.caution > 0.6 ? 'He moves carefully.' : 'He is not holding back.';
      case 'emotion':
        return I.caution > 0.6 ? 'He feels wary.' : I.calm > I.curiosity ? 'He feels calm.' : 'He feels curious.';
      case 'emotion-b':
        return I.fatigue > 0.5 ? 'He is tired.' : c.state === 'resting' ? 'He rests.' : 'He feels rested.';
      case 'hearing':
        return I.acuity > 0.6 ? 'His ears are sharp.' : I.acuity > 0.35 ? 'He listens.' : 'His ears are dull.';
      case 'hearing-b':
        return I.farHearing > 0.4 ? 'He hears the cats of home.' : 'Home is too far to hear.';
      case 'memory':
        return this.events.some((e) => (e.kind === 'memory-sound' || e.kind === 'memory-flash') && this.now - e.t0 < 4000) ? 'A memory echoes in the street.' : 'He listens for something familiar.';
      case 'memory-b':
        return I.soundGain > 1.2 ? 'Sounds pull at him.' : I.soundGain < 0.8 ? 'He ignores the sounds.' : 'He notices sounds.';
      default:
        return this.extension > 1 ? `The night lasts ${Math.round(this.extension)}s longer.` : 'Keep his heart beating.';
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
      extension: this.extension,
      cat: this.cat.snapshot(),
      inner: this.cat.I,
      options: this.cat.options,
      lastDecisions: this.decisions.slice(-12),
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
        decisions: this.cat.decisions,
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
      case 'hint': {
        const { node, arrive } = this.nextJunction();
        this.hints.forceHomeHint(node, arrive, this.now, cmd.edge);
        break;
      }
      case 'memory':
        this.triggerMemory(null, 1, true, true);
        break;
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
          c.react(x, z, 1);
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
        this.endJourney(cmd.kind === 'sleep' ? 'sleep' : 'home');
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
          p.role = { sense: cmd.sense, variant: !!cmd.variant && cmd.sense !== 'heartbeat' };
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

function sanitizeConfig(patch: Partial<SessionConfig>): Partial<SessionConfig> {
  const out: Partial<SessionConfig> = {};
  const num = (v: unknown, lo: number, hi: number) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : undefined);
  const set = <K extends keyof SessionConfig>(k: K, v: SessionConfig[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  if ('lockSeed' in patch) set('lockSeed', !!patch.lockSeed);
  if ('maxDurationSec' in patch) set('maxDurationSec', num(patch.maxDurationSec, 60, 1800));
  if ('finalGraceSec' in patch) set('finalGraceSec', num(patch.finalGraceSec, 0, 600));
  if ('maxHeartbeatExtensionSec' in patch) set('maxHeartbeatExtensionSec', num(patch.maxHeartbeatExtensionSec, 0, 900));
  if ('catSpeed' in patch) set('catSpeed', num(patch.catSpeed, 0.5, 8));
  if ('fogDensity' in patch) set('fogDensity', num(patch.fogDensity, 0, 0.1));
  if ('lightIntensity' in patch) set('lightIntensity', num(patch.lightIntensity, 0.1, 3));
  if ('hintVisibility' in patch) set('hintVisibility', num(patch.hintVisibility, 0, 3));
  if ('simulateMissing' in patch) set('simulateMissing', !!patch.simulateMissing);
  if ('simIntensity' in patch) set('simIntensity', num(patch.simIntensity, 0, 1));
  if ('extraPlayerMode' in patch) set('extraPlayerMode', patch.extraPlayerMode === 'average' ? 'average' : 'variant');
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
