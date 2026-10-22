# DARGATO

A procedural multiplayer installation game. A dark cat walks home through a foggy,
generated town. Players use their phones as his six senses — SIGHT, SPEED, DIRECTION,
MEMORY, INSTINCT and HEARTBEAT. He moves freely through the streets and reacts to every
sense at once: one player turns him, another moves his paws, another holds the streets
together, another keeps his heart going. There is one shared goal: get Dargato home.

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
- **SIGHT**: camera. The phone computes the average brightness of a 32×24 frame and sends
  one number. Images never leave the phone. Calibrate with "covered = dark" and "pointed at
  light = bright". Fallback: his eye keeps closing, swipe up to hold it open.
- **DIRECTION**: device orientation (left/right tilt relative to a calibrated "straight").
  On iOS the motion permission prompt appears after the tap. Fallback: a touch joystick.
- **MEMORY**: microphone loudness, measured locally above the room's noise floor (measured
  first). No audio is recorded or sent. Fallback: tapping, the faster the louder.
- **INSTINCT**: shaking (device motion). Fallback: scratching the screen side to side.
- **SPEED, HEARTBEAT**: touch only (scratching top to bottom; tapping).
- The screen is kept awake (Wake Lock) where supported. Phones reconnect automatically and
  get their slot back (default grace: 120 s). While a phone is away, its influence decays smoothly.

## Senses

| sense | phone | fallback | effect on Dargato |
| ----- | ----- | -------- | ----------------- |
| SIGHT | camera brightness | swipe up to keep an eye from closing | too dark: the night closes in; too bright: glaring fog; in between he sees clearly |
| SPEED | scratching the screen top to bottom | – | moves his paws; more scratching, faster paws; no scratching, no walking. He only gets anywhere if there is a path |
| DIRECTION | tilt left/right | touch joystick | turns him left or right in real time, also while standing |
| MEMORY | loudness (blow or whisper into the mic) | tapping, faster = louder | sound pulls the particles into paths and the buildings down to the ground; silence scatters the paths, lifts the buildings and he cannot walk |
| INSTINCT | shaking the phone | scratching side to side | the particles of the shortest way home (from where he stands) turn red and flow homeward |
| HEARTBEAT | tapping with the pulse on the main display | – | on the beat the night goes on; no tapping (too slow) or rushing (too fast) strains his heart, and after a few seconds the night ends. The display shows the pulse and a too slow / too fast slider |

Player count:

- **Fewer than 6 players**: the missing senses are simulated (configurable) — a simulated
  DIRECTION roughly follows the way home, SPEED scratches in bursts, MEMORY murmurs with
  moments of silence, HEARTBEAT keeps the pulse. A simulated sense fades out as soon as a
  real player takes it over.
- **More than 6 players**: senses repeat, and the server averages the inputs of everyone
  sharing a sense.

Every sense (played or simulated) also shows up as a small swarm of "thoughts" around
Dargato that moves with its input: SIGHT's rings shrink in the dark and blow wide in the
glare, SPEED throws sparks from his paws, a stream pours toward DIRECTION's side, MEMORY's
ring of dust under him floats apart in silence, INSTINCT's red sparks stream toward home,
and HEARTBEAT throbs at his chest at the rate it is tapped. Every scratch, shake and tap
makes its swarm flare.

Players can join mid-journey. Every player also gets a small secret wish (for example
"Lead him into a dead end to find something"), which can conflict with the shared goal.

## How a journey works

lobby → intro (6 s) → journey → **arrival** (home: an open field of red dots where other cats wait; he has arrived once he is well inside it) or
**sleep** (the night ends) → summary → back to the lobby with a new world (unless the seed is locked).

- Dargato moves freely: he does not stop at junctions, and he can turn at any moment. He
  stays inside the street corridors and junction squares (he slides along their edges and
  feels his way around corners). With nobody turning him, he follows the street he is in.
- On his own he only reacts a little: he glances at red landmarks, sniffs when he dawdles,
  startles at noises and investigates what lies in dead ends.
- Once the soft limit has passed (default 8 min) the way home starts to glow red by itself,
  and after a final grace period (90 s) the night ends. HEARTBEAT can end it much earlier.

## Keyboard (main display)

`Enter` start · `F` fullscreen · `G` debug overlay · `←/→` (hold) direction · `↑` (hold)
speed · `W/S` sight brighter/darker · `M` (hold) memory sound, released = silence · `I`
(hold) instinct · `Space`/`K` heartbeat tap. Keys override the simulated senses for a few
seconds. They can be disabled in the director panel.

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
journeys with 0, 6 and 9 bots (Dargato must never leave the streets, normal journeys have
to reach home), and with a saboteur who rushes the heartbeat (the night must end). The
lifecycle test covers the time limit, the heartbeat endings (too slow, too fast, on the
beat), what MEMORY, DIRECTION, SIGHT and INSTINCT do, the director commands, role
assignment and averaging.

## Code map

```
shared/   rng, types, protocol, roles + objectives, config, graph (A*, Dijkstra), worldgen
server/   index (HTTP + Socket.IO), session (lifecycle, aggregation, director),
          players (input normalization, rate limits, simulated senses),
          cat (free movement inside the streets, small reactions), narrative (environmental events), objectives
src/display  R3F scene: cityLayout (building footprints around the graph), WorldMesh (solids that ground or float with MEMORY),
             StreetParticles (streets as particle paths; MEMORY scatter, INSTINCT red route), CatFigure,
             Home (red dot field), Signs (events), Thoughts (sense particles), Scene (camera, fog, light, debug), audio (WebAudio)
src/phone    PhoneApp, controls (one per sense), sensors (camera/mic/tilt/shake, local only)
src/director DirectorApp, MapView
src/debug    DebugApp
scripts/  test-worldgen, test-sim, bots
```
