# DARGATO

A procedural multiplayer installation game. A dark cat walks home through a foggy,
generated town. Six to ten people use their phones as his senses — VISION, DIRECTION,
MEMORY, INSTINCT, HEARING, EMOTION and a seventh keep-alive sense, HEARTBEAT. They do not
steer him. They change what he notices and prefers, and he decides on his own.
There is one shared goal: get Dargato home.

- **Main display** `/` — third-person view, QR code and join code, no HUD
- **Phones** `/join?c=CODE` — one sense per phone, calibration, manual fallback controls
- **Director** `/director` — host-only control panel (key required)
- **Debug** `/debug` — sensor tests on the device, live phone inputs, bots, generator check

## Quick start (development)

Requires Node.js 20+ (tested with 24).

```bash
npm install
npm run dev
```

- Main display: <http://localhost:5280/> (click once for sound, press **Enter** to start)
- Director: <http://localhost:5280/director> (key `dargato`, printed in the console)
- Phones: scan the QR code on the display. On localhost the QR points to the computer's LAN address.

Phone sensors (camera, microphone, motion on iOS) only work on **HTTPS** pages. For testing
on phones in the local network, run:

```bash
npm run dev:https
```

This serves the client over HTTPS with a self-signed certificate, so each phone has to
accept the warning once. Without HTTPS every role still works through its manual fallback
control.

## Local installation (one host computer)

```bash
npm install
npm run build
npm start                # serves client + game server on http://0.0.0.0:3210
```

Open `http://localhost:3210/` fullscreen on the big screen (press **F**). Open
`/director` in a second window or on a laptop.

## Deployment (VPS behind HTTPS)

The Node server serves the built client, the REST helpers and Socket.IO on one port.
Put any TLS reverse proxy in front of it, and make sure WebSocket upgrades are forwarded.

| env var        | default   | meaning                                                     |
| -------------- | --------- | ----------------------------------------------------------- |
| `PORT`         | `3210`    | HTTP port                                                   |
| `HOST`         | `0.0.0.0` | bind address                                                |
| `DIRECTOR_KEY` | `dargato` | key for `/director` and for bots in `/debug`. **Change it.** |
| `PUBLIC_URL`   | –         | e.g. `https://dargato.example.org`, used for the QR code    |
| `SEED`         | `dargato` | seed of the first world                                     |

Caddy example:

```
dargato.example.org {
  reverse_proxy localhost:3210
}
```

nginx example:

```nginx
location / {
  proxy_pass http://127.0.0.1:3210;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

Phones and the display only talk to the server over WebSockets, never to each other, so
eduroam or venue Wi-Fi with client isolation is fine.

## Phones, permissions and fallbacks

- Permissions are requested only after a tap on the role's enable button.
- **VISION / RED SIGHT**: camera. The phone computes the average brightness of a 32×24
  frame and sends one number. Images never leave the phone. Calibrate with
  "covered = dark" and "pointed at light = bright". Fallback: slider.
- **DIRECTION / WANDERLUST**: device orientation (left/right tilt relative to a calibrated
  "straight"). On iOS the motion permission prompt appears after the tap. Fallback: hold-and-drag pad.
- **MEMORY / ECHO**: microphone. Loudness, onsets (claps, knocks) and regular rhythms are
  detected locally. The room's noise floor is measured first. No audio is recorded or sent.
  Fallback: knock pad (four even knocks = rhythm) and a loudness slider.
- **INSTINCT, EMOTION, HEARING, HEARTBEAT**: touch only.
- The screen is kept awake (Wake Lock) where supported. Phones reconnect automatically and
  get their slot back (default grace: 120 s). While a phone is away, its influence decays smoothly.

## Senses

| # | sense | input | effect on Dargato | variant (players 8–13) |
| - | ----- | ----- | ----------------- | ---------------------- |
| 1 | VISION | camera brightness | reveals route hints, lifts the fog | RED SIGHT: strengthens/weakens red hints |
| 2 | DIRECTION | tilt left/right | biases which street he prefers at junctions | WANDERLUST: homeward ↔ exploration |
| 3 | INSTINCT | taps, scratching | bursts of speed, limited by fatigue | RESTRAINT: caution, slower |
| 4 | EMOTION | hold / release / swipe down | calm → familiar streets, curious → unknown, wary → avoids alleys | REST: rest and recover fatigue |
| 5 | HEARING | tap the pulse side in rhythm | sharper hearing of sounds and hints | FAR EAR: the cats of home become audible (homeward) |
| 6 | MEMORY | claps, knocks, rhythms | a familiar sound from one street draws him | ECHO: loudness strengthens/weakens sound navigation |
| 7 | HEARTBEAT | steady tapping | extends the night (time limit), lamps pulse | – |

Player count:

- **Fewer than 6 players**: missing core senses are simulated (gentle, configurable).
  A simulated sense fades out as soon as a real player takes it over.
- **Player 7**: HEARTBEAT.
- **Players 8–13**: role variants, which use the same input to steer a different setting.
- **More than that**, or in director mode "repeat senses, average inputs": senses repeat and
  the server averages the inputs of everyone sharing a role.

Players can join mid-journey. Every player also gets a small secret wish (for example
"Make Dargato go down a narrow alley"), which can conflict with the shared goal.

## How a journey works

lobby → intro (6 s) → journey → **arrival** (home: a red space where other cats wait) or
**sleep** (the night ends) → summary → back to the lobby with a new world (unless the seed is locked).

- The cat is autonomous. At each junction he scores every street. The score combines a
  homeward instinct (A*/Dijkstra distance), player influences, visible hints, sounds,
  curiosity, calm and caution. It also penalizes streets he has already walked and going
  back. He hesitates longer when the scores are close, and he looks between the options.
- The homeward instinct grows over time and when he is lost. Hints become stronger and
  more truthful. Once the soft limit has passed (default 8 min), there is a final grace
  period (90 s) plus whatever HEARTBEAT has earned (up to 150 s).
- Dargato cannot be steered through buildings. He moves only along the street graph.

## Keyboard (main display)

`Enter` start · `F` fullscreen · `G` debug overlay · `←/→` direction · `↑/↓` vision ·
`Space` instinct tap · `C` (hold) emotion calm · `X` flinch · `M` memory sound · `N` memory
rhythm · `J` hearing beat · `K` heartbeat. These keys can be disabled in the director panel.

## Testing

```bash
npm test               # world generator (200 seeds), session lifecycle, accelerated journeys
npm run typecheck
npm run bots -- 8      # 8 socket-level phone bots against http://localhost:3210
npm run bots -- 10 http://localhost:5280 --churn   # with random disconnects/reconnects
```

`npm test` checks the following for each seed: connectivity, that home is reachable,
determinism (same seed → same graph fingerprint), the presence of loops, dead ends, alleys,
T-junctions, crossroads and curves, and the duration estimate. It then runs headless
journeys with 0, 6 and 10 bots, and 13 bots with a saboteur who always tilts toward the
worst street, holds REST and taps RESTRAINT. Every journey has to end, and normal ones
have to reach home. The lifecycle test covers the night-ending fallback, the HEARTBEAT
extension, the director commands and role assignment.

## Code map

```
shared/   rng, types, protocol, roles + objectives, config, graph (A*, Dijkstra), worldgen
server/   index (HTTP + Socket.IO), session (lifecycle, aggregation, director),
          players (input normalization, rate limits, simulated senses), cat (behaviour),
          routeChoice (junction scoring), hints, narrative (environmental events), objectives
src/display  R3F scene: cityLayout (buildings around the graph), WorldMesh, CatFigure,
             Home, Signs (hints/events), Scene (camera, fog, light, debug), audio (WebAudio)
src/phone    PhoneApp, controls (one per sense), sensors (camera/mic/tilt, local only)
src/director DirectorApp, MapView
src/debug    DebugApp
scripts/  test-worldgen, test-sim, bots
```
