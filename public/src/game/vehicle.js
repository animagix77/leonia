import * as THREE from 'three';
import { clamp, approach } from '../core/util.js';
import { buildVehicleMesh, setLights } from '../world/carbuilder.js';

/* Arcade bicycle-model car. Tuned for weight and readable slip rather than
   simulation accuracy — you should feel the Palisades grade and be able to
   hold a line at 45 mph on Broad Ave without fighting the wheel. */

/* L = wheelbase, len/w/h = overall metres. `shape` selects the lofted body
   profile in carbuilder.js — that's what actually gives each class a distinct
   silhouette rather than all of them being the same box at different scales. */
export const CAR_SPECS = {
  sedan:     { L: 2.72, w: 1.83, len: 4.72, h: 1.45, mass: 1520, power: 8600,  brake: 15000, topMps: 46, grip: 1.00, shape: 'sedan',     name: 'Sedan' },
  sedanBig:  { L: 2.90, w: 1.90, len: 5.05, h: 1.49, mass: 1760, power: 9600,  brake: 15800, topMps: 47, grip: 0.97, shape: 'sedan',     name: 'Full-size' },
  wagon:     { L: 2.80, w: 1.86, len: 4.90, h: 1.56, mass: 1680, power: 8200,  brake: 14500, topMps: 43, grip: 0.97, shape: 'wagon',     name: 'Wagon' },
  hatch:     { L: 2.52, w: 1.76, len: 4.08, h: 1.49, mass: 1250, power: 7200,  brake: 13500, topMps: 41, grip: 1.02, shape: 'hatch',     name: 'Hatchback' },
  coupe:     { L: 2.64, w: 1.88, len: 4.50, h: 1.31, mass: 1450, power: 13500, brake: 18000, topMps: 58, grip: 1.14, shape: 'coupe',     name: 'Coupe' },
  crossover: { L: 2.72, w: 1.86, len: 4.55, h: 1.66, mass: 1720, power: 8400,  brake: 14800, topMps: 42, grip: 0.94, shape: 'crossover', name: 'Crossover' },
  suv:       { L: 2.95, w: 1.99, len: 5.00, h: 1.82, mass: 2150, power: 9400,  brake: 15500, topMps: 42, grip: 0.90, shape: 'suv',       name: 'SUV' },
  pickup:    { L: 3.40, w: 2.04, len: 5.65, h: 1.94, mass: 2380, power: 10200, brake: 16000, topMps: 44, grip: 0.87, shape: 'pickup',    name: 'Pickup' },
  van:       { L: 3.12, w: 1.96, len: 5.35, h: 2.18, mass: 2240, power: 8000,  brake: 14000, topMps: 38, grip: 0.85, shape: 'van',       name: 'Van' },
  minivan:   { L: 3.00, w: 1.94, len: 5.10, h: 1.82, mass: 2050, power: 8300,  brake: 14400, topMps: 40, grip: 0.88, shape: 'van',       name: 'Minivan' },
  boxtruck:  { L: 3.80, w: 2.30, len: 6.80, h: 2.95, mass: 5200, power: 15000, brake: 22000, topMps: 33, grip: 0.76, shape: 'boxtruck',  name: 'Box truck' },
  bus:       { L: 5.40, w: 2.55, len: 10.8, h: 3.10, mass: 12000, power: 22000, brake: 30000, topMps: 28, grip: 0.72, shape: 'bus',      name: 'Bus' },
};

// Stamp each spec with its own key so the asset loader can match models to classes.
for (const [k, v] of Object.entries(CAR_SPECS)) v.key = k;

/** Everything that turns up in ordinary traffic, weighted toward small cars. */
export const TRAFFIC_SPECS = [
  CAR_SPECS.sedan, CAR_SPECS.sedan, CAR_SPECS.sedan,
  CAR_SPECS.crossover, CAR_SPECS.crossover, CAR_SPECS.crossover,
  CAR_SPECS.suv, CAR_SPECS.suv,
  CAR_SPECS.hatch, CAR_SPECS.hatch,
  CAR_SPECS.wagon, CAR_SPECS.sedanBig,
  CAR_SPECS.pickup, CAR_SPECS.minivan,
  CAR_SPECS.coupe, CAR_SPECS.van,
];

export class Vehicle {
  constructor(world, spec = CAR_SPECS.sedan, x = 0, z = 0, heading = 0) {
    this.world = world;
    this.spec = spec;
    this.x = x;
    this.z = z;
    this.y = world.heightAt(x, z);
    this.heading = heading;       // radians, 0 = +Z (south)
    this.speed = 0;               // m/s along the body axis
    this.lateral = 0;             // sideways slip velocity
    this.steer = 0;               // current front-wheel angle
    this.yawRate = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;
    this.pitch = 0;
    this.roll = 0;
    this.wheelSpin = 0;
    this.damage = 0;
    this.lastImpact = 0;
    this.airborne = false;
    this.vy = 0;
  }

  get mph() { return Math.abs(this.speed) * 2.23694; }

  get forward() {
    return [Math.sin(this.heading), Math.cos(this.heading)];
  }

  /** controls: { throttle -1..1, steer -1..1, brake 0..1, handbrake bool } */
  update(dt, controls) {
    const S = this.spec;
    const throttle = clamp(controls.throttle ?? 0, -1, 1);
    const steerIn = clamp(controls.steer ?? 0, -1, 1);
    const brakeIn = clamp(controls.brake ?? 0, 0, 1);
    this.handbrake = !!controls.handbrake;

    // ---- steering: less lock the faster you go, so it stays controllable
    const speedAbs = Math.abs(this.speed);
    const lockScale = clamp(1 - speedAbs / 52, 0.22, 1);
    const maxLock = 0.62 * lockScale;
    const steerRate = 4.2 + 3.5 * (1 - lockScale);
    this.steer = approach(this.steer, steerIn * maxLock, steerRate * dt);

    // ---- longitudinal forces
    const mass = S.mass;
    let force = 0;

    // Engine torque tapers toward top speed.
    const powerCurve = 1 - clamp(speedAbs / S.topMps, 0, 1) * 0.72;
    if (throttle > 0) force += throttle * S.power * powerCurve;
    else if (throttle < 0) force += throttle * S.power * 0.45 * (1 - clamp(-this.speed / 18, 0, 0.9));

    if (brakeIn > 0) {
      const dir = this.speed > 0 ? -1 : 1;
      if (speedAbs > 0.2) force += dir * brakeIn * S.brake;
      else this.speed = 0;
    }

    // Drag + rolling resistance.
    force -= 0.5 * 1.225 * 0.68 * (S.w * S.h) * this.speed * speedAbs;
    force -= this.speed * 42;

    // Gravity along the slope — this is what makes the Palisades matter.
    const nrm = this.world.normalAt(this.x, this.z, 6);
    const [fx, fz] = this.forward;
    const slopeAlong = -(nrm[0] * fx + nrm[2] * fz) / Math.max(0.2, nrm[1]);
    force += mass * 9.81 * slopeAlong;

    this.speed += (force / mass) * dt;

    // Idle creep so the car doesn't jitter at a dead stop on a grade.
    if (Math.abs(this.speed) < 0.06 && throttle === 0) this.speed = 0;

    // ---- cornering
    const gripBase = S.grip * (this.handbrake ? 0.52 : 1) * (1 - clamp(this.damage / 260, 0, 0.35));
    if (speedAbs > 0.35) {
      /* In this frame forward is (sin h, cos h) and the camera's screen-right
         works out to (-cos h, sin h), so d(forward)/dh points AWAY from
         screen-right — increasing heading turns left. A positive steer input
         (D) must therefore decrease heading, hence the negation. Without it
         the wheel was mirrored: press right, go left. */
      const turnRadiusYaw = -(this.speed / S.L) * Math.tan(this.steer);
      // Understeer: high speed bleeds turn authority. Pulling the handbrake
      // at speed hands some back, so a yank-and-steer actually rotates the
      // car — the drift — instead of ploughing straight on.
      const auth = clamp(1.28 - speedAbs / (62 * gripBase), 0.30, 1.0)
        * (this.handbrake && speedAbs > 6 ? 1.35 : 1);
      const targetYaw = turnRadiusYaw * auth;
      this.yawRate = approach(this.yawRate, targetYaw, 9.5 * dt);

      // Lateral slip builds with cornering load, scrubs off with grip.
      const load = Math.abs(targetYaw) * speedAbs;
      const slipGain = this.handbrake ? 0.42 : 0.14;
      this.lateral += Math.sign(-this.steer) * load * slipGain * dt;
      this.lateral *= Math.exp(-dt * (this.handbrake ? 1.15 : 5.4) * gripBase);
      this.lateral = clamp(this.lateral, -13, 13);
    } else {
      this.yawRate *= Math.exp(-dt * 10);
      this.lateral *= Math.exp(-dt * 10);
    }
    this.heading += this.yawRate * dt;

    // ---- integrate position
    const [nfx, nfz] = this.forward;
    // True screen-right for forward (sin h, cos h). The old (fz, -fx) was the
    // LEFT vector, which mirrored lateral slip and body roll.
    const rx = -nfz, rz = nfx;
    let nx = this.x + (nfx * this.speed + rx * this.lateral) * dt;
    let nz = this.z + (nfz * this.speed + rz * this.lateral) * dt;

    // ---- world bounds
    const [cx, cz] = this.world.clampToWorld(nx, nz, 14);
    if (cx !== nx || cz !== nz) { this.speed *= 0.35; this.lateral = 0; }
    nx = cx; nz = cz;

    // ---- building collision
    const radius = Math.max(S.w, S.len) * 0.42;
    const push = this.world.collideBuildings(nx, nz, radius);
    if (push && push.depth > 0) {
      nx += push.x * push.depth * 1.02;
      nz += push.z * push.depth * 1.02;
      const impactDot = Math.abs(nfx * push.x + nfz * push.z);
      const impact = speedAbs * (0.35 + impactDot * 0.65);
      if (impact > 2.4) {
        this.damage += impact * 1.6;
        this.lastImpact = impact;
        // Where and which way to crumple: push points from the wall into the
        // car, so the metal folds along -push at the contact face.
        this.pendingDent = {
          crushX: -push.x, crushZ: -push.z,
          cx: this.x - push.x * radius * 0.9,
          cz: this.z - push.z * radius * 0.9,
          severity: impact,
        };
      }
      this.speed *= clamp(1 - impactDot * 0.85, 0.06, 0.9);
      this.lateral *= 0.2;
      this.yawRate *= 0.3;
    }

    this.x = nx;
    this.z = nz;

    // ---- terrain following with a little suspension lag
    const ground = this.world.heightAt(this.x, this.z);
    const targetY = ground;
    if (this.y > targetY + 0.35) {
      this.airborne = true;
      this.vy -= 19.6 * dt;
      this.y += this.vy * dt;
      if (this.y <= targetY) { this.y = targetY; this.vy = 0; this.airborne = false; }
    } else {
      this.airborne = false;
      this.vy = 0;
      this.y += (targetY - this.y) * clamp(dt * 13, 0, 1);
    }

    // Body attitude from the terrain normal plus load transfer.
    const nrm2 = this.world.normalAt(this.x, this.z, 5);
    const pitchTerrain = Math.asin(clamp(-(nrm2[0] * nfx + nrm2[2] * nfz), -1, 1));
    const rollTerrain = Math.asin(clamp(-(nrm2[0] * rx + nrm2[2] * rz), -1, 1));
    const accel = force / mass;
    const pitchLoad = clamp(-accel * 0.006, -0.09, 0.09);
    const rollLoad = clamp(this.yawRate * speedAbs * 0.010, -0.13, 0.13);
    this.pitch += (pitchTerrain + pitchLoad - this.pitch) * clamp(dt * 8, 0, 1);
    this.roll += (rollTerrain + rollLoad - this.roll) * clamp(dt * 8, 0, 1);

    this.wheelSpin += (this.speed / 0.34) * dt;
    this.damage = Math.max(0, this.damage - dt * 0.6);
  }

  /** Apply pose to a THREE.Object3D. */
  applyTo(obj) {
    obj.position.set(this.x, this.y, this.z);
    obj.rotation.set(0, 0, 0);
    obj.rotateY(this.heading);
    obj.rotateX(this.pitch);
    obj.rotateZ(this.roll);
  }
}

/* ----------------------------------------------------------------- meshes */

/* Bodies come from the lofted generator in world/carbuilder.js. The real US
   fleet's VALUE distribution is kept — roughly a quarter light, a fifth dark,
   then mid greys — because that is what stops traffic reading as a parade.
   What is dropped is its neutrality: cold blue-whites and true greys sit
   outside the palette and read as untextured against warm facades, so lights
   are warm creams, darks are violet-blacks, and the greys carry a hue. */
const BODY_COLORS = [
  0xdcd3c2, 0xd6ccb8, 0xe0d8c6, 0xcfc6b4,
  0x1e1b26, 0x24202c, 0x191722,
  0xa8a4a8, 0xb2ada8, 0x9c9aa0,
  0x82808c, 0x74727e, 0x8d8a94,
  0x3f5f80, 0x35526b, 0x2f4a63,
  0x93382f, 0x7a3630,
  0x4a5f45, 0x54683e,
  0x9a8a72, 0x7d7466,
];

export function buildCarMesh(spec, colorHex, opts = {}) {
  const g = buildVehicleMesh(spec, colorHex);
  if (opts.name) g.name = opts.name;
  return g;
}

export function randomCarColor() {
  return BODY_COLORS[Math.floor(Math.random() * BODY_COLORS.length)];
}

/** Animate wheels: the outer node steers, the inner node spins. */
export function animateWheels(mesh, vehicle) {
  const wd = mesh.userData;
  if (!wd || !wd.wheels) return;
  const r = wd.wheelR || 0.34;
  // wheelSpin accumulates speed/0.34, so scale back to this wheel's radius.
  const roll = -vehicle.wheelSpin * (0.34 / r);
  // A badly beaten car's wheels stop tracking true.
  const wobble = vehicle.damage > 80 ? Math.sin(vehicle.wheelSpin * 2.1) * 0.09 : 0;
  for (const w of wd.wheels) {
    // Steer sign matches the chassis: positive input turns right on screen.
    w.rotation.y = (w.userData.front ? -vehicle.steer * 0.85 : 0) + wobble;
    if (w.userData.spin) w.userData.spin.rotation.x = roll;
  }
}

export { setLights };
