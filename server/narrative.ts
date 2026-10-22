// Restrained environmental storytelling: a red light far away, a chair seen
// before, a red balloon, a sudden noise, cats calling from home.
import type { Rng } from '../shared/rng';
import type { DiscoveryKind, Landmark, World, WorldEvent, WorldEventKind } from '../shared/types';

export const DISCOVERY_TEXT: Record<DiscoveryKind, string> = {
  'fish-bones': 'fish bones. not his.',
  'red-collar': 'a red collar. was it ever his?',
  'sleeping-cat': 'a sleeping cat. he lets it be.',
  mirror: 'a mirror. a dark cat looks back.',
  yarn: 'a ball of red yarn, unravelled toward nowhere.',
  'empty-bowl': 'an empty bowl. someone waited here once.',
};

export interface NarrativeContext {
  now: number;
  journeyT: number;
  maxDur: number;
  overtime: boolean;
  lost: number;
  cat: { x: number; z: number; heading: number };
  distanceToHome: number;
  emit: (kind: WorldEventKind, x: number, z: number, dur: number, strength: number, text?: string, data?: WorldEvent['data']) => void;
  startle: (x: number, z: number) => void;
}

export class Narrative {
  private nextRedLight = 70;
  private balloonDone = false;
  private nextChorus = 0;
  private nextStartle = 90;
  private dejaVuDone = false;

  constructor(
    private world: World,
    private rng: Rng,
  ) {}

  update(ctx: NarrativeContext) {
    const t = ctx.journeyT;
    const home = this.world.nodes[this.world.home];
    if (t > this.nextRedLight) {
      const urgent = ctx.overtime || ctx.lost > 0.5;
      this.nextRedLight = t + (urgent ? 35 : 100 + this.rng.range(0, 40));
      ctx.emit('distant-red-light', home.x, home.z, 7, urgent ? 1 : 0.6, 'a red light, far away');
    }
    if (!this.balloonDone && t > ctx.maxDur * 0.4) {
      this.balloonDone = true;
      ctx.emit('red-balloon', ctx.cat.x + Math.sin(ctx.cat.heading) * 6, ctx.cat.z + Math.cos(ctx.cat.heading) * 6, 20, 1, 'something red drifts away', { tx: home.x, tz: home.z });
    }
    if (ctx.distanceToHome < 80 && t > this.nextChorus) {
      this.nextChorus = t + 9 + this.rng.range(0, 5);
      ctx.emit('home-chorus', home.x, home.z, 4, 1 - ctx.distanceToHome / 80, this.nextChorus < 20 ? undefined : 'voices of cats');
    }
    if (t > this.nextStartle) {
      this.nextStartle = t + 60 + this.rng.range(0, 60);
      if (this.rng.chance(0.5)) {
        const side = this.rng.chance(0.5) ? 1 : -1;
        const x = ctx.cat.x + Math.cos(ctx.cat.heading) * 5 * side - Math.sin(ctx.cat.heading) * 2;
        const z = ctx.cat.z - Math.sin(ctx.cat.heading) * 5 * side - Math.cos(ctx.cat.heading) * 2;
        ctx.emit('startle', x, z, 1.5, 1);
        ctx.startle(x, z);
      }
    }
  }

  onLandmarkNear(lm: Landmark, ctx: Pick<NarrativeContext, 'emit'>) {
    if (lm.kind === 'roof-cat') ctx.emit('roof-cat', lm.x, lm.z, 5, 1, undefined, { lm: lm.id });
    if (lm.meaning === 'memory' && lm.nodeId !== this.world.start && !this.dejaVuDone) {
      this.dejaVuDone = true;
      ctx.emit('deja-vu', lm.x, lm.z, 6, 1, 'this chair again?', { lm: lm.id });
    }
  }
}
