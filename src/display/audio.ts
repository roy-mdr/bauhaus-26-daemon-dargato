// Synthesized, spatial-ish sound for the main display: wind, distant hum,
// soft footsteps, familiar memory motifs, sounds from alleys, cats of home.
import { clamp, wrapAngle } from '../../shared/graph';
import type { WorldEvent } from '../../shared/types';
import { store } from './store';

const MOTIF = [659.25, 783.99, 987.77, 880, 783.99]; // E5 G5 B5 A5 G5

export class DisplayAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private send!: GainNode;
  private noise!: AudioBuffer;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private purr!: GainNode;
  private hintTone = 0;
  private stepAcc = 0;
  private beatAcc = 0;
  private heardEvents = new Set<number>();
  private lastPhase = '';
  enabled = false;

  async start() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this.enabled = this.ctx.state === 'running';
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    // a simple echo send for space
    this.send = ctx.createGain();
    this.send.gain.value = 0.35;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.31;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    this.send.connect(delay).connect(lp).connect(fb).connect(delay);
    lp.connect(this.master);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // wind
    const wn = ctx.createBufferSource();
    wn.buffer = this.noise;
    wn.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.6;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.05;
    wn.connect(this.windFilter).connect(this.wind).connect(this.master);
    wn.start();
    // distant hum of the town
    for (const f of [55, 82.4]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.012;
      o.connect(g).connect(this.master);
      o.start();
    }
    // purring from home (volume follows proximity)
    const pn = ctx.createBufferSource();
    pn.buffer = this.noise;
    pn.loop = true;
    const plp = ctx.createBiquadFilter();
    plp.type = 'lowpass';
    plp.frequency.value = 140;
    const am = ctx.createGain();
    am.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 24;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(am.gain);
    lfo.start();
    this.purr = ctx.createGain();
    this.purr.gain.value = 0;
    pn.connect(plp).connect(am).connect(this.purr).connect(this.master);
    pn.start();
    await ctx.resume();
    this.enabled = ctx.state === 'running';
  }

  private panner(x: number, z: number): { pan: StereoPannerNode; gain: number } {
    const ctx = this.ctx!;
    const c = store.cat;
    const rel = wrapAngle(Math.atan2(x - c.x, z - c.z) - c.heading);
    const d = Math.hypot(x - c.x, z - c.z);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(-Math.sin(rel), -0.95, 0.95);
    return { pan, gain: 1 / (1 + d / 25) };
  }

  private tone(freq: number, t: number, dur: number, vol: number, out: AudioNode, type: OscillatorType = 'sine', glideTo?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noiseBurst(t: number, dur: number, vol: number, freq: number, out: AudioNode) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  private bus(x: number, z: number, vol: number): AudioNode {
    const { pan, gain } = this.panner(x, z);
    const g = this.ctx!.createGain();
    g.gain.value = vol * gain;
    g.connect(pan);
    pan.connect(this.master);
    pan.connect(this.send);
    return g;
  }

  meow(x: number, z: number, vol: number, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const out = this.bus(x, z, vol);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 2;
    f.connect(out);
    const base = 500 + Math.random() * 250;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 1.6, t + 0.18);
    o.frequency.linearRampToValueAtTime(base * 0.9, t + 0.6);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    o.connect(g).connect(f);
    o.start(t);
    o.stop(t + 0.7);
  }

  onEvent(ev: WorldEvent) {
    if (!this.ctx || !this.enabled || this.heardEvents.has(ev.id)) return;
    this.heardEvents.add(ev.id);
    const t = this.ctx.currentTime + 0.02;
    switch (ev.kind) {
      case 'memory-sound':
      case 'memory-flash': {
        const out = this.bus(ev.x, ev.z, 0.5 * (0.6 + ev.strength * 0.4));
        const notes = ev.kind === 'memory-flash' ? MOTIF : MOTIF.slice(0, 3);
        notes.forEach((f, i) => this.tone(f, t + i * 0.32, 1.2, 0.22, out, 'sine'));
        notes.forEach((f, i) => this.tone(f * 2.005, t + i * 0.32, 0.5, 0.05, out, 'sine'));
        break;
      }
      case 'familiar-sound': {
        const out = this.bus(ev.x, ev.z, 0.35);
        this.tone(880, t, 2.4, 0.2, out);
        this.tone(1318, t, 1.6, 0.08, out);
        break;
      }
      case 'distant-red-light': {
        const out = this.bus(ev.x, ev.z, 0.6);
        const ctx = this.ctx;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 110;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 280;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.18, t + 2);
        g.gain.linearRampToValueAtTime(0.0001, t + ev.dur);
        o.connect(f).connect(g).connect(out);
        o.start(t);
        o.stop(t + ev.dur + 0.1);
        break;
      }
      case 'home-chorus':
        for (let i = 0; i < 2 + Math.round(ev.strength * 3); i++) this.meow(ev.x + (Math.random() - 0.5) * 8, ev.z + (Math.random() - 0.5) * 8, 0.35 * (0.3 + ev.strength), i * 0.45 + Math.random() * 0.3);
        break;
      case 'roof-cat':
        this.meow(ev.x, ev.z, 0.25);
        break;
      case 'startle': {
        const out = this.bus(ev.x, ev.z, 0.8);
        this.noiseBurst(t, 0.35, 0.5, 900, out);
        this.tone(180, t, 0.25, 0.12, out, 'square', 90);
        break;
      }
      case 'discovery': {
        const out = this.bus(ev.x, ev.z, 0.4);
        this.tone(1046, t, 1.5, 0.12, out);
        this.tone(1568, t + 0.12, 1.2, 0.06, out);
        break;
      }
      case 'recovered': {
        const out = this.bus(ev.x, ev.z, 0.35);
        this.tone(523, t, 0.6, 0.12, out);
        this.tone(784, t + 0.18, 0.9, 0.12, out);
        break;
      }
      case 'deja-vu': {
        const out = this.bus(ev.x, ev.z, 0.4);
        this.tone(330, t, 2.5, 0.12, out, 'sine', 660);
        break;
      }
    }
  }

  /** per frame: footsteps, heartbeat, wind, sound-hint presence, phase cues */
  update(dt: number) {
    if (!this.ctx || !this.enabled) return;
    const snap = store.latest;
    const c = store.cat;
    if (!snap) return;
    const now = this.ctx.currentTime;
    // wind breathes slowly, stronger with fog
    this.windFilter.frequency.value = 380 + Math.sin(now * 0.13) * 120;
    this.wind.gain.value = 0.03 + (1 - snap.inner.perception) * 0.05;
    // footsteps
    if (c.speed > 0.2) {
      this.stepAcc += dt * c.speed * 1.9;
      if (this.stepAcc > 1) {
        this.stepAcc = 0;
        this.noiseBurst(now, 0.05, 0.035, 2500, this.master);
      }
    }
    // heartbeat sense
    if (snap.inner.heartbeat > 0.25) {
      this.beatAcc += dt;
      if (this.beatAcc > 0.9) {
        this.beatAcc = 0;
        const v = 0.15 * snap.inner.heartbeat;
        this.tone(58, now, 0.18, v, this.master, 'sine', 40);
        this.tone(55, now + 0.22, 0.2, v * 0.7, this.master, 'sine', 38);
      }
    }
    // an audible thread toward the strongest sound hint (louder with HEARING)
    const sounds = snap.hints.filter((h) => h.kind === 'sound');
    this.hintTone -= dt;
    if (sounds.length && this.hintTone <= 0 && store.world) {
      const h = sounds.reduce((a, b) => (b.visible > a.visible ? b : a));
      this.hintTone = 1.7;
      if (h.visible > 0.12) {
        const n = store.world.nodes[h.nodeId];
        const e = store.world.edges[h.edgeId];
        const p = e.points[e.a === n.id ? Math.min(e.points.length - 1, 1) : Math.max(0, e.points.length - 2)];
        const out = this.bus(p.x, p.z, Math.min(0.5, h.visible * 0.45));
        this.tone(h.source === 'memory' ? MOTIF[0] : 988, now, 0.9, 0.15, out, 'triangle');
      }
    }
    // purring and the cats of home come closer
    if (store.world) {
      const home = store.world.nodes[store.world.home];
      const d = Math.hypot(home.x - c.x, home.z - c.z);
      const arriving = snap.phase === 'arrival' || (snap.phase === 'summary' && snap.ending === 'home');
      this.purr.gain.value = arriving ? 0.5 : clamp(1 - d / 60) * 0.25 + snap.inner.farHearing * 0.1;
    }
    if (snap.phase !== this.lastPhase) {
      this.lastPhase = snap.phase;
      if (snap.phase === 'arrival') {
        [220, 261.6, 329.6, 493.9].forEach((f, i) => this.tone(f, now + i * 0.15, 5, 0.08, this.send));
        for (let i = 0; i < 6; i++) this.meow(c.x + (Math.random() - 0.5) * 6, c.z + (Math.random() - 0.5) * 6, 0.35, 1 + i * 0.6);
      } else if (snap.phase === 'sleep') {
        [523.3, 440, 392, 329.6, 261.6].forEach((f, i) => this.tone(f, now + i * 0.7, 2, 0.08, this.send));
      } else if (snap.phase === 'intro') {
        this.tone(196, now, 4, 0.06, this.send);
        this.tone(293.7, now + 0.4, 4, 0.05, this.send);
      }
    }
  }
}
