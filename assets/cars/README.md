# Dropping a car into Open Road

This folder is where imported car models live. Put a `.glb` in here, name its
parts the way this page describes, and the game drives it instead of the one it
draws in code — with working steering, suspension, lights, damage and parts that
fall off.

Nothing here is required. With this folder empty the game builds every car
procedurally, which is exactly what it does today.

> **One setup step first.** `vendor/three/addons/` does not currently include
> `loaders/GLTFLoader.js`, so nothing can be read yet. Copy `GLTFLoader.js` from
> the three.js r185 addons into `vendor/three/addons/loaders/` and imported cars
> switch on with no code change. Until then every load quietly returns nothing
> and the procedural cars are used, which is by design — a missing asset must
> never break the game.

---

## 1. Which way the car faces

**The nose points down -Z. Up is +Y. The driver's side is -X.**

```
                 -Z  (forward, the nose)
                  ↑
      -X  ←───────┼───────→  +X
   (driver's      │        (passenger's
     side)        ↓            side)
                 +Z  (the boot)
```

So `wheel_FL` sits at negative x and negative z, and `bumper_rear` sits at
positive z. This matches the physics and the code-drawn cars exactly.

If your model faces +Z the game will notice — it compares the front and rear
bumpers, then the head and tail lamps, then the wheel labels — and turn it
around, logging a note when it does. Authoring to -Z is still better: the
guess is only as good as your part names.

## 2. What to name things

Names are matched **case-insensitively and without punctuation**, and a name
that merely *starts* with one of these also matches. `wheel_FL`, `Wheel.FL`,
`WHEEL-FL` and `wheel_FL.001` are all the same node, and `boot_lid` resolves to
`boot`. Exporter suffixes are harmless.

### The shell

| Node | What it is |
|---|---|
| `body` | The painted shell — everything not listed separately below. |

### Wheels

| Node | |
|---|---|
| `wheel_FL` | front left |
| `wheel_FR` | front right |
| `wheel_RL` | rear left |
| `wheel_RR` | rear right |

Your own pivots do not matter. Each wheel is re-parented onto a pivot placed at
the wheel's own measured centre, so wheels modelled around the world origin
still steer and spin correctly.

### Glass

| Node | Breaks as |
|---|---|
| `glass_windscreen` | windscreen |
| `glass_rear` | rear screen |
| `glass_sideL` | driver's side |
| `glass_sideR` | passenger's side |

### Lights

| Node | |
|---|---|
| `light_headL`, `light_headR` | headlights |
| `light_tailL`, `light_tailR` | tail lights |

### Parts that fall off

| Node | |
|---|---|
| `mirror_L`, `mirror_R` | door mirrors |
| `bumper_front`, `bumper_rear` | bumpers |
| `bonnet`, `boot` | bonnet and boot lid |
| `door_L`, `door_R` | doors |
| `exhaust` | tailpipe |
| `spoiler` | rear wing |

### Optional extras

| Node | If you leave it out |
|---|---|
| `light_brakeL`, `light_brakeR` | the tail lights brighten under braking instead |
| `light_reverseL`, `light_reverseR` | no reversing lights |
| `light_indL`, `light_indR` | no indicators |
| `seat_driver` | an empty at the driver's eye point; the cockpit camera estimates it instead |

**Every one of these is optional.** A missing node is reported once in the
console and then skipped — a car with no `spoiler` simply has no spoiler to
lose. There are only two files the game refuses outright, and in both cases it
falls back to the procedural car and says so in the console:

- one with no `body` *and* fewer than two wheels, because that is not a rig; and
- one whose nodes are all named correctly but have **no geometry under them** —
  an armature-only export, or one whose meshes did not come across.

## 3. Materials

- **Name the paint material `paint`.** That is the one the game recolours per
  car. If no material is named `paint`, whatever material the `body` node uses
  is recoloured instead.
- The car's colour is **multiplied** into that material, so a paint material
  wants no base texture, or a white-to-pale one. A fully coloured livery texture
  will be tinted rather than replaced.
- **Give each kind of lamp its own material** — one for the headlights, one for
  the tail lights, and so on. Two kinds sharing a material cannot be lit
  separately, and the game will tell you so. Lamp materials need an emissive
  channel (any standard or physical material has one); the game supplies a glow
  colour if yours is black and drives the brightness itself.
- Everything else — tyres, trim, glass, interior — is shared between every copy
  of the car on screen, so keep the material count low.

## 4. Scale, units and the ground

Author at real size in metres if you can, but you do not have to: the model is
scaled **uniformly** so that the distance between its front and rear wheel
centres matches the car's wheelbase in `src/vehicles/catalog.js`. A model
authored in centimetres comes out right. Only the wheels are measured, so if
your model has none, the scale is guessed from overall length and you get a
warning.

The scale is uniform on purpose. Stretching sideways to match the physics track
width would turn every wheel into an ellipse, so if the model's track is far
from the catalogue's you are told about it instead.

You do not need to place the car vertically. It is moved so the bottom of the
tyres lands on the road and the axle midpoint sits at the origin.

## 5. File format

- `.glb` (binary), self-contained. No external `.bin` or texture files.
- **Uncompressed.** Draco and KTX2 need a decoder that ships separately and
  fetches at runtime, which this game does not do. If you need them, pass your
  own configured loader into `createModelLibrary({ loader })`.
- Keep it modest. There can be forty cars on screen; a million triangles each is
  forty million triangles.
- Textures are put into the right colour space on load, so an export that got
  that wrong is corrected rather than looking subtly dark.

## 6. Every name must be invented

Every marque, model, sponsor, number plate and piece of signage in this game is
made up, and `tools/brandcheck.mjs` enforces it. Do not model a real car, do not
put a real company's badge on it, and do not name the file after one.

## 7. Adding a car, start to finish

1. Model it facing **-Z**, with the parts named as above.
2. Name the paint material `paint`; give each lamp kind its own material.
3. Export a single self-contained, uncompressed `.glb`.
4. Save it here as `<car id>.glb` — the id from `src/vehicles/catalog.js`, so
   `lark.glb`, `kaze.glb`, `v340.glb` and so on.
5. Reload the game. That is the whole of it: the library looks for
   `assets/cars/<id>.glb` by default and falls back to the procedural car when
   it is not there.
6. Run `node tools/checkall.mjs`, then check the browser console. Any part you
   named wrong is listed there by name.

The convention is also exported in code as `RIG` from `src/render/models.js`,
and `tools/modelcheck.mjs` asserts that this page and that constant agree.
