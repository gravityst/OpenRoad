<p align="center">
  <img src="assets/icon-192.png" width="120" alt="">
</p>

<h1 align="center">Open Road</h1>

<p align="center">
  <a href="https://gravityst.github.io/OpenRoad/"><b>Play it in your browser →</b></a>
</p>

An open-world driving game that runs in a browser. Four kilometres square of
procedurally generated open country — tarmac lanes, gravel stages into the
hills, four race circuits and scattered villages — with traffic, weather,
damage and a day/night cycle. No build step, no network at runtime, no assets
on disk that were not generated in code.

```bash
node tools/checkall.mjs      # run every harness
```

To play it, serve the directory over HTTP and open `index.html`. It needs a
real server only because ES modules will not load from `file://`.

## Controls

| | |
|---|---|
| `W` `S` / arrows | throttle, brake |
| `A` `D` / arrows | steer |
| `Space` | handbrake |
| hold **steer + brake** | drift — builds a slide that recovers on its own |
| `Q` `E` | shift down / up |
| `V` | inspect the damage — orbit the car and see what you broke |
| `-` `=` | steering feel, 0.5x to 2.5x |
| `C` | cycle camera |
| `B` | look back |
| `M` | map |
| `L` | headlights |
| `,` `.` | indicators |
| `R` | put the car back on the road |
| `Esc` | pause |

Gamepad and touch both work; every source is read each frame and the strongest
wins, so plugging in a controller never silently disables the keyboard.

## How it is put together

```
src/world/     the world itself — terrain, road graph, and the ground query
src/physics/   vehicle dynamics and building collision
src/render/    everything you can see
src/ai/        traffic
src/game/      HUD, menus, audio
src/input/     keyboard, gamepad, touch
tools/         the harnesses
```

`src/main.js` builds the world, then loads each rendering and gameplay layer
**dynamically** and substitutes a no-op stub for anything that fails. With
static imports a single broken render module is a white screen and no clue why.
This way a broken sky costs you the sky: the car still drives, the console names
the module, and the boot screen tells you what is missing.

### Coordinate convention

**forward = −Z, right = +X, up = +Y.** Yaw grows counter-clockwise seen from
above. Every direction in the codebase derives from those three facts and
nothing negates a steering input on the way in or out. This is written down
because the previous project used forward = +Z, which puts the car's right at
−X, and that single inconsistency caused reversed steering twice.

## The parts that were hard

**The ground query.** Every wheel asks "how high is the ground here" every
physics step, and the obvious implementations both fail. Picking the nearest
road gives a 3.9 m cliff wherever a dirt track runs beside a lane. Averaging
nearby roads instead sags every junction — 1.74 m at the worst one — because two
roads meeting at a node each claim the other's carriageway. So height is not
derived at runtime at all: the road network is stamped into a height field at
load and the verge is solved as a Laplace membrane, which makes the surface
single-valued by construction. Sampling is bicubic, so the surface is C1 and
there are no slope kinks for the suspension to hammer on.

**The car.** The chassis is deliberately not a free six-degree-of-freedom rigid
body. Position and yaw are integrated in the ground plane, height is a bounded
suspension state, and pitch and roll are derived from the ground normal and load
transfer — so there is no integrator that can wind up and throw the car into the
sky. Jumps are an explicit airborne state with a clear entry condition and a
real ballistic arc.

**Collisions.** One rule: a collision may only ever *remove* energy. Position
correction and velocity correction are strictly separate, and the outgoing
normal speed is always below the incoming. The previous project computed its
restitution impulse from the already-corrected velocity, which turned every
barrier into a rail gun.

## The harnesses

Everything above is asserted, not hoped for. These run headlessly against the
same code the browser runs.

| harness | what it proves |
|---|---|
| `integrationcheck` | every module loads and exports what `main.js` expects |
| `groundcheck` | the surface is continuous, total, and drivable |
| `vehiclecheck` | the car steers the right way and matches a real car's figures |
| `catalogcheck` | every car delivers the numbers the garage quotes |
| `collisioncheck` | buildings are solid and can never add energy |
| `trafficcheck` | traffic stays on its own side and out of itself |
| `carcrashcheck` | car-to-car impacts never manufacture energy either |
| `damagecheck` | damage accumulates, and an undamaged car never cooks itself |
| `debrischeck` | shed parts fall, settle and get cleaned up |
| `driftcheck` | the drift scoring pays for angle and punishes a spin |
| `modelcheck` | imported car models are rigged the way the game assumes |
| `brandcheck` | every name in the game is invented |

They are not a substitute for looking at the screen. They passed happily while
roads rendered from the wrong rows of the texture atlas, and again while traffic
damage was computed every frame and then thrown away without ever being drawn.
A headless check cannot see a dent.

They exist because these are the failures that are invisible until someone
plays for an hour: a 4 cm step in the road that only bites at 140 km/h,
traffic on the wrong side of a lane you rarely drive, a wall that accelerates
you. Three real bugs in the vehicle alone were caught by `vehiclecheck` rather
than by playing, including a missing centripetal term that let the car pirouette
at 2 rad/s while the accelerometer read 0.01 g.

## Names

Every marque, business, district and village is invented. Nothing here borrows a
real trademark, and `brandcheck` keeps it that way.
