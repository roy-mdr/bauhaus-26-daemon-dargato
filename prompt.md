DARGATO — Build a Procedural Multiplayer Cat Navigation Game
Mission

Act as a senior creative technologist, game designer, procedural world-generation engineer, multiplayer developer, and interaction designer.

Build a working browser-based multiplayer game called DARGATO for a live installation.

The game features a cat trying to return home through a procedurally generated open world of streets, alleys, intersections, and narrow pedestrian paths.

Six to ten players connect their smartphones to one shared game using a QR code. Each player receives one sensory control role and influences Dargato's perception, movement, or route preferences.

The main display shows a third-person view of the cat moving through the world.

The sole shared objective is to guide Dargato home.

Players can disagree, mislead him, or accidentally make his journey harder. Collective chaos emerges from their conflicting influences, not from separate game modes or complicated victory conditions.

Build a playable application, not just a design document or mockup.

1. Core design

Dargato is a cat who knows the way home but does not remember why he was away.

The players are the thoughts and senses influencing him.

They do not directly control every movement. Dargato has autonomous behavior, reacts to his surroundings, and chooses among possible routes according to his internal state and the players' combined inputs.

The game should feel atmospheric, surreal, quiet, and occasionally absurd.

The world is open and street-based. Do not create caves, indoor rooms, dungeon corridors, underground levels, or a sequence of separate levels.

The session should normally last 5–10 minutes.

The primary installation consists of:

One large screen showing the main game.
One host computer running the game server and display.
Six to ten smartphones acting as controllers.
One host-only director panel. 2. Visual direction

Use a minimalist palette:

Off-white.
Pale gray.
Medium gray.
Dark charcoal.
Near-black.
Restrained red accents.

The environment should have simple geometry, fog, long shadows, empty streets, sparse street furniture, blank building facades, narrow alleys, and occasional red landmarks.

Avoid colorful textures, busy environments, elaborate character models, and conventional game HUDs.

Dargato should be a recognizable dark cat with an expressive silhouette. Use simple geometry or a lightweight model with procedural animation if suitable assets are unavailable.

Implement:

Walking.
Turning.
Pausing.
Sniffing.
Looking toward points of interest.
Reacting to sounds.
Hesitating at junctions.
Becoming curious or frightened.
Recovering after a detour. 3. Third-person camera and presentation

Use a third-person camera positioned behind and slightly above Dargato, with a view that clearly shows nearby streets and the available route choices.

The camera should follow smoothly and keep the cat visible without making the world feel like a conventional action game.

The main screen must show:

Dargato.
The surrounding street network.
Nearby intersections and route options.
Subtle route hints.
The distant or gradually revealed destination.
Occasional memory and environmental events.

Use environmental storytelling instead of a large HUD.

Red light, reflections, paw prints, distant silhouettes, and familiar sounds can suggest a route.

Do not display a permanently visible GPS line or large directional arrow. Players should influence how Dargato perceives the environment rather than simply follow an explicit route marker.

4. Technical stack and architecture

Use:

React.
TypeScript.
Vite.
Three.js with React Three Fiber, or another suitable 3D rendering solution.
Node.js.
Socket.IO or an equivalent WebSocket-based transport.
A server-authoritative game simulation.
An in-memory session store for the initial prototype.

Separate the application into modules for:

World generation.
Street graph and navigation.
Rendering and camera.
Cat behavior.
Input normalization.
Player roles.
Multiplayer communication.
Session management.
Route selection.
Director tools.
Narrative events.
Scoring and diagnostics.

The server owns the authoritative cat position, navigation state, shared internal variables, player roles, and objective completion.

Clients must not independently determine the cat's position or overwrite the shared simulation.

Process camera, microphone, and motion sensor data locally on each phone. Send only normalized measurements or discrete events to the server.

Use a controlled simulation timestep, bounded inputs, and smooth interpolation for movement.

The main display and game server should run on the same host computer for the default local installation. Phones connect over the same Wi-Fi network.

Provide clear instructions for local setup, phone connectivity, browser permissions, and deployment. Support HTTPS where required for sensor access.

5. Multiplayer session

Implement the following lifecycle:

Host creates a session.
Main screen displays a QR code and short joining code.
Players connect using their phone browsers.
Players enter nicknames.
The host sees all connected players.
Each player receives one role.
Players calibrate their controls and see a short explanation.
Host starts the journey.
All inputs influence the same simulation in real time.
The session ends when Dargato reaches home or the maximum session duration is reached.

Support 6–10 simultaneous players in the target configuration.

During development, allow a smaller number of players and provide keyboard controls for testing.

If the number of players exceeds the number of unique roles, assign configurable role variants rather than leaving players without meaningful input.

If a player disconnects, neutralize or gradually decay their influence and allow reconnection.

Do not require accounts, downloads, or installation of native applications.

6. Procedural street-world generation

This is a core feature, not an optional visual variation.

Generate an open, connected network of streets and narrow paths.

The world must contain:

Main streets.
Narrow alleys.
Intersections.
T-junctions.
Crossroads.
Curved paths.
Loops.
Dead ends with optional discoveries.
Pedestrian shortcuts.
Small open squares or wider street junctions.
A starting point.
A home destination.

Do not generate rooms, caves, indoor interiors, or underground environments.

Underlying graph

Represent the world as a graph.

Nodes represent intersections, dead ends, landmarks, and the destination.

Edges represent traversable streets or paths.

Each edge should have properties such as:

Length.
Width.
Surface or visual type.
Traversability.
Landmark visibility.
Route-hint strength.
Optional environmental effects.

Generate the graph before constructing the visible environment.

Ensure that every generated world contains at least one valid path from the starting point to home.

Prefer a connected network with loops and alternative routes so the world feels open rather than like a single branching corridor.

World-generation algorithm

Use a seeded graph-generation algorithm, such as constrained grid-based generation, randomized street growth, or a hybrid approach.

A practical approach is to:

Generate a coarse street grid or irregular network.
Perturb street directions and spacing.
Create intersections and narrow connecting passages.
Add loops and alternate routes.
Choose a starting point and a distant destination.
Validate connectivity.
Assign street widths and visual properties.
Place landmarks and subtle navigation clues.
Construct building facades, walls, fences, and street surfaces around the graph.
Validate that the cat can navigate from the start to home.

Avoid disconnected islands of streets that cannot be reached by the player.

Use a reproducible random seed. The same seed must reproduce the same underlying graph and destination placement.

Visual details may vary within controlled rules, but the navigation graph must remain deterministic for a given seed.

Generate a world large enough to offer multiple plausible routes, but compact enough that a normal session can finish in 5–10 minutes.

Do not equate open world with infinite world. A bounded, procedurally generated town district is sufficient.

7. Procedural layout and pacing

The game should feel like an open town rather than a sequence of scripted levels.

Control pacing through the structure of the generated network.

The beginning should offer a small number of understandable choices.

As Dargato progresses, introduce:

More complex intersections.
Narrower alleys.
Loops.
Alternate shortcuts.
Landmarks with ambiguous meaning.
Subtle red route hints.
Distant sounds.
Occasional dead ends with optional discoveries.

The final portion should make the home destination more recognizable through environmental clues, without simply drawing a direct path to it.

The destination must always be reachable.

Use path distance, route complexity, and progress toward home to estimate the expected session duration.

Tune the generated network for a typical completion time of 5–10 minutes. If Dargato gets lost, the game should gradually provide stronger hints rather than allowing an endless session.

If the group discovers an efficient route, allow an early completion.

8. Navigation and autonomous cat behavior

Dargato must navigate the underlying street graph.

Use a pathfinding algorithm such as A\* to estimate routes toward home and validate possible paths.

The cat should not blindly follow the globally shortest path. His choices should be influenced by the players, environmental interest, and his internal state.

At each junction:

Identify the traversable outgoing routes.
Calculate their estimated costs and progress toward home.
Evaluate player influences.
Evaluate landmarks, sounds, and route hints.
Combine these factors into route preferences.
Select a route or briefly hesitate if influences conflict.
Continue movement along the selected path.

Implement bounded, understandable behavior.

Dargato can take a detour, investigate a landmark, or temporarily move away from home, but he must not wander aimlessly forever.

Use a homeward instinct that gradually increases the preference for routes making progress toward the destination.

Use route-choice hysteresis or a minimum commitment period so tiny input changes do not cause constant direction reversals.

Movement speed should be bounded by fatigue and the INSTINCT role.

The cat must respect path boundaries and must never move through buildings or solid obstacles.

9. Six sensory roles

Every player has exactly one primary role per session.

VISION

Input: camera brightness.

Process camera frames locally and estimate average luminance.

Use normalized brightness to reveal faint route hints, red landmarks, or details on nearby streets.

Higher brightness can increase visibility; lower brightness can make route clues harder to see.

Provide calibration, smoothing, and a manual slider fallback.

Never transmit camera frames.

DIRECTION

Input: device orientation or gyroscope-related controls.

Use the phone's orientation to influence which street Dargato prefers at an intersection.

Do not directly move the cat or bypass navigation constraints.

Calibrate the neutral orientation, smooth the input, and provide a virtual directional control fallback.

MEMORY

Input: microphone.

Analyze volume and simple rhythmic patterns locally.

Distinct sounds can trigger a familiar noise or memory hint associated with one direction or landmark.

Avoid speech transcription.

Do not transmit or store raw recordings.

Provide a manual sound-intensity or rhythm fallback.

INSTINCT

Input: tapping and scratching gestures.

Repeated taps encourage short bursts of movement.

Scratching gestures can temporarily increase movement intensity, subject to fatigue and diminishing returns.

Avoid rewarding unlimited input frequency.

HEARING

Input: touch-based rhythm interaction.

The phone presents simple pulses or directional sound cues. The player responds by tapping.

Successful interaction makes nearby route hints or distant sounds easier for Dargato to perceive.

This role does not require microphone access.

EMOTION

Input: holding, releasing, and short gestures.

Holding a control gradually calms Dargato. Releasing it can encourage curiosity. A separate gesture can increase caution.

Calmness and curiosity affect how strongly Dargato follows familiar paths or investigates uncertain alternatives.

All roles must have a visible, understandable effect on the main game.

If there are more players than unique roles, assign variants such as:

Strengthen or weaken red route hints.
Encourage exploration or homeward progress.
Strengthen or weaken sound-based navigation.
Encourage speed or caution.

Role variants must remain distinct and must not simply duplicate an existing control without adding meaningful influence.

10. Route hints and player agency

The primary gameplay mechanic is route influence.

Players do not create arbitrary new streets during a run. They change which existing routes Dargato notices, prefers, or follows.

Possible hints include:

A red glow at a street corner.
A faint reflection on one path.
Paw prints that appear briefly.
A distant sound coming from an alley.
A familiar silhouette near a junction.
A path becoming clearer through the fog.
A landmark that seems significant but may lead to a detour.

The underlying graph determines which routes are possible.

The visual layer determines which routes appear interesting or promising.

Player inputs affect these hints and the cat's route preferences.

At a junction, two players can influence different routes simultaneously. Dargato resolves the conflict according to the shared simulation.

For example:

VISION reveals a narrow alley.
DIRECTION encourages the main street.
MEMORY triggers a familiar sound from the alley.
INSTINCT encourages faster movement.
EMOTION makes Dargato curious enough to investigate the sound.

The resulting choice should feel like an emergent decision, not a random event.

Keep the route clues subtle. Do not turn the world into a GPS navigation interface.

11. Collective chaos and the shared objective

There is one win condition: Dargato reaches home.

There are no permanent teams, mandatory individual victories, or separate competitive game modes.

Give each player a private, lightweight objective to create conflicting incentives.

Examples:

Reveal three route hints.
Make Dargato investigate an alley.
Encourage three changes of direction.
Keep Dargato moving quickly.
Cause a short detour.
Help him avoid fatigue.
Trigger a memory clue.
Encourage exploration rather than the shortest route.

Private objectives are secondary. They must not replace or obscure the shared goal.

Avoid elaborate scoreboards and complex point systems.

Players can receive a short end-of-session summary of their contributions, but the main display should focus on the journey.

No player should be able to permanently prevent progress. Use bounded effects, cooldowns, and a gradually increasing homeward preference.

If the group becomes stuck, introduce a subtle environmental hint or allow the homeward instinct to become stronger.

12. Session timing and completion

Target a total session length of 5–10 minutes.

Use these approximate pacing targets:

0:00–1:00: starting area and control familiarization.
1:00–3:00: initial street exploration.
3:00–7:00: route choices, detours, and collective conflict.
7:00–10:00: stronger homeward clues and arrival.

These are guidelines, not mandatory timed stages.

End the session immediately when Dargato reaches home and the arrival sequence completes.

Implement a configurable maximum session duration.

If the cat has not arrived before the limit, increase route clarity and homeward preference, allowing the group a final opportunity to guide him home.

Avoid abrupt failure screens. The experience should conclude with a short, atmospheric ending.

13. Story and atmosphere

Keep the story restrained.

Dargato does not need to explain his past.

Use red objects, familiar sounds, repeated street patterns, and environmental details to suggest memories.

The central questions remain:

Where is home?
Why was Dargato away?
What makes this place familiar?

The story should remain secondary to navigation.

Implement a small set of optional environmental events, such as a red light that appears in the distance, a familiar sound from an alley, or a street that resembles an earlier location.

These events can make the journey feel meaningful without introducing separate objectives or lengthy cutscenes.

14. Director panel

Create a host-only interface that allows the installation operator to:

Create and reset sessions.
Set the procedural seed.
Regenerate the street network.
Adjust fog, lighting, and route-hint visibility.
Adjust cat movement speed.
Adjust sensor sensitivity.
View player roles and connection status.
Inspect current route preferences and internal state.
Trigger a route hint.
Trigger a memory event.
Move Dargato to a valid graph node for testing.
Pause or resume the session.
Trigger the ending for testing.
View a debug overlay of the street graph and current planned route.

The director should be able to run a basic experience without modifying code.

Keep the debug overlay hidden during normal play.

15. Phone interfaces and browser permissions

Each phone should display only its assigned control.

The controller includes:

Role name.
One-sentence instruction.
Private objective.
Immediate input feedback.
Sensor status.
Calibration controls where necessary.
Connection status.
Fallback controls when sensors are unavailable.

Support portrait orientation.

Request camera, microphone, or motion permissions only when required and after a clear user action.

Process raw sensor data locally. Send only normalized values and discrete events to the server.

Provide sensible fallbacks when permissions are denied or APIs are unsupported.

Use HTTPS where necessary for deployment and document any local-development requirements.

Do not require a particular phone model.

16. Acceptance criteria

The project is complete only when the following are demonstrated in a running application.

Multiplayer
A host can create a session and display a QR code.
Six to ten smartphones can join the same session.
Every player receives one distinct role or configured role variant.
Simultaneous inputs from multiple players affect the same shared simulation.
A disconnected player does not stop the game.
World and navigation
The game displays a third-person view of Dargato.
The environment is an open, street-based world with no caves, rooms, or indoor levels.
The procedural generator produces streets, narrow paths, intersections, loops, and alternate routes.
Every generated world has a valid route from the starting point to home.
The same seed reproduces the same underlying street graph.
Dargato respects the navigation graph and does not pass through solid geometry.
The cat can take a detour but cannot become permanently stuck.
The home destination can be reached through normal gameplay.
Gameplay
At least four sensor or touch roles work in the initial playable milestone.
All six roles work in the expanded prototype.
Inputs influence route hints, route preferences, movement, or perception.
Conflicting inputs produce coherent and bounded behavior.
The only shared win condition is reaching home.
A normal session can be completed in 5–10 minutes.
The game responds to sensor denial with usable fallback controls.
Installation and operation
The host can pause, reset, and restart a session.
The director can change the seed and inspect the generated map.
The project includes working installation and startup instructions.
Core features have been tested in the running application, not merely represented by placeholder interfaces. 17. Implementation order

Build the game incrementally.

Phase 1: The complete core loop

Implement:

A small procedural street graph.
A third-person cat.
Autonomous navigation toward home.
A single route-choice junction.
A shared game server.
A session lobby.
Two real phone controllers.
A working homecoming sequence.

The goal is to complete a short journey from start to finish.

Phase 2: Installation-ready multiplayer

Add:

QR-code joining.
Six to ten simultaneous players.
Four functional controller roles.
Conflicting route influences.
Sensor calibration and fallbacks.
The director panel.
Phase 3: Full procedural world

Add:

Larger street networks.
Loops and alternate routes.
More environmental variations.
All six roles and role variants.
Dynamic route hints.
Session duration tuning.
Phase 4: Polish

Add:

Better cat animation.
Atmospheric fog and lighting.
Sound cues.
More nuanced navigation behavior.
Optional memory events.
Improved reconnection handling.
Installation diagnostics.

Test the multiplayer session early. Do not postpone the shared game state or real phone controls until the end.

Final principle

Dargato is trying to get home.

The world is a strange, quiet network of streets, and the players are the competing thoughts that help him find his way.

They do not need to complete quests, conquer enemies, or understand a complicated story. They need to find a route, influence a cat, and deal with the consequences of their collective decisions.

Build a procedurally generated street journey in which ten people can help one cat get home, even when they disagree about which way home is.
