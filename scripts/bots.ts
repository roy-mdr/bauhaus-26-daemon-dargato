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
  let hold = false;
  setInterval(() => {
    if (!state) return;
    t += 0.1;
    const sense = state.role.sense;
    switch (sense) {
      case 'vision':
        send({ t: 'value', v: 0.5 + 0.4 * Math.sin(t * 0.3 + i) });
        break;
      case 'direction':
        send({ t: 'value', v: state.cue.approaching ? Math.sin(t * 0.5 + i * 2) : 0 });
        break;
      case 'memory':
        send({ t: 'value', v: 0.3 + 0.2 * Math.sin(t) });
        if (Math.random() < 0.01) send({ t: 'onset', v: 0.8 });
        break;
      case 'instinct':
        if (Math.random() < 0.25) send({ t: 'tap' });
        if (Math.random() < 0.03) send({ t: 'scratch', v: 0.7 });
        break;
      case 'hearing':
        if (Math.random() < 0.13) send({ t: 'beat', acc: 0.5 + Math.random() * 0.5 });
        break;
      case 'emotion':
        if (Math.random() < 0.02) {
          hold = !hold;
          send({ t: 'hold', on: hold });
        }
        if (Math.random() < 0.004) send({ t: 'flinch' });
        break;
      case 'heartbeat':
        if (Math.floor(t * 10) % 9 === 0) send({ t: 'tap' });
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
