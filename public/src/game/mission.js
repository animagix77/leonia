import { clamp } from '../core/util.js';

/* Shift structure: objectives, health, score, and the win/loss states.

   The game had an open loop with no terminal condition — you could drive
   forever and nothing resolved. A shift gives it a shape: one working day,
   08:00 to 20:00, with a quota to meet and three distinct ways to fail.

   The losses are deliberately never sudden. Every one of them is a meter the
   player has been staring at all shift, and every change to those meters has
   already been surfaced with its cause attached. Losing should feel like the
   conclusion of an argument you were losing for ten minutes, not a trapdoor. */

export const SHIFT_START = 8.0;
export const SHIFT_END = 20.0;

export const OUTCOME = {
  RUNNING: 'running',
  WIN: 'win',
  LOSS_TRUST: 'loss_trust',
  LOSS_OVERREACH: 'loss_overreach',
  LOSS_HEALTH: 'loss_health',
  LOSS_QUOTA: 'loss_quota',
};

const ENDINGS = {
  [OUTCOME.WIN]: {
    title: 'SHIFT COMPLETE',
    tone: 'good',
    line: 'The borough tolerated you another day. That is the whole win condition, and it always was.',
  },
  [OUTCOME.LOSS_TRUST]: {
    title: 'RUN OUT OF TOWN',
    tone: 'bad',
    line: 'Civic trust hit zero. Nobody pulls over for you, nobody calls you about a leaking pipe. You are just a man in a car now.',
  },
  [OUTCOME.LOSS_OVERREACH]: {
    title: 'MENACE',
    tone: 'bad',
    line: 'You became the thing you object to. Enough stops with nothing behind them and the distinction stops meaning anything.',
  },
  [OUTCOME.LOSS_QUOTA]: {
    title: 'SHIFT OVER',
    tone: 'bad',
    line: 'The day ended short of the bar. Nobody ran you out of town — you just did not get there, and tomorrow starts from the same place.',
  },
  [OUTCOME.LOSS_HEALTH]: {
    title: 'HOSPITALISED',
    tone: 'bad',
    line: 'Bergen Regional, two cracked ribs, and a lot of time to consider whether the stop sign on Christie Heights was worth it.',
  },
};

export class Mission {
  constructor(enforcement, jobs, sky) {
    this.enf = enforcement;
    this.jobs = jobs;
    this.sky = sky;

    this.outcome = OUTCOME.RUNNING;
    this.ended = false;
    this.endedAt = null;

    this.health = 100;
    this.maxHealth = 100;
    this.regenDelay = 0;

    // Quota for the day. Modest on purpose: the interesting pressure is the
    // trust threshold, not grinding out tickets.
    this.quota = { citations: 5, jobs: 3 };
    this.trustTarget = 70;

    this.startCitations = enforcement.citations;
    this.startJobs = 0;
    this.peakTrust = enforcement.trust;
    this.elapsed = 0;

    sky.time = SHIFT_START;
  }

  /** Hours remaining in the shift, clamped at zero. */
  get hoursLeft() {
    return Math.max(0, SHIFT_END - this.sky.time);
  }

  get clockString() {
    const h = Math.floor(this.hoursLeft);
    const m = Math.floor((this.hoursLeft - h) * 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  get citationsDone() { return this.enf.citations - this.startCitations; }
  get jobsDone() { return this.jobs.completed - this.startJobs; }

  get quotaMet() {
    return this.citationsDone >= this.quota.citations && this.jobsDone >= this.quota.jobs;
  }

  /** Live objective list for the HUD tracker. */
  get objectives() {
    return [
      {
        label: 'Evidenced citations',
        have: this.citationsDone, need: this.quota.citations,
        done: this.citationsDone >= this.quota.citations,
      },
      {
        label: 'Jobs completed',
        have: this.jobsDone, need: this.quota.jobs,
        done: this.jobsDone >= this.quota.jobs,
      },
      {
        label: 'Civic trust',
        have: Math.round(this.enf.trust), need: this.trustTarget,
        done: this.enf.trust >= this.trustTarget,
      },
    ];
  }

  /* Score rewards the behaviour the design is actually about: evidenced
     stops and useful work, weighted by the standing you finished with.
     Bad stops subtract outright — you cannot grind your way past them. */
  get score() {
    const base = this.citationsDone * 250
      + this.jobsDone * 180
      + Math.round(this.enf.funds * 0.5)
      + Math.round(this.enf.trust * 12)
      - this.enf.badStops * 600
      - Math.round(this.enf.overreach * 8);
    return Math.max(0, base);
  }

  /** Physical damage to the player. `cause` is shown in the feedback stream. */
  hurt(amount, cause) {
    if (this.ended || amount <= 0) return;
    this.health = clamp(this.health - amount, 0, this.maxHealth);
    this.regenDelay = 6;
    this.enf.pushEvent('hurt', `INJURED −${Math.round(amount)}`, cause, 'clean');
  }

  update(dt) {
    if (this.ended) return;
    this.elapsed += dt;
    this.peakTrust = Math.max(this.peakTrust, this.enf.trust);

    // Slow recovery once you stop getting hit.
    this.regenDelay = Math.max(0, this.regenDelay - dt);
    if (this.regenDelay === 0 && this.health < this.maxHealth) {
      this.health = clamp(this.health + dt * 2.4, 0, this.maxHealth);
    }

    if (this.health <= 0) return this._end(OUTCOME.LOSS_HEALTH);
    if (this.enf.trust <= 0) return this._end(OUTCOME.LOSS_TRUST);
    if (this.enf.overreach >= 100) return this._end(OUTCOME.LOSS_OVERREACH);

    // End of the working day resolves the shift either way.
    if (this.sky.time >= SHIFT_END || this.sky.time < SHIFT_START - 0.5) {
      /* Running out the clock short of the bar is NOT the same as being run
         out of town — you can finish on 85 trust and 4/5 citations, and being
         told "civic trust hit zero" is simply a lie. */
      return this._end(this.quotaMet && this.enf.trust >= this.trustTarget
        ? OUTCOME.WIN
        : OUTCOME.LOSS_QUOTA);
    }
  }

  _end(outcome) {
    this.outcome = outcome;
    this.ended = true;
    this.endedAt = {
      ...ENDINGS[outcome],
      score: this.score,
      citations: this.citationsDone,
      jobs: this.jobsDone,
      badStops: this.enf.badStops,
      trust: Math.round(this.enf.trust),
      funds: this.enf.funds,
      won: outcome === OUTCOME.WIN,
    };
  }

  /** Used by the end screen when the shift ran out short of the bar. */
  get shortfall() {
    const miss = this.objectives.filter((o) => !o.done);
    if (!miss.length) return null;
    return miss.map((o) => `${o.label} ${o.have}/${o.need}`).join(' · ');
  }
}
