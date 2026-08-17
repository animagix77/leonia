import { clamp } from '../core/util.js';

/* Collision and impact response.

   Traffic is kinematic — NPCs follow lane polylines rather than being fully
   simulated — so nothing used to stop the player driving straight through
   them. This module bolts real contact onto that: oriented-box tests between
   the player's car and every nearby vehicle, an impulse that knocks the NPC
   off its path into free physics, and knockdowns for anyone on foot.

   Everything is 2D in the X/Z plane. Vehicles are boxes, people are circles. */

/** Oriented box for a vehicle. */
export function obbOf(v, spec) {
  return {
    x: v.x, z: v.z,
    hw: (spec.w || 1.8) * 0.5,
    hl: (spec.len || 4.5) * 0.5,
    c: Math.cos(v.heading), s: Math.sin(v.heading),
  };
}

/* Local axes of a box whose heading is measured from +Z:
   forward = (sin h, cos h), right = (cos h, -sin h). */
const axes = (b) => [[b.s, b.c], [b.c, -b.s]];

function project(b, ax) {
  const [fx, fz] = [b.s, b.c];
  const [rx, rz] = [b.c, -b.s];
  const c = b.x * ax[0] + b.z * ax[1];
  const r = Math.abs((fx * ax[0] + fz * ax[1]) * b.hl) +
            Math.abs((rx * ax[0] + rz * ax[1]) * b.hw);
  return [c - r, c + r];
}

/** Separating-axis test. Returns the minimum translation vector, or null. */
export function obbVsObb(a, b) {
  let bestDepth = Infinity, bestAx = null;
  for (const ax of [...axes(a), ...axes(b)]) {
    const [a0, a1] = project(a, ax);
    const [b0, b1] = project(b, ax);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= 0) return null;                 // separating axis found
    if (overlap < bestDepth) { bestDepth = overlap; bestAx = ax; }
  }
  // Point the axis from a toward b.
  let [nx, nz] = bestAx;
  if ((b.x - a.x) * nx + (b.z - a.z) * nz < 0) { nx = -nx; nz = -nz; }
  return { nx, nz, depth: bestDepth };
}

/** Circle (person) against an oriented box (vehicle). */
export function circleVsObb(px, pz, r, b) {
  const dx = px - b.x, dz = pz - b.z;
  const fx = b.s, fz = b.c;
  const rx = b.c, rz = -b.s;
  // into box-local space
  let lz = dx * fx + dz * fz;          // along length
  let lx = dx * rx + dz * rz;          // across width
  const cx = clamp(lx, -b.hw, b.hw);
  const cz = clamp(lz, -b.hl, b.hl);
  const ddx = lx - cx, ddz = lz - cz;
  const d2 = ddx * ddx + ddz * ddz;
  if (d2 > r * r) return null;
  const d = Math.sqrt(d2);
  // Dead centre: there is no separating direction, so push out along the
  // box's own forward axis rather than returning a zero-length normal.
  if (d < 1e-6) return { nx: b.s, nz: b.c, depth: r };
  const nlx = ddx / d, nlz = ddz / d;
  return {
    nx: nlx * rx + nlz * fx,
    nz: nlx * rz + nlz * fz,
    depth: r - d,
  };
}

/* ------------------------------------------------------ vehicle contacts -- */

/**
 * Resolve the player's car against traffic. Mutates both sides.
 * Returns a list of impacts for the caller to score.
 */
export function resolveVehicleContacts(vehicle, traffic, dt, onImpact) {
  const pSpec = vehicle.spec;
  const pBox = obbOf(vehicle, pSpec);
  const pMass = pSpec.mass || 1500;

  // Player velocity in world space (forward + lateral slip).
  const pfx = Math.sin(vehicle.heading), pfz = Math.cos(vehicle.heading);
  const prx = -pfz, prz = pfx;                    // screen-right, matching Vehicle
  const pvx = pfx * vehicle.speed + prx * vehicle.lateral;
  const pvz = pfz * vehicle.speed + prz * vehicle.lateral;

  for (const npc of traffic.npcs) {
    if (!npc.active) continue;
    const dx = npc.x - vehicle.x, dz = npc.z - vehicle.z;
    if (dx * dx + dz * dz > 100) continue;          // 10 m broad phase

    const nBox = obbOf(npc, npc.spec);
    const hit = obbVsObb(pBox, nBox);
    if (!hit) continue;

    const nMass = npc.spec.mass || (npc.kind === 'ebike' ? 110 : 1500);
    const total = pMass + nMass;

    // NPC velocity: along its own heading unless it's already been knocked.
    const nvx = npc.knock ? npc.knock.vx : Math.sin(npc.heading) * npc.speed;
    const nvz = npc.knock ? npc.knock.vz : Math.cos(npc.heading) * npc.speed;

    // Closing speed along the contact normal.
    const rvx = pvx - nvx, rvz = pvz - nvz;
    const closing = rvx * hit.nx + rvz * hit.nz;

    // Separate proportionally to mass so a bus barely moves.
    const pShare = nMass / total, nShare = pMass / total;
    vehicle.x -= hit.nx * hit.depth * pShare * 1.02;
    vehicle.z -= hit.nz * hit.depth * pShare * 1.02;
    npc.x += hit.nx * hit.depth * nShare * 1.02;
    npc.z += hit.nz * hit.depth * nShare * 1.02;

    if (closing <= 0) continue;                     // already separating

    const restitution = 0.22;
    const j = -(1 + restitution) * closing / (1 / pMass + 1 / nMass);

    // Player response, back into its own forward/lateral frame.
    const ipx = (j / pMass) * hit.nx, ipz = (j / pMass) * hit.nz;
    vehicle.speed += ipx * pfx + ipz * pfz;
    vehicle.lateral += ipx * prx + ipz * prz;
    // Off-centre hits rotate you.
    const lever = ((npc.x - vehicle.x) * prx + (npc.z - vehicle.z) * prz);
    vehicle.yawRate += clamp(-lever * closing * 0.010, -1.6, 1.6);

    // NPC gets knocked out of its lane and into free physics.
    knock(npc, -(j / nMass) * hit.nx, -(j / nMass) * hit.nz, closing);

    const severity = Math.abs(closing);
    if (severity > 1.2) {
      vehicle.damage += severity * 1.4;
      vehicle.lastImpact = Math.max(vehicle.lastImpact, severity);
      // The other car is damaged too — it dents, limps, and smokes.
      npc.damage = (npc.damage || 0) + severity * 1.4;
      if (onImpact) {
        onImpact(npc, severity, {
          nx: hit.nx, nz: hit.nz,
          cx: (vehicle.x + npc.x) / 2, cz: (vehicle.z + npc.z) / 2,
        });
      }
    }
  }
}

/**
 * The player's car against parked cars. These used to be welded to the world
 * — you hit one and stopped dead against it like a wall. They're bodies now:
 * a hit shoves them down the kerb, spins them out of their space, and the
 * energy comes off your own speed.
 */
export function resolveParkedContacts(vehicle, parking, world, dt, disturb, onImpact) {
  if (!parking || !parking.hash) return;
  const pSpec = vehicle.spec;
  const pBox = obbOf(vehicle, pSpec);
  const pMass = pSpec.mass || 1500;

  const pfx = Math.sin(vehicle.heading), pfz = Math.cos(vehicle.heading);
  const prx = -pfz, prz = pfx;
  const pvx = pfx * vehicle.speed + prx * vehicle.lateral;
  const pvz = pfz * vehicle.speed + prz * vehicle.lateral;

  const near = parking.hash.query(vehicle.x, vehicle.z, 14);
  for (const car of near) {
    const dx = car.x - vehicle.x, dz = car.z - vehicle.z;
    if (dx * dx + dz * dz > 121) continue;

    const cBox = {
      x: car.x, z: car.z,
      hw: car.spec.w * 0.5, hl: car.spec.len * 0.5,
      c: Math.cos(car.h), s: Math.sin(car.h),
    };
    const hit = obbVsObb(pBox, cBox);
    if (!hit) continue;

    // A parked car is unbraked but it is still a tonne and a half.
    const cMass = (car.spec.mass || 1500) * 1.25;
    const total = pMass + cMass;

    const rvx = pvx - car.vx, rvz = pvz - car.vz;
    const closing = rvx * hit.nx + rvz * hit.nz;

    const pShare = cMass / total, cShare = pMass / total;
    vehicle.x -= hit.nx * hit.depth * pShare * 1.02;
    vehicle.z -= hit.nz * hit.depth * pShare * 1.02;
    car.x += hit.nx * hit.depth * cShare * 1.02;
    car.z += hit.nz * hit.depth * cShare * 1.02;

    if (closing <= 0) continue;

    const restitution = 0.16;                 // parked cars absorb, they don't bounce
    const j = -(1 + restitution) * closing / (1 / pMass + 1 / cMass);

    const ipx = (j / pMass) * hit.nx, ipz = (j / pMass) * hit.nz;
    vehicle.speed += ipx * pfx + ipz * pfz;
    vehicle.lateral += ipx * prx + ipz * prz;

    // Off-centre contact spins it out of the space.
    const lever = (car.x - vehicle.x) * prx + (car.z - vehicle.z) * prz;
    const spin = clamp(-lever * closing * 0.045, -3.0, 3.0);
    disturb(car, -(j / cMass) * hit.nx, -(j / cMass) * hit.nz, spin);

    const severity = Math.abs(closing);
    if (severity > 1.0) {
      vehicle.damage += severity * 1.5;
      vehicle.lastImpact = Math.max(vehicle.lastImpact, severity);
      if (onImpact) {
        onImpact(car, severity, {
          nx: hit.nx, nz: hit.nz,
          cx: (vehicle.x + car.x) / 2, cz: (vehicle.z + car.z) / 2,
        });
      }
    }
  }
}

/** Put an NPC into free physics after being hit. */
export function knock(npc, vx, vz, severity) {
  if (!npc.knock) npc.knock = { vx: 0, vz: 0, vyaw: 0, t: 0, settled: false };
  // ADD the impulse. Subtracting flipped the push back into the striking car,
  // which re-collided every frame and threw the player into reverse.
  npc.knock.vx += vx;
  npc.knock.vz += vz;
  npc.knock.vyaw += (Math.random() - 0.5) * clamp(severity * 0.30, 0, 2.4);
  npc.knock.t = 0;
  npc.knock.settled = false;
  npc.pullState = null;
  npc.speed = 0;
}

/**
 * Advance a knocked vehicle. Returns true once it has come to rest and the
 * caller should hand it back to the traffic AI. If it slides into a parked
 * car, that car takes the hit and rolls too — a chain, not a dead stop.
 */
export function stepKnocked(npc, world, dt, parking, disturb) {
  const k = npc.knock;
  k.t += dt;

  // Rolling friction plus a little air drag.
  const sp = Math.hypot(k.vx, k.vz);
  const decel = 5.2 * dt;
  if (sp > decel) {
    k.vx -= (k.vx / sp) * decel;
    k.vz -= (k.vz / sp) * decel;
  } else { k.vx = 0; k.vz = 0; }
  k.vyaw *= Math.exp(-dt * 2.2);

  let nx = npc.x + k.vx * dt;
  let nz = npc.z + k.vz * dt;

  // Buildings stop them dead.
  const push = world.collideBuildings(nx, nz, Math.max(npc.spec.w, npc.spec.len) * 0.4);
  if (push && push.depth > 0) {
    nx += push.x * push.depth;
    nz += push.z * push.depth;
    k.vx *= 0.2; k.vz *= 0.2;
  }

  /* Parked cars are their own bodies with their own spatial hash — resolve
     them with a real OBB test rather than inferring a hit from the building
     collider, which is what the old collider-index lookup was doing. */
  if (parking && parking.hash && disturb) {
    const probe = {
      x: nx, z: nz,
      hw: npc.spec.w * 0.5, hl: npc.spec.len * 0.5,
      c: Math.cos(npc.heading), s: Math.sin(npc.heading),
    };
    const near = parking.hash.query(nx, nz, 12);
    for (const car of near) {
      const cBox = {
        x: car.x, z: car.z,
        hw: car.spec.w * 0.5, hl: car.spec.len * 0.5,
        c: Math.cos(car.h), s: Math.sin(car.h),
      };
      const hit = obbVsObb(probe, cBox);
      if (!hit) continue;
      nx -= hit.nx * hit.depth * 0.5;
      nz -= hit.nz * hit.depth * 0.5;
      // Hand most of the momentum over and keep sliding a little.
      disturb(car, k.vx * 0.55, k.vz * 0.55, (Math.random() - 0.5) * 0.8, parking);
      k.vx *= 0.45; k.vz *= 0.45;
      break;
    }
  }
  const [cx, cz] = world.clampToWorld(nx, nz, 10);
  npc.x = cx; npc.z = cz;
  npc.heading += k.vyaw * dt;
  npc.y = world.heightAt(npc.x, npc.z);

  return Math.hypot(k.vx, k.vz) < 0.25 && Math.abs(k.vyaw) < 0.15 && k.t > 1.0;
}

/**
 * Knocked vehicles against the rest of traffic — the pile-up path. A car you
 * punt into the oncoming lane now takes the car in that lane with it instead
 * of ghosting through, which is where multi-car chains come from.
 */
export function resolveKnockedContacts(traffic, dt) {
  for (const npc of traffic.npcs) {
    if (!npc.active || !npc.knock) continue;
    const sp = Math.hypot(npc.knock.vx, npc.knock.vz);
    if (sp < 0.6) continue;
    const aBox = obbOf(npc, npc.spec);
    const aMass = npc.spec.mass || 1500;

    for (const other of traffic.npcs) {
      if (other === npc || !other.active || other.knock) continue;
      const dx = other.x - npc.x, dz = other.z - npc.z;
      if (dx * dx + dz * dz > 81) continue;

      const bBox = obbOf(other, other.spec);
      const hit = obbVsObb(aBox, bBox);
      if (!hit) continue;

      const bMass = other.spec.mass || (other.kind === 'ebike' ? 110 : 1500);
      const total = aMass + bMass;
      const bvx = Math.sin(other.heading) * other.speed;
      const bvz = Math.cos(other.heading) * other.speed;
      const closing = (npc.knock.vx - bvx) * hit.nx + (npc.knock.vz - bvz) * hit.nz;

      npc.x -= hit.nx * hit.depth * (bMass / total);
      npc.z -= hit.nz * hit.depth * (bMass / total);
      other.x += hit.nx * hit.depth * (aMass / total);
      other.z += hit.nz * hit.depth * (aMass / total);
      if (closing <= 0) continue;

      const j = -(1 + 0.2) * closing / (1 / aMass + 1 / bMass);
      npc.knock.vx += (j / aMass) * hit.nx;
      npc.knock.vz += (j / aMass) * hit.nz;
      knock(other, -(j / bMass) * hit.nx, -(j / bMass) * hit.nz, closing);
    }
  }
}

/* --------------------------------------------------- people vs vehicles -- */

const PED_R = 0.34;

/**
 * Vehicles against pedestrians. A person struck at speed is knocked down and
 * the player is charged heavily for it — this character's whole claim is that
 * he is the one behaving, and running somebody over ends that argument.
 */
export function resolvePedContacts(vehicle, traffic, world, dt, onHit) {
  const box = obbOf(vehicle, vehicle.spec);
  const fx = Math.sin(vehicle.heading), fz = Math.cos(vehicle.heading);
  const rx = -fz, rz = fx;                        // screen-right, matching Vehicle
  const vx = fx * vehicle.speed + rx * vehicle.lateral;
  const vz = fz * vehicle.speed + rz * vehicle.lateral;
  const speed = Math.hypot(vx, vz);

  for (const ped of traffic.peds) {
    if (!ped.active || ped.down) continue;
    const dx = ped.x - vehicle.x, dz = ped.z - vehicle.z;
    if (dx * dx + dz * dz > 81) continue;

    const hit = circleVsObb(ped.x, ped.z, PED_R, box);
    if (!hit) continue;

    if (speed < 1.2) {
      // Nudging someone at walking pace just shoves them aside.
      ped.x += hit.nx * hit.depth;
      ped.z += hit.nz * hit.depth;
      ped.alarm = Math.max(ped.alarm, 1.2);
      continue;
    }

    /* The launch. Deliberately cartoonish: real pedestrian impacts are not
       something this game wants to render truthfully, and slapstick reads as
       slapstick. Carry exceeds car speed slightly (the shovel effect), the
       pop scales hard with speed for hang-time, and they cartwheel. The
       moral ledger is unchanged — it's still the worst thing you can do. */
    ped.down = true;
    ped.downTime = 0;
    const carry = clamp(speed * 1.15, 2.5, 26);
    ped.vx = (vx / speed) * carry * 0.8 + hit.nx * speed * 0.35;
    ped.vz = (vz / speed) * carry * 0.8 + hit.nz * speed * 0.35;
    ped.vy = clamp(1.2 + speed * 0.55, 1.6, 9.5);
    ped.spin = (Math.random() < 0.5 ? -1 : 1) * clamp(speed * 0.9, 4, 18);
    ped.cartwheel = 0;
    ped.bounced = 0;
    ped.recoverAfter = clamp(5 + speed * 0.6, 6, 16);
    ped.alarm = 2.5;
    vehicle.speed *= 0.94;
    if (onHit) onHit(ped, speed);
  }
}

/* Flight, bounce, slide, lie there, get up. Gravity runs light for hang-time,
   the first landing bounces, and ground friction is a gentle exponential so a
   hard launch ends in a long slide instead of a dead stop. */
export function stepDownedPed(ped, world, dt) {
  ped.downTime += dt;
  ped.vy -= 11.0 * dt;
  ped.x += ped.vx * dt;
  ped.z += ped.vz * dt;
  ped.y += ped.vy * dt;

  const ground = world.heightAt(ped.x, ped.z);
  ped.airborne = ped.y > ground + 0.06;
  if (ped.y <= ground) {
    ped.y = ground;
    if (ped.vy < -3.0 && (ped.bounced || 0) < 2) {
      // Bounce. Twice at most — even cartoons have limits.
      ped.vy = -ped.vy * 0.42;
      ped.bounced = (ped.bounced || 0) + 1;
      ped.spin *= 0.8;
    } else {
      ped.vy = 0;
      ped.vx *= Math.exp(-dt * 3.2);
      ped.vz *= Math.exp(-dt * 3.2);
      ped.spin *= Math.exp(-dt * 4.0);
    }
  }
  const [cx, cz] = world.clampToWorld(ped.x, ped.z, 6);
  ped.x = cx; ped.z = cz;
  ped.tumble = (ped.tumble || 0) + ped.spin * dt;

  // They get back up eventually, once they've stopped moving.
  return ped.downTime > (ped.recoverAfter || 9) && Math.hypot(ped.vx, ped.vz) < 0.25 && !ped.airborne;
}

/* ------------------------------------------- vehicles vs player on foot -- */

/**
 * On foot against parked cars. Once parked cars stopped being registered as
 * buildings they also stopped blocking pedestrians, so the player could walk
 * clean through 24,000 of them. Cheap OBB push-out, no impulse.
 */
export function resolveFootVsParked(player, parking) {
  if (!player.onFoot || !parking || !parking.hash) return;
  const near = parking.hash.query(player.footX, player.footZ, 8);
  for (const car of near) {
    const box = {
      x: car.x, z: car.z,
      hw: car.spec.w * 0.5, hl: car.spec.len * 0.5,
      c: Math.cos(car.h), s: Math.sin(car.h),
    };
    const hit = circleVsObb(player.footX, player.footZ, 0.38, box);
    if (!hit) continue;
    player.footX -= hit.nx * hit.depth;
    player.footZ -= hit.nz * hit.depth;
  }
}

/** A car hitting the player while they're out of the vehicle. */
export function resolveFootContacts(player, traffic, dt, onHit) {
  if (!player.onFoot || player.knockedDown) return;
  for (const npc of traffic.npcs) {
    if (!npc.active) continue;
    const dx = npc.x - player.footX, dz = npc.z - player.footZ;
    if (dx * dx + dz * dz > 81) continue;
    const box = obbOf(npc, npc.spec);
    const hit = circleVsObb(player.footX, player.footZ, 0.38, box);
    if (!hit) continue;

    if (npc.speed < 1.0) {
      player.footX -= hit.nx * hit.depth;
      player.footZ -= hit.nz * hit.depth;
      continue;
    }
    player.knockedDown = true;
    player.downTime = 0;
    player.downVX = Math.sin(npc.heading) * npc.speed * 0.7 - hit.nx * 2;
    player.downVZ = Math.cos(npc.heading) * npc.speed * 0.7 - hit.nz * 2;
    if (onHit) onHit(npc, npc.speed);
    // Carry its real velocity into free physics — knocking with (0,0) made the
    // car that just hit you stop dead in the road on the very next frame.
    knock(npc, Math.sin(npc.heading) * npc.speed * 0.65,
          Math.cos(npc.heading) * npc.speed * 0.65, npc.speed * 0.4);
    return;
  }
}
