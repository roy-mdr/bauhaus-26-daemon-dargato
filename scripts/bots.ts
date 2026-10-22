// Connects N simulated phones to a running server over Socket.IO, exactly like
// real phones (join, sensor status, normalized inputs, reconnection).
// usage: npm run bots -- <count> [url] [--churn]
import { io, type Socket } from 'socket.io-client';
import type { PhoneInput, PhoneState } from '../shared/protocol';

const count = Number(process.argv[2] ?? 8);
const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:3210';
const churn = process.argv.includes('--churn');

async function getCode(): Promise<string> {
  const r = await fetch(`${url}/api/info`);
  return (await r.json()).code;
}

function bot(i: number, code: string) {
  let token: string | undefined;
  let state: PhoneState | null = null;
  const socket: Socket = io(url, { transports: ['websocket'] });
  const send = (inp: PhoneInput) => socket.emit('input', inp);
  socket.on('connect', () => {
    socket.emit('hello', { kind: 'phone' }, () => {
      socket.emit('join', { code, nickname: `phonebot${i + 1}`, token }, (r: { ok: boolean; error?: string; state?: PhoneState }) => {
        if (!r.ok) return console.log(`bot ${i + 1}: ${r.error}`);
        state = r.state!;
        token = state.token;
        console.log(`bot ${i + 1} joined as ${state.roleName} - wish: ${state.objective.text}`);
        socket.emit('sensor', { sensor: 'bot', state: 'active', calibrated: true });
      });
    });
  });
  socket.on('phone', (s: PhoneState) => (state = s));
  socket.on('ping2', (t: number) => socket.emit('pong2', t));
  socket.on('kicked', (m: string) => console.log(`bot ${i + 1} kicked: ${m}`));
  let t = 0;
  let beatAt = 0;
  setInterval(() => {
    if (!state) return;
    t += 0.1;
    switch (state.role.sense) {
      case 'sight':
        send({ t: 'value', v: 0.5 + 0.3 * Math.sin(t * 0.3 + i) });
        break;
      case 'direction':
        send({ t: 'value', v: 0.6 * Math.sin(t * 0.4 + i * 2) });
        break;
      case 'memory':
        send({ t: 'value', v: 0.5 + 0.3 * Math.sin(t * 0.7) });
        break;
      case 'speed':
        if (Math.sin(t * 0.2 + i) > -0.3) send({ t: 'scratch', v: 0.6 + Math.random() * 0.3 });
        break;
      case 'instinct':
        if (Math.sin(t * 0.15 + i) > 0.7) send({ t: 'shake', v: 0.8 });
        break;
      case 'heartbeat':
        // tap along with the pulse on the big screen
        if (t - beatAt >= 60 / state.cue.tempo) {
          beatAt = t;
          send({ t: 'tap' });
        }
        break;
    }
  }, 100);
  // optional churn: disconnect and reconnect to test reconnection handling
  if (churn) {
    setInterval(() => {
      if (Math.random() < 0.3) {
        console.log(`bot ${i + 1} drops out`);
        socket.disconnect();
        setTimeout(() => socket.connect(), 3000 + Math.random() * 5000);
      }
    }, 20000);
  }
}

getCode()
  .then((code) => {
    console.log(`joining session ${code} at ${url} with ${count} bots${churn ? ' (churn)' : ''}`);
    for (let i = 0; i < count; i++) setTimeout(() => bot(i, code), i * 150);
  })
  .catch((e) => {
    console.error(`cannot reach ${url}: ${e.message}`);
    process.exit(1);
  });
