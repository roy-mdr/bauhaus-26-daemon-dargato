// DARGATO game server: serves the client, hosts the authoritative simulation,
// and relays state to the main display, phones, director and debug views.
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import type { DevInput, DirectorCommand, PhoneInput, SensorStatus } from '../shared/protocol';
import { Session, type Outbox } from './session';

const PORT = Number(process.env.PORT ?? 3210);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIRECTOR_KEY = process.env.DIRECTOR_KEY ?? 'dargato';
const PUBLIC_URL = process.env.PUBLIC_URL ?? '';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: true }, pingInterval: 5000, pingTimeout: 8000 });

function lanUrls(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  // typical Wi-Fi ranges first; 172.16-31 is often a virtual adapter (WSL, Hyper-V, Docker)
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const CODE_CHARS = 'ACDEFHJKMNPRTUVWXY';
function newCode(): string {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

const room = (code: string, kind: string) => `${kind}:${code}`;

function makeOutbox(getCode: () => string): Outbox {
  return {
    displays: (ev, data) => {
      io.to(room(getCode(), 'display')).emit(ev, data);
      if (ev === 'snap' || ev === 'world' || ev === 'ev') io.to(room(getCode(), 'debug')).emit(ev, data);
    },
    directors: (ev, data) => {
      io.to(room(getCode(), 'director')).emit(ev, data);
      if (ev === 'dir') io.to(room(getCode(), 'debug')).emit(ev, data);
    },
    phone: (socketId, ev, data) => {
      io.to(socketId).emit(ev, data);
    },
    counts: () => {
      const c = getCode();
      const n = (k: string) => io.sockets.adapter.rooms.get(room(c, k))?.size ?? 0;
      return { displays: n('display'), phones: n('phone'), directors: n('director'), debug: n('debug') };
    },
  };
}

// a single active installation session (the director can renew it)
let session: Session;
function createSession(): Session {
  const code = newCode();
  const s = new Session(code, { seed: process.env.SEED ?? 'dargato' }, makeOutbox(() => code));
  s.run();
  return s;
}
session = createSession();

app.get('/api/info', (_req, res) => {
  res.json({ code: session.code, lan: lanUrls(), port: PORT, publicUrl: PUBLIC_URL, phase: session.phase });
});
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), tickMs: session.tickMs, players: session.players.size });
});

if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  // client-side routes
  app.get(/^\/(?!socket\.io|api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('DARGATO server running. In development open the Vite client on port 5280 (npm run dev).'));
}

type ClientKind = 'display' | 'phone' | 'director' | 'debug';

io.on('connection', (socket: Socket) => {
  let kind: ClientKind | null = null;
  let authed = false;

  const joinRooms = () => {
    if (!kind) return;
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
    socket.join(room(session.code, kind));
  };

  socket.on('hello', (msg: { kind: ClientKind; key?: string }, ack?: (r: unknown) => void) => {
    const k = msg?.kind;
    if (!['display', 'phone', 'director', 'debug'].includes(k)) return ack?.({ ok: false, error: 'unknown client' });
    if (k === 'director' && msg.key !== DIRECTOR_KEY) return ack?.({ ok: false, error: 'wrong director key' });
    kind = k;
    authed = k === 'director' || (k === 'debug' && msg.key === DIRECTOR_KEY);
    joinRooms();
    if (k === 'display' || k === 'director' || k === 'debug') {
      socket.emit('world', session.world);
      for (const ev of session.events) socket.emit('ev', ev);
    }
    ack?.({ ok: true, code: session.code, lanUrls: lanUrls(), port: PORT, publicUrl: PUBLIC_URL, authed });
  });

  socket.on('join', (msg: { code?: string; nickname?: string; token?: string }, ack?: (r: unknown) => void) => {
    if (kind !== 'phone') return ack?.({ ok: false, error: 'say hello first' });
    const code = String(msg?.code ?? '').toUpperCase().trim();
    if (code !== session.code) return ack?.({ ok: false, error: 'No journey with that code. Scan the code on the big screen.' });
    const p = session.join(String(msg?.nickname ?? ''), msg?.token ? String(msg.token) : undefined, socket.id);
    joinRooms();
    ack?.({ ok: true, state: session.phoneState(p) });
  });

  socket.on('input', (input: PhoneInput) => {
    if (kind === 'phone') session.input(socket.id, input);
  });
  socket.on('sensor', (status: SensorStatus) => {
    if (kind === 'phone') session.sensorStatus(socket.id, status);
  });
  socket.on('pong2', (sentAt: number) => {
    if (kind === 'phone') session.setPing(socket.id, Date.now() - Number(sentAt));
  });

  socket.on('dev', (d: DevInput) => {
    if (kind === 'display' || authed) session.devInput(d);
  });
  socket.on('displayStart', () => {
    if (kind === 'display' && session.config.displayKeyboard) session.advance();
  });

  socket.on('cmd', (cmd: DirectorCommand) => {
    if (!authed) return;
    if (cmd?.c === 'newSession') {
      const old = session;
      old.stop();
      io.to(room(old.code, 'phone')).emit('kicked', 'A new journey was created. Scan the new code on the big screen.');
      session = createSession();
      session.config = { ...old.config, sensitivity: { ...old.config.sensitivity } };
      // move displays, directors and debug views to the new session
      for (const k of ['display', 'director', 'debug'] as const) {
        io.in(room(old.code, k)).socketsJoin(room(session.code, k));
        io.in(room(old.code, k)).socketsLeave(room(old.code, k));
      }
      io.to(room(session.code, 'display')).emit('world', session.world);
      io.to(room(session.code, 'director')).emit('world', session.world);
      io.to(room(session.code, 'display')).emit('session', session.code);
      return;
    }
    session.command(cmd);
  });

  // phones measure latency
  const pinger = setInterval(() => {
    if (kind === 'phone') socket.emit('ping2', Date.now());
  }, 3000);

  socket.on('disconnect', () => {
    clearInterval(pinger);
    if (kind === 'phone') session.disconnect(socket.id);
  });
});

http.listen(PORT, HOST, () => {
  const lan = lanUrls();
  console.log(`\n  DARGATO server on http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  LAN: http://${ip}:${PORT}`);
  if (PUBLIC_URL) console.log(`  Public URL: ${PUBLIC_URL}`);
  console.log(`  Session code: ${session.code}`);
  console.log(`  Director key: ${DIRECTOR_KEY}${process.env.DIRECTOR_KEY ? '' : '  (default - set DIRECTOR_KEY in production)'}`);
  console.log(`  Routes: /  (main display)   /join  (phones)   /director   /debug\n`);
});
