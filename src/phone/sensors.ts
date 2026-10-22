// Local sensor processing on the phone. Only normalized numbers or discrete
// events leave this module: no camera frames, no audio, no raw orientation.

export type SensorState = 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported' | 'fallback';

export const secureContext = typeof window !== 'undefined' && window.isSecureContext;

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

// ---------------- camera brightness ----------------

export class CameraLuminance {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas = document.createElement('canvas');
  private timer = 0;
  raw = 0;
  smooth = 0;
  dark = 0.04;
  bright = 0.75;
  onValue: (v: number) => void = () => {};

  async start(): Promise<SensorState> {
    if (!navigator.mediaDevices?.getUserMedia) return secureContext ? 'unsupported' : 'denied';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 160 }, height: { ideal: 120 } }, audio: false });
    } catch (e) {
      return (e as Error).name === 'NotAllowedError' ? 'denied' : 'unsupported';
    }
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.srcObject = this.stream;
    await v.play().catch(() => {});
    this.video = v;
    this.canvas.width = 32;
    this.canvas.height = 24;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.timer = window.setInterval(() => {
      if (!this.video || this.video.readyState < 2) return;
      ctx.drawImage(this.video, 0, 0, 32, 24);
      const d = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      this.raw = sum / (d.length / 4);
      const norm = clamp((this.raw - this.dark) / Math.max(0.05, this.bright - this.dark));
      this.smooth += (norm - this.smooth) * 0.3;
      this.onValue(this.smooth);
    }, 100);
    return 'active';
  }

  calibrateDark() {
    this.dark = this.raw;
    if (this.bright < this.dark + 0.1) this.bright = Math.min(1, this.dark + 0.3);
  }
  calibrateBright() {
    this.bright = Math.max(this.raw, this.dark + 0.1);
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

// ---------------- microphone ----------------

export class MicListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private buf = new Float32Array(1024);
  floorDb = -60;
  level = 0;
  /** dB of range above the room's floor that maps to full loudness (lower = more sensitive) */
  rangeDb = 40;
  private calibrating = 0;
  private calSamples: number[] = [];
  onLevel: (v: number) => void = () => {};

  async start(): Promise<SensorState> {
    if (!navigator.mediaDevices?.getUserMedia) return secureContext ? 'unsupported' : 'denied';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    } catch (e) {
      return (e as Error).name === 'NotAllowedError' ? 'denied' : 'unsupported';
    }
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.calibrate();
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
    return 'active';
  }

  /** measure the room's noise floor for ~2 seconds */
  calibrate() {
    this.calibrating = performance.now() + 2000;
    this.calSamples = [];
  }
  get isCalibrating() {
    return performance.now() < this.calibrating;
  }

  private tick() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-8);
    const now = performance.now();
    if (now < this.calibrating) {
      this.calSamples.push(db);
      const sorted = [...this.calSamples].sort((a, b) => a - b);
      this.floorDb = Math.min(-25, sorted[Math.floor(sorted.length * 0.7)] ?? -60);
      return;
    }
    // loudness above the room; quick to rise, a little slower to fall
    const lv = clamp((db - this.floorDb - 3) / this.rangeDb);
    this.level += (lv - this.level) * (lv > this.level ? 0.3 : 0.08);
    this.onLevel(this.level);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
  }
}

// ---------------- orientation ----------------

type IOSOrientationEvent = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

export class TiltSensor {
  private handler: ((e: DeviceOrientationEvent) => void) | null = null;
  neutral = 0;
  gamma = 0;
  smooth = 0;
  range = 35;
  private got = false;
  onValue: (v: number) => void = () => {};

  async start(): Promise<SensorState> {
    if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
    const DOE = DeviceOrientationEvent as IOSOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const r = await DOE.requestPermission();
        if (r !== 'granted') return 'denied';
      } catch {
        return 'denied';
      }
    }
    this.handler = (e) => {
      if (e.gamma === null) return;
      this.got = true;
      // compensate when the phone is held in landscape
      const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
      let tilt = e.gamma;
      if (angle === 90) tilt = -(e.beta ?? 0);
      else if (angle === -90 || angle === 270) tilt = e.beta ?? 0;
      this.gamma = tilt;
      const x = clamp((tilt - this.neutral) / this.range, -1, 1);
      const dz = Math.abs(x) < 0.08 ? 0 : x;
      this.smooth += (dz - this.smooth) * 0.25;
      this.onValue(this.smooth);
    };
    window.addEventListener('deviceorientation', this.handler);
    // some desktop browsers expose the API but never fire it
    await new Promise((r) => setTimeout(r, 1200));
    return this.got ? 'active' : 'unsupported';
  }

  calibrate() {
    this.neutral = this.gamma;
  }

  stop() {
    if (this.handler) window.removeEventListener('deviceorientation', this.handler);
    this.handler = null;
  }
}

// ---------------- shaking ----------------

type IOSMotionEvent = typeof DeviceMotionEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

/** how hard the phone is being shaken, 0..1 (acceleration without gravity) */
export class ShakeSensor {
  private handler: ((e: DeviceMotionEvent) => void) | null = null;
  private got = false;
  level = 0;
  onValue: (v: number) => void = () => {};

  async start(): Promise<SensorState> {
    if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
    const DME = DeviceMotionEvent as IOSMotionEvent;
    if (typeof DME.requestPermission === 'function') {
      try {
        if ((await DME.requestPermission()) !== 'granted') return 'denied';
      } catch {
        return 'denied';
      }
    }
    let last: { x: number; y: number; z: number } | null = null;
    this.handler = (e) => {
      // linear acceleration when available, otherwise the change of the gravity-included value
      const a = e.acceleration;
      let mag = 0;
      if (a && a.x !== null) mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
      else if (e.accelerationIncludingGravity?.x != null) {
        const g = e.accelerationIncludingGravity;
        const cur = { x: g.x ?? 0, y: g.y ?? 0, z: g.z ?? 0 };
        if (last) mag = Math.hypot(cur.x - last.x, cur.y - last.y, cur.z - last.z);
        last = cur;
      } else return;
      this.got = true;
      // a firm shake is ~15-25 m/s²; small hand tremor stays below ~2
      const v = clamp((mag - 2) / 16);
      this.level = Math.max(v, this.level * 0.9);
      this.onValue(this.level);
    };
    window.addEventListener('devicemotion', this.handler);
    await new Promise((r) => setTimeout(r, 1200));
    return this.got ? 'active' : 'unsupported';
  }

  stop() {
    if (this.handler) window.removeEventListener('devicemotion', this.handler);
    this.handler = null;
  }
}

export function vibrate(ms: number | number[]) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported (iOS) */
  }
}

export async function keepAwake(): Promise<() => void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const lock = await nav.wakeLock?.request('screen');
    return () => {
      lock?.release().catch(() => {});
    };
  } catch {
    return () => {};
  }
}
