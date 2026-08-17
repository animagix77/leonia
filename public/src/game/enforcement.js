import { clamp, MPS_TO_MPH } from '../core/util.js';
import { VIOLATIONS, EVIDENCE, fineFor, maxSeverity } from './violations.js';

/* The rules of the job.

   You are not a cop. You have no authority to detain and no qualified
   immunity, and the game models that: a stop you can't justify costs you
   standing in town, and standing is the only thing that makes the next stop
   work.

   The central object is EVIDENCE, and the important property is that it is a
   RECORD OF A PAST ACT, not a query against the driver's present state. A car
   doing 44 that pulls over for you is doing 0 by the time you reach the
   window; if evidence were live state it would evaporate at exactly the moment
   you need it, and the player would be punished for the game's bookkeeping. */

const OBSERVE_RANGE = 78;
const OBSERVE_CONE = Math.cos(0.62);      // ~35° half-angle
const RADAR_RANGE = 160;
const RADAR_CONE = Math.cos(0.13);        // tight — you have to aim
const RADAR_LOCK_TIME = 0.55;
const PULLOVER_RANGE = 40;
const APPROACH_RANGE = 11;

// Offences whose proof is a document, not a sight-line.
const PAPERWORK = new Set(['UNREG', 'SUSPENDED', 'NO_PLATE']);
const SPEED_CODES = new Set(['SPEED_MINOR', 'SPEED_MAJOR', 'SCHOOL_ZONE', 'EBIKE_SPEED']);

export class Enforcement {
  constructor(world, traffic) {
    this.world = world;
    this.traffic = traffic;

    this.trust = 50;
    /* Accidents bottom out here rather than at zero. Twelve is low enough to
       be genuinely alarming — the meter is visibly nearly spent — and high
       enough that the run continues and can be earned back. */
    this.COLLISION_TRUST_FLOOR = 12;
    this.pedStrikes = 0;
    this.overreach = 0;
    this.heat = 0;
    this.funds = 240;
    this.stops = 0;
    this.citations = 0;
    this.badStops = 0;
    this.log = [];
    this.clock = 0;

    this.radarActive = false;
    this.radarLock = 0;
    this.radarTarget = null;
    this.lastScan = null;
    this.scanArmed = true;

    this.target = null;
    this.pendingCitation = null;
    this.toast = null;
    this.toastTime = 0;

    // Floating "+8 CIVIC TRUST — evidenced citation" feedback.
    this.deltas = [];
    // Discrete "you just watched that happen" cards.
    this.events = [];

    /* Plate history. This is what turns restraint into leverage: a driver you
       warned who turns up doing it again is a documented pattern, not a
       judgement call, and the second stop is worth more and risks less. */
    this.history = new Map();     // plate -> { warned, cited, seen, offences:Set, lastAt }
    this.watchlist = [];          // drivers who may come back around

    this.playerSpeedingTime = 0;
    this.speedWarnCooldown = 0;
  }

  // ------------------------------------------------------------- feedback
  say(text, tone = 'info', ttl = 3.4) {
    this.toast = { text, tone };
    this.toastTime = ttl;
  }

  /** Every stat change goes through here so the player always sees the why. */
  /* `floor` is the lower bound this particular penalty may drive the meter to.
     It exists so that an accident cannot end the run on its own: collisions
     pass a floor, deliberate misuse of the badge you do not have does not.
     Losing on trust is meant to come from citing people you have nothing on —
     that is the designed failure state — not from clipping a parked car. A
     penalty against a meter already below its floor simply does nothing. */
  adjust(field, delta, reason, floor = 0) {
    if (!delta) return;
    const before = this[field];
    this[field] = clamp(this[field] + delta, floor, field === 'funds' ? 1e9 : 100);
    // Never let a floored penalty push the meter UP toward its floor.
    if (delta < 0 && this[field] > before) this[field] = before;
    const real = this[field] - before;
    if (Math.abs(real) < 0.01) return;
    // Merge rapid repeats of the same reason (e.g. the speeding bleed).
    const last = this.deltas[this.deltas.length - 1];
    if (last && last.field === field && last.reason === reason && last.t > 0.9) {
      last.delta += real;
      last.t = 2.0;
      return;
    }
    this.deltas.push({ field, delta: real, reason, t: 2.0 });
    if (this.deltas.length > 5) this.deltas.shift();
  }

  pushEvent(kind, title, detail, tone = 'watch') {
    this.events.push({ kind, title, detail, tone, t: 3.6 });
    if (this.events.length > 3) this.events.shift();
  }

  addLog(entry) {
    this.log.unshift({ ...entry, t: Date.now() });
    if (this.log.length > 40) this.log.pop();
  }

  // ------------------------------------------------------------ evidence
  /** Record an observed or scanned fact about a driver. Idempotent per code. */
  record(npc, code, lvl, extra = {}) {
    const prev = npc.evidence.get(code);
    if (prev && prev.lvl >= lvl) return false;
    npc.evidence.set(code, {
      lvl,
      at: this.clock,
      mph: extra.mph ?? null,
      limit: extra.limit ?? null,
      road: extra.road ?? npc.currentRoadName ?? null,
    });
    return !prev;    // true only the first time we learn of it
  }

  /** Anything you can see, you can testify to. */
  updateObservation(dt, player, camDir) {
    for (const { npc } of this.traffic.near(player.x, player.z, OBSERVE_RANGE)) {
      const dx = npc.x - player.x, dz = npc.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      if ((dx / len) * camDir.x + (dz / len) * camDir.z < OBSERVE_CONE) continue;
      if (this._blocked(player.x, player.z, npc.x, npc.z)) continue;

      npc.observedTime = (npc.observedTime || 0) + dt;

      for (const code of npc.activeViolations) {
        // Paperwork is invisible from the street; it needs a plate scan.
        if (PAPERWORK.has(code)) continue;
        // A number needs the radar. Egregious speed is obvious to anyone.
        if (code === 'SPEED_MINOR') continue;
        if (SPEED_CODES.has(code) && (npc.observedTime || 0) < 0.9) continue;

        const fresh = this.record(npc, code, EVIDENCE.OBSERVED, {
          mph: npc.speed * MPS_TO_MPH,
          limit: npc.currentLimit,
        });
        if (fresh) {
          const v = VIOLATIONS[code];
          this.pushEvent('watch', v.label,
            `${npc.plate} · ${npc.currentRoadName || 'unnamed'} · WATCHED`);
        }
      }
    }
  }

  _blocked(ax, az, bx, bz) {
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      if (this.world.collideBuildings(ax + (bx - ax) * t, az + (bz - az) * t, 0.4)) return true;
    }
    return false;
  }

  // --------------------------------------------------------------- radar
  updateRadar(dt, player, camDir, active) {
    const wasActive = this.radarActive;
    this.radarActive = active;
    if (!active) { this.radarLock = 0; this.radarTarget = null; this.scanArmed = true; return; }
    if (!wasActive) this.scanArmed = true;

    let best = null, bestDot = RADAR_CONE;
    for (const { npc } of this.traffic.near(player.x, player.z, RADAR_RANGE)) {
      const dx = npc.x - player.x, dz = npc.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx / len) * camDir.x + (dz / len) * camDir.z;
      if (dot < bestDot) continue;
      if (this._blocked(player.x, player.z, npc.x, npc.z)) continue;
      bestDot = dot; best = npc;
    }

    if (best !== this.radarTarget) {
      this.radarTarget = best;
      this.radarLock = 0;
      this.scanArmed = true;
    }
    if (best) this.radarLock += dt;
  }

  get radarLocked() { return this.radarTarget && this.radarLock >= RADAR_LOCK_TIME; }

  /* A capture is a deliberate act, not a consequence of aiming. It yields
     exactly two things: the speed on the gun, and the registration record.
     It does NOT retroactively make a stop sign you never saw admissible. */
  captureScan() {
    if (!this.radarLocked || !this.scanArmed) return false;
    const npc = this.radarTarget;
    this.scanArmed = false;
    npc.scanned = true;

    const mph = npc.speed * MPS_TO_MPH;
    const limit = npc.currentLimit;
    const got = [];

    for (const code of npc.activeViolations) {
      if (SPEED_CODES.has(code) || PAPERWORK.has(code)) {
        if (this.record(npc, code, EVIDENCE.SCANNED, { mph, limit })) got.push(code);
        else npc.evidence.get(code).lvl = EVIDENCE.SCANNED;
      }
    }

    this.lastScan = { npc, mph, limit, plate: npc.plate, time: 3.0 };
    const label = got.length
      ? got.map((c) => VIOLATIONS[c].label).join(' · ')
      : 'nothing on the record';
    this.pushEvent('scan', `${Math.round(mph)} in a ${limit}`,
      `${npc.plate} · ${label}`, got.length ? 'scan' : 'clean');
    return true;
  }

  // ------------------------------------------------------------ pull over
  /** The driver you are looking at and have something on — not merely the nearest. */
  pickStopTarget(player, camDir) {
    const cands = this.traffic.near(player.x, player.z, PULLOVER_RANGE)
      .filter(({ npc }) => !npc.pullState);
    if (!cands.length) return null;

    // 1. The one you just clocked, if they're still in reach.
    if (this.radarTarget && !this.radarTarget.pullState) {
      const d = Math.hypot(this.radarTarget.x - player.x, this.radarTarget.z - player.z);
      if (d <= PULLOVER_RANGE) return this.radarTarget;
    }
    // 2. Otherwise the best in-view driver you actually have evidence on.
    let best = null, bestScore = -Infinity;
    for (const { npc, dist } of cands) {
      const dx = npc.x - player.x, dz = npc.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      const dot = (dx / len) * camDir.x + (dz / len) * camDir.z;
      if (dot < 0.35) continue;                       // behind you: not your stop
      const score = dot * 2 + (this.evidencedCodes(npc).length ? 3 : 0) - dist / 40;
      if (score > bestScore) { bestScore = score; best = npc; }
    }
    return best;
  }

  requestPullOver(player, camDir) {
    if (this.pendingCitation) return;
    const chosen = this.pickStopTarget(player, camDir);
    if (!chosen) { this.say('Nobody in front of you to signal.', 'warn', 2.2); return; }

    const codes = this.evidencedCodes(chosen);
    const hist = this.history.get(chosen.plate);
    // A driver the town trusts you about is likelier to actually stop.
    const comply = Math.random() < clamp(
      chosen.personality.yield * 0.70 + this.trust / 260 - this.overreach / 220, 0.05, 0.97
    );

    if (!comply) {
      chosen.pullState = 'fleeing';
      chosen.fleeTimer = 0;
      chosen.speedFactor *= 1.45;
      this.say(`${chosen.plate} isn't stopping.`, 'bad', 3);
      this.addLog({ kind: 'flee', plate: chosen.plate });
      return;
    }

    chosen.pullState = 'yielding';
    this.target = chosen;
    this.stops++;
    if (hist && hist.warned > 0) {
      this.say(`${chosen.plate} pulling over — you have warned this driver before.`, 'good', 4);
    } else {
      this.say(`${chosen.plate} pulling over. Step out and approach.`, 'good', 3.4);
    }
    if (!codes.length) {
      this.adjust('overreach', 6, 'stopped a driver you have nothing on');
      this.adjust('trust', -3, 'stopped a driver you have nothing on');
    }
  }

  /** Codes you can actually stand behind. Evidence is a record; it persists. */
  evidencedCodes(npc) {
    const out = [];
    for (const [code, rec] of npc.evidence) {
      if (rec.lvl >= EVIDENCE.OBSERVED) out.push(code);
    }
    return out;
  }

  tryApproach(player) {
    if (this.pendingCitation) return false;
    if (!player.onFoot) return false;      // you walk up to the window. always.
    for (const { npc } of this.traffic.near(player.x, player.z, APPROACH_RANGE)) {
      if (npc.pullState !== 'stopped') continue;
      const codes = this.evidencedCodes(npc);
      const suspected = [...npc.activeViolations].filter((c) => !codes.includes(c));
      this.pendingCitation = { npc, codes, suspected, hist: this.history.get(npc.plate) || null };
      return true;
    }
    return false;
  }

  _remember(npc, kind, codes) {
    let h = this.history.get(npc.plate);
    if (!h) {
      h = { warned: 0, cited: 0, seen: 0, offences: new Set(), name: npc.name };
      this.history.set(npc.plate, h);
    }
    h.seen++;
    h.lastAt = this.clock;
    for (const c of codes) h.offences.add(c);
    if (kind === 'warn') h.warned++;
    if (kind === 'cite') h.cited++;
    // Warned drivers go on the list so they can actually turn up again.
    if (kind === 'warn' && this.watchlist.length < 24
        && !this.watchlist.some((w) => w.plate === npc.plate)) {
      this.watchlist.push({ plate: npc.plate, name: npc.name, personality: npc.personality.id });
    }
  }

  resolve(choice) {
    const pc = this.pendingCitation;
    if (!pc) return;
    const { npc, codes, hist } = pc;
    const sev = maxSeverity(codes);
    const prior = hist && hist.warned > 0;
    let fine = fineFor(codes);
    if (prior) fine = Math.round(fine * 1.6);      // documented pattern

    if (choice === 'cite') {
      if (!codes.length) {
        this.badStops++;
        this.adjust('overreach', 22, 'cited a driver with no evidence');
        this.adjust('trust', -16, 'cited a driver with no evidence');
        this.adjust('heat', 18, 'complaint filed against you');
        this.say('You cited a clean driver. That one follows you around.', 'bad', 4.5);
        this.addLog({ kind: 'bad', plate: npc.plate, name: npc.name, text: 'Cited with no evidence' });
      } else {
        this.citations++;
        const reward = Math.round(fine * 0.18);
        this.adjust('funds', reward, 'citation recovery');
        this.adjust('trust', 4 + sev * 2.5 + (prior ? 3 : 0),
          prior ? 'citation on a documented repeat offender' : 'evidenced citation');
        this.say(
          prior ? `Prior warning on file. Citation filed — $${fine}. Recovery $${reward}.`
                : `Citation filed — $${fine}. Recovery $${reward}.`,
          'good', 4.2
        );
        this.addLog({ kind: 'cite', plate: npc.plate, name: npc.name, codes: codes.slice(), fine, prior });
      }
      this._remember(npc, 'cite', codes);
    } else if (choice === 'warn') {
      if (codes.length) {
        this.adjust('trust', 2.5, 'let someone off with a warning');
        this.say('Warning issued. It is on the record if they do it again.', 'info', 3.8);
        this.addLog({ kind: 'warn', plate: npc.plate, name: npc.name, codes: codes.slice() });
        this._remember(npc, 'warn', codes);
      } else {
        this.adjust('trust', -1, 'warned someone for nothing in particular');
        this.say('Warned them for nothing in particular.', 'warn', 3);
      }
    } else {
      if (!codes.length) {
        this.adjust('trust', -1.5, 'stopped a clean driver');
        this.adjust('overreach', 3, 'stopped a clean driver');
        this.say('Clean driver, ten minutes of their day gone.', 'warn', 3.8);
      } else {
        this.adjust('trust', 0.5, 'used discretion');
        this.say('Let them off. Discretion counts for something.', 'info', 3);
      }
    }

    npc.pullState = 'cited';
    npc.pullTimer = 0;
    npc.cited = true;
    npc.activeViolations.clear();
    npc.eventExpiry.clear();
    npc.evidence.clear();
    this.pendingCitation = null;
    this.target = null;
  }

  // --------------------------------------------------- the player's conduct
  updatePlayerConduct(dt, player, vehicle) {
    this.clock += dt;
    this.speedWarnCooldown = Math.max(0, this.speedWarnCooldown - dt);

    const lim = this.world.speedLimitAt(player.x, player.z);
    const mph = vehicle ? vehicle.mph : 0;
    const over = mph - lim.mph;

    if (vehicle && over > 15 && lim.onRoad) {
      this.playerSpeedingTime += dt;
      this.adjust('trust', -dt * 0.9, `you are doing ${Math.round(mph)} in a ${lim.mph}`);
      this.adjust('heat', dt * (over > 35 ? 3.6 : 1.5), 'driving like the people you cite');
    } else {
      this.playerSpeedingTime = Math.max(0, this.playerSpeedingTime - dt);
      if (this.heat > 0) this.heat = clamp(this.heat - dt * 1.6, 0, 100);
    }

    /* NOTE: overreach does NOT decay on a timer. If it evaporated on its own
       the penalty would be theatre. You buy it back by being useful — see
       JobBoard — which is the whole point of the second economy. */

    if (vehicle && vehicle.lastImpact > 0) {
      const impact = vehicle.lastImpact;
      vehicle.lastImpact = 0;
      if (impact > 5) {
        const cost = Math.round(impact * 9);
        this.adjust('trust', -impact * 0.38, 'property damage', this.COLLISION_TRUST_FLOOR);
        this.adjust('heat', impact * 1.25, 'property damage');
        this.adjust('funds', -Math.min(this.funds, cost), 'repairs');
        this.say(`Property damage. -$${cost}`, 'bad', 3);
      }
    }

    if (this.heat >= 100) {
      const fine = 320;
      this.adjust('funds', -Math.min(this.funds, fine), 'Leonia PD cited you');
      this.heat = 0;
      this.adjust('trust', -8, 'you got cited yourself');
      this.say(`Leonia PD cited YOU. -$${fine}. The irony is noted.`, 'bad', 5.5);
      this.addLog({ kind: 'self', text: `Cited by Leonia PD — $${fine}` });
    }

    if (this.toastTime > 0) this.toastTime -= dt;
    if (this.lastScan && this.lastScan.time > 0) this.lastScan.time -= dt;
    for (const d of this.deltas) d.t -= dt;
    while (this.deltas.length && this.deltas[0].t <= 0) this.deltas.shift();
    for (const e of this.events) e.t -= dt;
    while (this.events.length && this.events[0].t <= 0) this.events.shift();
  }

  /** A warned driver who may reappear, so patience has something to pay off on. */
  takeReturningDriver() {
    if (!this.watchlist.length || Math.random() > 0.22) return null;
    // CONSUME it. Leaving the entry in place let the same plate be driving two
    // cars at once, with both attributing to one history record.
    const i = Math.floor(Math.random() * this.watchlist.length);
    return this.watchlist.splice(i, 1)[0];
  }

  get standing() {
    if (this.overreach > 65) return { label: 'MENACE', color: '#e0554a' };
    if (this.overreach > 38) return { label: 'OVERZEALOUS', color: '#e8873a' };
    if (this.trust > 78) return { label: 'RESPECTED', color: '#5fd18a' };
    if (this.trust > 52) return { label: 'TOLERATED', color: '#8fd05f' };
    if (this.trust > 26) return { label: 'A NUISANCE', color: '#e8c15a' };
    return { label: 'RUN OUT OF TOWN', color: '#e0554a' };
  }
}
