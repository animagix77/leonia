/* Every offence here is something the driver DOES, observable from the street.
   Nothing keys off who a person is. That's a design rule, not a formality:
   the AI needs an observable act to detect, the player needs evidence to cite,
   and the trust economy needs a fact to be right or wrong about. */

export const VIOLATIONS = {
  SPEED_MINOR:    { label: 'Speeding',                     detail: '10-19 mph over posted',      fine: 85,  sev: 1, code: '39:4-98' },
  SPEED_MAJOR:    { label: 'Excessive speed',              detail: '20+ mph over posted',        fine: 260, sev: 2, code: '39:4-98' },
  SCHOOL_ZONE:    { label: 'Speeding, school zone',        detail: 'Over the limit near a school',fine: 300, sev: 3, code: '39:4-98.6' },
  RECKLESS:       { label: 'Reckless driving',             detail: 'Weaving, unsafe for conditions', fine: 400, sev: 3, code: '39:4-96' },
  RAN_STOP:       { label: 'Failure to stop',              detail: 'Rolled a posted stop sign',  fine: 180, sev: 2, code: '39:4-144' },
  RAN_RED:        { label: 'Ran a red light',              detail: 'Entered on red',             fine: 200, sev: 2, code: '39:4-81' },
  PHONE:          { label: 'Handheld device',              detail: 'Phone in hand while moving', fine: 200, sev: 2, code: '39:4-97.3' },
  NO_SIGNAL:      { label: 'Failure to signal',            detail: 'Turned without signalling',  fine: 85,  sev: 1, code: '39:4-126' },
  TAILGATE:       { label: 'Following too closely',        detail: 'Under two seconds of gap',   fine: 130, sev: 1, code: '39:4-89' },
  CROSSWALK:      { label: 'Blocking a crosswalk',         detail: 'Stopped across the markings',fine: 100, sev: 1, code: '39:4-138' },
  FTY_PED:        { label: 'Failure to yield to pedestrian',detail: 'Near miss in a crosswalk',  fine: 250, sev: 3, code: '39:4-36' },
  UNREG:          { label: 'Expired registration',         detail: 'Registration lapsed',        fine: 150, sev: 1, code: '39:3-4' },
  SUSPENDED:      { label: 'Driving while suspended',       detail: 'Licence suspended',          fine: 500, sev: 3, code: '39:3-40' },
  NO_PLATE:       { label: 'Obscured plate',               detail: 'Plate missing or covered',   fine: 100, sev: 1, code: '39:3-33' },
  EBIKE_SIDEWALK: { label: 'E-bike on the sidewalk',       detail: 'Motorised bike off roadway', fine: 50,  sev: 1, code: '39:4-14.3' },
  EBIKE_CROSSWALK:{ label: 'E-bike through a crosswalk',   detail: 'Crossed against pedestrians',fine: 75,  sev: 2, code: '39:4-36' },
  EBIKE_SPEED:    { label: 'E-bike over 28 mph',           detail: 'Beyond Class 3 limit',       fine: 90,  sev: 2, code: '39:4-14.3q' },
};

export const SEVERITY_COLOR = { 1: '#e8c15a', 2: '#e8873a', 3: '#e0554a' };

/** How a violation became known. Citations require CONFIRMED evidence. */
export const EVIDENCE = {
  NONE: 0,        // suspected only — citing on this is overreach
  OBSERVED: 1,    // you watched it happen, in view, in range
  SCANNED: 2,     // radar/plate scan produced a record
};

export function fineFor(codes) {
  let total = 0;
  for (const c of codes) total += VIOLATIONS[c]?.fine || 0;
  return total;
}

export function maxSeverity(codes) {
  let s = 0;
  for (const c of codes) s = Math.max(s, VIOLATIONS[c]?.sev || 0);
  return s;
}

/** Live violation evaluation for one NPC, called each tick by the traffic sim. */
export function evaluateDriving(npc, world, ctx) {
  const active = npc.activeViolations;

  // ---- speed vs the posted limit on the segment the NPC is actually on
  const limit = npc.currentLimit || 25;
  const mph = npc.speed * 2.23694;
  const over = mph - limit;

  active.delete('SPEED_MINOR');
  active.delete('SPEED_MAJOR');
  active.delete('SCHOOL_ZONE');
  if (npc.kind === 'ebike') {
    active.delete('EBIKE_SPEED');
    if (mph > 28.5) active.add('EBIKE_SPEED');
  } else {
    if (over >= 20) active.add('SPEED_MAJOR');
    else if (over >= 10) active.add('SPEED_MINOR');
    if (npc.nearSchool && over >= 5) active.add('SCHOOL_ZONE');
  }

  // ---- reckless: sustained big overspeed plus lane weaving
  /* weaveEnergy peaks at exactly p.weave, so a 0.55 gate meant only `reckless`
     (6% of drivers) could ever trigger; `distracted` sat exactly on the
     boundary and `aggressive` could not reach it at all. */
  if (npc.weaveEnergy > 0.40 && over > 15) active.add('RECKLESS');
  else if (over < 8) active.delete('RECKLESS');

  // ---- tailgating
  if (npc.gapAhead !== null && npc.speed > 6 && npc.gapAhead / npc.speed < 1.0) {
    npc.tailgateTime += ctx.dt;
    if (npc.tailgateTime > 1.6) active.add('TAILGATE');
  } else {
    npc.tailgateTime = Math.max(0, npc.tailgateTime - ctx.dt * 2);
    if (npc.tailgateTime === 0) active.delete('TAILGATE');
  }

  /* ---- blocking a crosswalk while stopped
     Only if they are NOT legitimately held at a red, and only once they have
     sat across the markings long enough for it to be a choice rather than
     traffic. Without both tests this fires on every car waiting at a signal
     whose stop line happens to sit near a crossing node. */
  if (npc.speed < 0.8 && npc.onCrossing && !npc.heldAtRed) {
    npc.crosswalkTime = (npc.crosswalkTime || 0) + ctx.dt;
    if (npc.crosswalkTime > 2.2) active.add('CROSSWALK');
  } else {
    npc.crosswalkTime = 0;
    active.delete('CROSSWALK');
  }

  // ---- persistent paperwork offences are set at spawn, not here
  return active;
}

/** Fired once when a discrete event happens (stop run, red light, near miss). */
export function flagEvent(npc, code, ttl = 45) {
  npc.activeViolations.add(code);
  npc.eventExpiry.set(code, ttl);
}

export function decayEvents(npc, dt) {
  for (const [code, t] of npc.eventExpiry) {
    const left = t - dt;
    if (left <= 0) {
      npc.eventExpiry.delete(code);
      npc.activeViolations.delete(code);
    } else {
      npc.eventExpiry.set(code, left);
    }
  }
}
