import { io, type Socket } from 'socket.io-client';

/** connects to the game server on the same origin (Vite proxies /socket.io in development) */
export function connect(): Socket {
  return io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });
}

export function hello<T = { ok: boolean; error?: string; code?: string; lanUrls?: string[]; port?: number; publicUrl?: string; authed?: boolean }>(
  socket: Socket,
  kind: 'display' | 'phone' | 'director' | 'debug',
  key?: string,
): Promise<T> {
  return new Promise((resolve) => socket.emit('hello', { kind, key }, (r: T) => resolve(r)));
}

/** URL phones should open. Uses PUBLIC_URL when set, otherwise the LAN address when the display runs on localhost. */
export function joinUrl(code: string, info: { lanUrls?: string[]; publicUrl?: string }): string {
  if (info.publicUrl) return `${info.publicUrl.replace(/\/$/, '')}/join?c=${code}`;
  const loc = window.location;
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(loc.hostname);
  const host = isLocal && info.lanUrls?.length ? info.lanUrls[0] : loc.hostname;
  const port = loc.port ? `:${loc.port}` : '';
  return `${loc.protocol}//${host}${port}/join?c=${code}`;
}
