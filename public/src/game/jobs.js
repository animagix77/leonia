import * as THREE from 'three';
import { rand, pick, randInt } from '../core/util.js';

/* The other half of the economy.

   Leonia in 2046 is a town that has comprehensively outsourced competence.
   Nobody owns a wrench. Nobody carries their own groceries in. There is a
   subscription service for changing a lightbulb and a four-week wait for it.
   You know how to do all of it, which makes you the most in-demand person in
   the borough and is the only reason anyone tolerates the rest of what you do.

   Mechanically: jobs pay well, and they buy Civic Trust — which is what makes
   drivers actually stop when you signal them. Being useful is what earns you
   the standing to be a nuisance. */

const JOBS = [
  { id: 'pipe',     title: 'Leaking supply line',   ask: 'Water under the sink. Shutoff is stuck.',                    verb: 'WORKING',   dur: 9.0, pay: [220, 380], trust: 3.5 },
  { id: 'groceries',title: 'Groceries from the car',ask: 'Six bags. The car is right there. Twelve feet.',             verb: 'CARRYING',  dur: 4.5, pay: [60, 110],  trust: 1.6 },
  { id: 'couch',    title: 'Move a sofa',           ask: 'Needs to go up one flight. One flight.',                    verb: 'LIFTING',   dur: 7.5, pay: [180, 300], trust: 2.8 },
  { id: 'battery',  title: 'Dead pack, no jumper',  ask: 'Car will not wake up. Roadside is four hours out.',          verb: 'JUMPING',   dur: 5.0, pay: [120, 190], trust: 2.2 },
  { id: 'drain',    title: 'Blocked storm drain',   ask: 'Curb drain is packed with leaves. Street is flooding.',      verb: 'CLEARING',  dur: 6.5, pay: [140, 230], trust: 3.2 },
  { id: 'gate',     title: 'Gate latch sheared',    ask: 'Back gate will not shut. Dog keeps getting out.',            verb: 'REPAIRING', dur: 6.0, pay: [130, 210], trust: 2.4 },
  { id: 'tv',       title: 'Wall-mount a screen',   ask: 'Bracket is in the box. Box has been there since March.',     verb: 'MOUNTING',  dur: 8.0, pay: [200, 320], trust: 2.6 },
  { id: 'brush',    title: 'Haul storm brush',      ask: 'Branches down across the drive since the last blow-through.',verb: 'HAULING',   dur: 8.5, pay: [160, 270], trust: 3.0 },
  { id: 'breaker',  title: 'Tripped subpanel',      ask: 'Half the house is dark. Panel is in the basement.',          verb: 'RESETTING', dur: 5.5, pay: [150, 240], trust: 2.5 },
  { id: 'sump',     title: 'Sump pump seized',      ask: 'Water is coming up. Creek side of town. Please hurry.',      verb: 'SERVICING', dur: 9.5, pay: [260, 420], trust: 4.0 },
];

const CALLERS = [
  'Hadley Prescott-Vane', 'Miles Ashcombe', 'Sirena Duplass', 'Tobin Marchetti-Wu',
  'Coralie Bexford', 'Auden Reyes-Thorne', 'Marguerite Sandoval', 'Fitz Callahan',
  'Priyanka Estes-Ward', 'Rhys Lindenbaum', 'Clementine Ohara', 'Dashiell Frank',
];

const ASIDES = [
  'They watched the whole time. From a chair.',
  'They filmed part of it for something.',
  'They asked if you had a certification for this.',
  'They offered you a seltzer and then drank it.',
  'They said their guy usually does this, but their guy is booked into next season.',
  'They asked what the tool was called. Twice.',
  'They tipped without being asked, which is new.',
  'Their kid watched from the stairs and looked genuinely interested.',
];

export class JobBoard {
  constructor(world, scene, enforcement, audio = null) {
    this.world = world;
    this.scene = scene;
    this.enforce = enforcement;
    this.audio = audio;

    this.current = null;      // { def, x, z, name, pay, state, progress }
    this.cooldown = 12;       // seconds until the first call
    this.completed = 0;
    this.earned = 0;

    this.marker = buildMarker();
    this.marker.visible = false;
    scene.add(this.marker);

    this.pulse = 0;
  }

  /** Pick a house near the player and offer a job. */
  _offer(player) {
    const w = this.world;
    // Find a residential footprint 60-260 m away that sits near a road.
    let best = null;
    for (let t = 0; t < 90; t++) {
      const b = w.buildings[Math.floor(Math.random() * w.buildings.length)];
      if (!b.r || b.r.length < 3) continue;
      if (b.a < 55 || b.a > 900) continue;
      let cx = 0, cz = 0;
      for (const p of b.r) { cx += p[0]; cz += p[1]; }
      cx /= b.r.length; cz /= b.r.length;
      const d = Math.hypot(cx - player.x, cz - player.z);
      if (d < 60 || d > 260) continue;
      const road = w.nearestRoad(cx, cz, 40);
      if (!road) continue;
      // Stand at the kerb-side edge of the property, not inside the house.
      const dx = cx - road.x, dz = cz - road.z;
      const l = Math.hypot(dx, dz) || 1;
      best = { x: road.x + (dx / l) * Math.min(l * 0.55, 9), z: road.z + (dz / l) * Math.min(l * 0.55, 9) };
      break;
    }
    if (!best) return;

    const def = pick(JOBS);
    this.current = {
      def,
      x: best.x,
      z: best.z,
      name: pick(CALLERS),
      pay: randInt(def.pay[0], def.pay[1]),
      state: 'offered',
      progress: 0,
      street: this.world.streetNameAt(best.x, best.z) || 'an unnamed street',
    };

    const y = this.world.heightAt(best.x, best.z);
    this.marker.position.set(best.x, y, best.z);
    this.marker.visible = true;

    this.enforce.say(
      `CALL — ${this.current.name}: "${def.ask}" ($${this.current.pay}, ${this.current.street})`,
      'info', 7
    );
  }

  cancel(reason = 'Job cancelled.') {
    if (!this.current) return;
    this.current = null;
    this.marker.visible = false;
    this.cooldown = rand(20, 40);
    this.enforce.say(reason, 'warn', 3);
  }

  /** True while the player is close enough and holding the work key. */
  update(dt, player, working) {
    this.pulse += dt;

    if (!this.current) {
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        this._offer(player);
        this.cooldown = rand(45, 80);
      }
      return;
    }

    const job = this.current;
    const d = Math.hypot(player.x - job.x, player.z - job.z);
    job.dist = d;
    job.inRange = d < 4.6 && player.onFoot;

    // Marker bob + colour shift as you close in.
    const y = this.world.heightAt(job.x, job.z);
    this.marker.position.y = y + 1.4 + Math.sin(this.pulse * 2.2) * 0.22;
    this.marker.rotation.y += dt * 0.9;
    const near = job.inRange;
    this.marker.children.forEach((c) => {
      if (c.material) c.material.color.setHex(near ? 0x5fd18a : 0x4fd0ff);
    });

    if (job.state === 'offered' && job.inRange) job.state = 'ready';
    if (job.state === 'ready' && !job.inRange) job.state = 'offered';

    if (job.state === 'ready' && working && job.inRange) job.state = 'working';

    if (job.state === 'working') {
      if (!job.inRange || !working) {
        job.state = 'ready';
        job.progress = Math.max(0, job.progress - dt * 0.35);
      } else {
        job.progress += dt / job.def.dur;
        if (job.progress >= 1) this._complete();
      }
    }
  }

  _complete() {
    const job = this.current;
    /* Route through adjust() like every other stat change, so the one thing
       that buys back Overreach actually SHOWS the player it did. The refund
       was also far too small to matter: a bad citation costs 22 overreach and
       a job returned 1.5, i.e. ~15 jobs to undo one mistake in a 12-minute
       shift. At 6 it is a real, reachable remedy. */
    this.enforce.adjust('funds', job.pay, `${job.def.title.toLowerCase()} — ${job.name}`);
    this.enforce.adjust('trust', job.def.trust, 'finished a job for a neighbour');
    this.enforce.adjust('overreach', -6, 'made yourself useful');
    this.completed++;
    if (this.audio) this.audio.jobComplete();
    this.earned += job.pay;

    this.enforce.addLog({
      kind: 'job',
      text: `${job.def.title} — ${job.name}`,
      pay: job.pay,
    });
    this.enforce.say(`${job.def.title} done. +$${job.pay}. ${pick(ASIDES)}`, 'good', 5.5);

    this.current = null;
    this.marker.visible = false;
    this.cooldown = rand(45, 85);
  }
}

function buildMarker() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x4fd0ff, transparent: true, opacity: 0.85 });

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.07, 6, 18), mat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);

  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.1, 6), mat);
  spike.rotation.x = Math.PI;
  spike.position.y = 0.85;
  g.add(spike);

  // A tall soft beam so you can find it across town.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 26, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x4fd0ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.y = 13;
  g.add(beam);

  return g;
}
