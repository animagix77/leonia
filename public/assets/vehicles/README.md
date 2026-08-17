# Authored vehicle models (optional)

The game ships with procedurally generated car bodies. Drop glTF/GLB files in
here with a `manifest.json` and they take over automatically, per vehicle
class. Anything you don't provide keeps using the procedural body.

## manifest.json

```json
{
  "sedan":     { "file": "sedan.glb",  "yawDeg": 180 },
  "suv":       { "file": "suv.glb" },
  "pickup":    "pickup.glb"
}
```

Valid keys are the vehicle classes in `src/game/vehicle.js`:
`sedan, sedanBig, wagon, hatch, coupe, crossover, suv, pickup, van, minivan,
boxtruck, bus`.

- `yawDeg` rotates the model so it faces **+Z**. Use 180 if it arrives
  backwards, ±90 if it faces sideways.
- `scale` is an optional extra multiplier; normally leave it out.

## What the loader does for you

Models arrive at arbitrary scale, origin and facing, so each one is measured
and then rescaled so its long axis matches the class's real length in metres,
re-centred in X/Z, and seated on the ground plane. You do not need to prepare
them.

## Wheels

Any node whose name matches `wheel`, `tyre`, `tire` or `rim` is picked up and
animated (spin, and steering on the front pair). Name them accordingly and
they'll turn; if there are none, the car still drives, the wheels just won't
rotate.

## Sourcing

Use permissively licensed, generic vehicles — CC0 packs are ideal. Avoid
models of real, identifiable production cars: the body designs and badges are
protected, and this project ships its map data under ODbL with attribution, so
keep the asset licensing equally clean. Record whatever the pack's license
requires in this folder.
