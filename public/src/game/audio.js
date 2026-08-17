/* Procedural audio. Every sound in the game is synthesised here at runtime —
   there is not a single sample file in the build, and there never will be.

   Two halves. The CONTINUOUS half (engine, tyres, wind, road hum, siren, horn)
   is built once when the context wakes up and then never allocates again: the
   game loop only writes AudioParam targets, so a frame costs a dozen float
   writes rather than a graph rebuild. The ONE-SHOT half allocates a small
   voice per event, schedules its whole envelope up front, and tears itself
   down on `onended`. A hard voice cap means a twelve-car pile-up degrades
   instead of melting the audio thread.

   The engine deserves a note because it is the whole feel of the game. It is a
   stack of detuned saws plus a sine for weight, all driven from ONE
   ConstantSourceNode carrying the firing frequency in Hz — each oscillator
   reads it through a ratio gain, so a single `offset` write revs the entire
   stack in tune. Amplitude is multiplied by a lowpassed-noise wobble (an LFO
   reads as a synth; band-limited noise reads as combustion) and punched down
   by a threshold-shaped noise spike whose depth is damage, which is the
   misfire. */

const MAX_VOICES = 20;                  // hard cap; a pile-up degrades, not melts
const NOISE_SECONDS = 2.0;
const IR_SECONDS = 0.85;

const clamp01 = (v) => (v > 1 ? 1 : v < 0 ? 0 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && v === v ? v : d);

/* Biquads misbehave outside a sane band, and a NaN cutoff poisons the whole
   graph for the rest of the session. Everything goes through here. */
const hz = (v) => clamp(v === v ? v : 20, 20, 18000);

function driveCurve(k, n = 1024) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/* Passes only the top of the incoming swing. Fed band-limited noise it emits
   sparse, irregular pulses — no scheduler, no randomness in JS, just physics. */
function spikeCurve(threshold, n = 1024) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = x > threshold ? (x - threshold) / (1 - threshold) : 0;
  }
  return c;
}

export class Audio {
  constructor() {
    /* No AudioContext here on purpose. Constructing one before a gesture gets
       it born suspended (or warned about) in every modern browser, and the
       game builds its systems long before the player clicks anything. */
    this.ctx = null;
    this._failed = false;
    this._built = false;
    this._muted = false;
    this._vol = 0.8;
    this._voices = 0;

    this._stepFlip = 0;
    this._hornDown = false;
    this._sirenOn = false;

    // last-fired timestamps for rate-limited one-shots
    this._tStep = -1;
    this._tSkid = -1;
    this._tHover = -1;
    this._tImpact = -1;

    // smoothed control state, so a jittery frame doesn't zipper the engine
    this._speed = 0;
    this._thr = 0;
    this._rpm = 0;
    this._slip = 0;
    this._dmg = 0;
    this._foot = 0;
    this._night = 0;
    this._traffic = 0;
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Create or wake the AudioContext. Safe to call on every click; the game
   * calls it from the first user gesture. Never throws, never rejects.
   */
  resume() {
    if (this._failed) return;
    try {
      if (!this.ctx) this._build();
      if (!this.ctx) return;
      if (this.ctx.state !== 'running') {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {
      this._failed = true;
    }
  }

  /** @param {boolean} m */
  setMuted(m) {
    this._muted = !!m;
    this._applyVolume();
  }

  get muted() { return this._muted; }

  /** @param {number} v 0..1 */
  setMasterVolume(v) {
    this._vol = clamp01(num(v, 0.8));
    this._applyVolume();
  }

  _applyVolume() {
    if (!this.ctx || !this.master) return;
    try {
      const g = this._muted ? 0 : this._vol;
      this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.04);
    } catch (e) { /* context died under us; the next call will no-op */ }
  }

  /* ------------------------------------------------------------ the graph */

  _build() {
    const Ctor = typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) { this._failed = true; return; }

    let ctx;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      this._failed = true;
      return;
    }
    this.ctx = ctx;

    /* Master: everything lands on the compressor, so twelve simultaneous
       crunches duck instead of clipping into digital fizz. */
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : this._vol;
    master.connect(ctx.destination);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(master);

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(comp);

    /* A short synthetic room. Without it the one-shots are a pile of beeps in
       a vacuum; with it they happen somewhere. 0.85 s keeps the convolution
       cheap enough to sit next to a 60 FPS scene. */
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = this._makeImpulse(ctx, IR_SECONDS, 2.6);
    const fxReturn = ctx.createGain();
    fxReturn.gain.value = 0.9;
    conv.connect(fxReturn);
    fxReturn.connect(comp);

    const fxSend = ctx.createGain();
    fxSend.gain.value = 0.22;
    fxSend.connect(conv);

    // One-shots and the loud interactive loops share this bus.
    const sfx = ctx.createGain();
    sfx.gain.value = 1;
    sfx.connect(dry);
    sfx.connect(fxSend);

    this.master = master;
    this.comp = comp;
    this.dry = dry;
    this.sfx = sfx;
    this.fxSend = fxSend;

    this.noiseBuf = this._makeNoise(ctx, NOISE_SECONDS);
    this.softCurve = driveCurve(2.4);
    this.hardCurve = driveCurve(7.0);
    this.misfireCurve = spikeCurve(0.42);

    /* One looping noise source feeds every continuous noise consumer. The
       bands they occupy don't overlap, so the shared origin is inaudible and
       we pay for exactly one buffer read per block. */
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    this.noiseSrc = noise;

    this._buildEngine(ctx, noise);
    this._buildTyres(ctx, noise);
    this._buildAmbience(ctx, noise);

    noise.start();
    /* Only now is it safe for update() and the one-shots to touch the graph;
       a half-built context (an unsupported node type partway through) must
       read as unavailable, not as available-and-full-of-holes. */
    this._built = true;
  }

  _buildEngine(ctx, noise) {
    /* Firing frequency, in Hz, for the whole stack. ~30 Hz at idle to ~195 Hz
       flat out — a four-cylinder's real firing rate, which is why it reads as
       an engine rather than a bass patch. */
    const freq = ctx.createConstantSource();
    freq.offset.value = 30;
    this.engFreq = freq;

    const oscMix = ctx.createGain();
    oscMix.gain.value = 0.32;

    const voices = [
      ['sawtooth', 1.0, 0, 0.55],
      ['sawtooth', 1.0, 9, 0.45],       // beats against the first: thickness
      ['sawtooth', 2.0, -7, 0.30],      // second order, adds bite under load
      ['square', 3.0, 5, 0.13],         // harmonic edge, the "cam" in the mix
      ['sine', 1.0, 0, 0.70],           // weight; carries the sub on its own
    ];
    this.engOscs = [];
    for (const [type, ratio, detune, lvl] of voices) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 0;            // driven entirely by the shared source
      o.detune.value = detune;
      const track = ctx.createGain();
      track.gain.value = ratio;
      freq.connect(track);
      track.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.value = lvl;
      o.connect(g);
      g.connect(oscMix);
      this.engOscs.push(o);
    }

    const drive = ctx.createWaveShaper();
    drive.curve = this.softCurve;
    drive.oversample = '2x';
    oscMix.connect(drive);

    /* The cutoff is the throttle. Intrinsic value is written per frame from
       throttle; the connected tracker adds 4x the firing frequency so the
       timbre also brightens with revs, for free. */
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300;
    lp.Q.value = 4;
    const lpTrack = ctx.createGain();
    lpTrack.gain.value = 4;
    freq.connect(lpTrack);
    lpTrack.connect(lp.frequency);
    drive.connect(lp);

    // Intake/exhaust rush: noise in a band that rides the firing frequency.
    const intake = ctx.createBiquadFilter();
    intake.type = 'bandpass';
    intake.frequency.value = 260;
    intake.Q.value = 1.1;
    const intakeTrack = ctx.createGain();
    intakeTrack.gain.value = 6;
    freq.connect(intakeTrack);
    intakeTrack.connect(intake.frequency);
    noise.connect(intake);
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    intake.connect(intakeGain);

    /* Multiplier stage. Baseline 1, with two bipolar modulators summed into
       the param: a gentle wobble that stops the stack reading as a test tone,
       and a sparse negative spike train that is the misfire. */
    const am = ctx.createGain();
    am.gain.value = 1;
    lp.connect(am);
    intakeGain.connect(am);

    const wobbleLP = ctx.createBiquadFilter();
    wobbleLP.type = 'lowpass';
    wobbleLP.frequency.value = 11;
    wobbleLP.Q.value = 0.9;
    noise.connect(wobbleLP);
    /* Filtering white noise down to a 11 Hz band throws away almost all of
       its energy, so the control signal comes out around 0.03 RMS. Boost it
       back to something that can actually move a gain param. */
    const wobbleBoost = ctx.createGain();
    wobbleBoost.gain.value = 20;
    wobbleLP.connect(wobbleBoost);
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 0.1;
    wobbleBoost.connect(wobbleDepth);
    wobbleDepth.connect(am.gain);

    const misLP = ctx.createBiquadFilter();
    misLP.type = 'lowpass';
    misLP.frequency.value = 38;
    misLP.Q.value = 0.7;
    noise.connect(misLP);
    const misBoost = ctx.createGain();
    misBoost.gain.value = 7;            // lift the band into the shaper's range
    misLP.connect(misBoost);
    const misShape = ctx.createWaveShaper();
    misShape.curve = this.misfireCurve;
    misBoost.connect(misShape);
    const misDepth = ctx.createGain();
    misDepth.gain.value = 0;            // negative once damaged: cuts, not adds
    misShape.connect(misDepth);
    misDepth.connect(am.gain);

    const out = ctx.createGain();
    out.gain.value = 0;
    am.connect(out);
    out.connect(this.dry);

    this.engLP = lp;
    this.engAM = am;
    this.engGain = out;
    this.engIntake = intakeGain;
    this.engWobble = wobbleDepth;
    this.engMisfire = misDepth;
    this.wobbleMod = wobbleBoost;

    freq.start();
    for (const o of this.engOscs) o.start();
  }

  _buildTyres(ctx, noise) {
    /* Two bandpasses a fifth apart. A single resonant peak whistles; a pair
       scrubs, which is what rubber letting go actually sounds like. */
    const a = ctx.createBiquadFilter();
    a.type = 'bandpass';
    a.frequency.value = 1100;
    a.Q.value = 6;
    const b = ctx.createBiquadFilter();
    b.type = 'bandpass';
    b.frequency.value = 1650;
    b.Q.value = 9;
    noise.connect(a);
    noise.connect(b);

    const bGain = ctx.createGain();
    bGain.gain.value = 0.55;
    b.connect(bGain);

    const out = ctx.createGain();
    out.gain.value = 0;
    a.connect(out);
    bGain.connect(out);
    out.connect(this.dry);
    out.connect(this.fxSend);

    this.tyreA = a;
    this.tyreB = b;
    this.tyreGain = out;
  }

  _buildAmbience(ctx, noise) {
    // Road roar: broadband rumble under the car, scaled by speed and traffic.
    const road = ctx.createBiquadFilter();
    road.type = 'lowpass';
    road.frequency.value = 240;
    road.Q.value = 0.8;
    noise.connect(road);
    const roadGain = ctx.createGain();
    roadGain.gain.value = 0;
    road.connect(roadGain);
    roadGain.connect(this.dry);

    // Wind: a band that climbs and opens with speed.
    const wind = ctx.createBiquadFilter();
    wind.type = 'bandpass';
    wind.frequency.value = 700;
    wind.Q.value = 0.5;
    noise.connect(wind);
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windGain);
    windGain.connect(this.dry);

    /* Night air. Barely there by design — it exists so the silence after you
       stop the car at 3am isn't digital-black. The tremolo taps the engine's
       wobble noise rather than paying for a second modulator. */
    const air = ctx.createBiquadFilter();
    air.type = 'bandpass';
    air.frequency.value = 4300;
    air.Q.value = 0.9;
    noise.connect(air);
    const airAM = ctx.createGain();
    airAM.gain.value = 1;
    air.connect(airAM);
    const trem = ctx.createGain();
    trem.gain.value = 0.45;
    this.wobbleMod.connect(trem);
    trem.connect(airAM.gain);
    const nightGain = ctx.createGain();
    nightGain.gain.value = 0;
    airAM.connect(nightGain);
    nightGain.connect(this.dry);

    this.roadGain = roadGain;
    this.windFilt = wind;
    this.windGain = windGain;
    this.nightGain = nightGain;
  }

  /* ------------------------------------------------------------- buffers */

  _makeNoise(ctx, seconds) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  _makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const n = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      /* One-pole smoothing darkens the tail. A raw white tail sounds like a
         spring reverb from a cheap amp; a darkened one sounds like brick. */
      let lp = 0;
      for (let i = 0; i < n; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.34;
        d[i] = lp * Math.pow(1 - i / n, decay);
      }
      // Sparse early taps, offset per channel, so the room has walls and width.
      const taps = [0.009, 0.017, 0.029, 0.046];
      for (let k = 0; k < taps.length; k++) {
        const idx = Math.floor(taps[k] * rate) + (ch ? 41 : 0);
        if (idx < n) d[idx] += (k & 1 ? -1 : 1) * (0.5 / (k + 1));
      }
    }
    return buf;
  }

  /* -------------------------------------------------------- voice helpers */

  _live() {
    return this._built && !this._failed && this.ctx.state === 'running';
  }

  /** A per-event submix. Returns null when the voice budget is spent. */
  _voice(level) {
    if (this._voices >= MAX_VOICES) return null;
    const g = this.ctx.createGain();
    g.gain.value = level;
    g.connect(this.sfx);
    this._voices++;
    return g;
  }

  /* `last` must be the longest-lived source in the voice; its `onended` is
     what returns the budget and drops the subgraph. */
  _free(voice, last) {
    let done = false;
    last.onended = () => {
      if (done) return;
      done = true;
      this._voices--;
      try { voice.disconnect(); } catch (e) { /* already gone */ }
    };
  }

  _noise(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;                      // a random start offset can't run short
    s.start(t, Math.random() * (NOISE_SECONDS - 0.1));
    s.stop(t + dur);
    return s;
  }

  _osc(type, f, t, dur) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz(f);
    o.start(t);
    o.stop(t + dur);
    return o;
  }

  _filt(type, f, q) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = hz(f);
    b.Q.value = q;
    return b;
  }

  _gain(v) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /** Percussive AD envelope. Exponential both ways — linear attacks click. */
  _env(param, t, peak, attack, decay) {
    const p = Math.max(peak, 0.0002);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(p, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    param.setValueAtTime(0, t + attack + decay + 0.002);
  }

  _now() { return this.ctx.currentTime + 0.003; }

  /* ------------------------------------------------------------ per-frame */

  /**
   * Drive the continuous layers. Called every frame; writes AudioParam
   * targets only — no node is created, connected or disconnected in here.
   */
  update(dt, s) {
    if (!this._live()) return;
    try {
      const step = clamp(num(dt, 0.016), 0.001, 0.1);
      s = s || {};
      const t = this.ctx.currentTime;

      const speed = Math.max(0, num(s.speedMps, 0));
      const thr = clamp01(num(s.throttle, 0));
      const rpm = clamp01(num(s.rpmNorm, 0));
      const slip = clamp01(num(s.slipAmount, 0));
      const dmg = clamp01(num(s.damage, 0) / 160);
      const foot = s.onFoot ? 1 : 0;
      const night = s.isNight ? 1 : 0;
      const traffic = clamp01(num(s.nearbyTraffic, 0) / 12);

      // Frame-rate independent one-pole smoothing on the raw inputs.
      const k = 1 - Math.exp(-step * 9);
      this._speed += (speed - this._speed) * k;
      this._thr += (thr - this._thr) * k;
      this._rpm += (rpm - this._rpm) * k;
      this._slip += (slip - this._slip) * k;
      this._dmg += (dmg - this._dmg) * (1 - Math.exp(-step * 2));
      this._foot += (foot - this._foot) * (1 - Math.exp(-step * 4));
      this._night += (night - this._night) * (1 - Math.exp(-step * 0.6));
      this._traffic += (traffic - this._traffic) * (1 - Math.exp(-step * 1.5));

      const inCar = 1 - this._foot;

      /* Engine. Firing frequency is the rev; the cutoff is the throttle. The
         two together are what make it load up and back off rather than just
         get louder. */
      const f = 30 + this._rpm * 165;
      this.engFreq.offset.setTargetAtTime(f, t, 0.035);
      this.engLP.frequency.setTargetAtTime(
        hz(200 + this._thr * 2400 + this._rpm * 500), t, 0.05);
      this.engLP.Q.setTargetAtTime(3 + this._thr * 5, t, 0.1);

      const load = 0.02 + this._thr * 0.10 + this._rpm * 0.055;
      this.engGain.gain.setTargetAtTime(load * inCar, t, 0.04);
      this.engIntake.gain.setTargetAtTime(
        (0.03 + this._thr * 0.16 + this._rpm * 0.05) * inCar, t, 0.06);

      /* Roughness rises with damage AND with load — a hurt engine is worst
         when you ask it for something. */
      this.engWobble.gain.setTargetAtTime(
        0.08 + this._dmg * 0.30 + this._rpm * 0.05, t, 0.15);
      this.engMisfire.gain.setTargetAtTime(
        -this._dmg * (0.55 + this._thr * 0.35), t, 0.2);

      /* Tyres. Frequency and Q both climb with slip: a light scrub is a broad
         low hiss, a full slide is a narrow scream. Needs load on the tyre, so
         it's gated by speed as well as slip. */
      const sq = this._slip * this._slip * clamp01(this._speed / 6) * inCar;
      this.tyreA.frequency.setTargetAtTime(
        hz(850 + this._slip * 1250), t, 0.06);
      this.tyreB.frequency.setTargetAtTime(
        hz(1500 + this._slip * 1900), t, 0.06);
      this.tyreA.Q.setTargetAtTime(5 + this._slip * 18, t, 0.08);
      this.tyreB.Q.setTargetAtTime(7 + this._slip * 22, t, 0.08);
      this.tyreGain.gain.setTargetAtTime(sq * 0.20, t, 0.05);

      // Road and wind. Wind is roughly quadratic in speed, as it is in life.
      const v = this._speed;
      const vq = clamp01(v / 34);
      this.roadGain.gain.setTargetAtTime(
        (0.012 + clamp01(v / 22) * 0.075 + this._traffic * 0.035) *
        (0.35 + inCar * 0.65), t, 0.12);
      this.windFilt.frequency.setTargetAtTime(hz(520 + vq * 1100), t, 0.15);
      this.windGain.gain.setTargetAtTime(vq * vq * 0.055 * inCar, t, 0.12);

      this.nightGain.gain.setTargetAtTime(
        this._night * 0.009 * (0.3 + this._foot * 0.7), t, 0.4);
    } catch (e) {
      /* A dead context would otherwise throw sixty times a second. */
      this._failed = true;
    }
  }

  /* ------------------------------------------------------------ one-shots */

  /**
   * Vehicle-on-vehicle collision. `severity` is closing speed in m/s (0..30).
   * Layered thud + metallic crunch + debris tail; duration, brightness and
   * level all scale, so a parking nudge and a wreck are different events.
   */
  impact(severity) {
    if (!this._live()) return;
    try {
      const now = this.ctx.currentTime;
      // Contacts arrive in clusters from the solver; one crunch per cluster.
      if (now - this._tImpact < 0.045) return;
      this._tImpact = now;

      const s = clamp(num(severity, 5) / 25, 0.05, 1.2);
      const voice = this._voice(clamp(0.25 + s * 0.75, 0.2, 1));
      if (!voice) return;
      const t = this._now();

      // 1. Thud — the mass of it.
      const thudDur = 0.09 + s * 0.30;
      const tn = this._noise(t, thudDur + 0.05);
      const tf = this._filt('lowpass', 95 + s * 140, 1.4);
      const tg = this._gain(0);
      tn.connect(tf); tf.connect(tg); tg.connect(voice);
      this._env(tg.gain, t, 0.55 + s * 0.5, 0.004, thudDur);

      // Body boom: the shell resonating, pitch dropping as it deforms.
      const boom = this._osc('sine', 58 + s * 26, t, thudDur + 0.06);
      boom.frequency.exponentialRampToValueAtTime(
        hz(30 + s * 10), t + thudDur * 0.9);
      const bg = this._gain(0);
      boom.connect(bg); bg.connect(voice);
      this._env(bg.gain, t, 0.4 + s * 0.45, 0.006, thudDur * 0.85);

      // 2. Crunch — bandpassed noise through a hard shaper, plus inharmonic
      //    partials. The partials are what make it read as metal not mud.
      const crDur = 0.045 + s * 0.13;
      const cn = this._noise(t, crDur + 0.05);
      const cf = this._filt('bandpass', 1100 + s * 2300, 0.85);
      const sh = this.ctx.createWaveShaper();
      sh.curve = this.hardCurve;
      const cg = this._gain(0);
      cn.connect(cf); cf.connect(sh); sh.connect(cg); cg.connect(voice);
      this._env(cg.gain, t, 0.18 + s * 0.42, 0.002, crDur);

      if (s > 0.18) {
        const partials = [431, 707, 1103];
        for (let i = 0; i < partials.length; i++) {
          const f0 = partials[i] * (0.8 + s * 0.5);
          const o = this._osc('square', f0, t, crDur + 0.04);
          o.frequency.exponentialRampToValueAtTime(hz(f0 * 0.72), t + crDur);
          const og = this._gain(0);
          o.connect(og); og.connect(voice);
          this._env(og.gain, t + i * 0.004, (0.09 - i * 0.02) * s,
            0.001, crDur * (0.8 - i * 0.15));
        }
      }

      // 3. Debris — trim and glass settling. One noise source, an irregular
      //    scheduled grain envelope; spawning a node per fragment is waste.
      let last = tn;
      if (s > 0.25) {
        const tail = 0.25 + s * 0.95;
        const dn = this._noise(t + 0.02, tail + 0.05);
        const df = this._filt('highpass', 1800 + s * 900, 0.7);
        const dg = this._gain(0.0001);
        dn.connect(df); df.connect(dg); dg.connect(voice);
        let gt = t + 0.04;
        const end = t + tail;
        while (gt < end) {
          const frac = (gt - t) / tail;
          const lvl = 0.22 * s * (1 - frac) * (0.15 + Math.random() * 0.85);
          dg.gain.setValueAtTime(Math.max(lvl, 0.0001), gt);
          gt += (0.010 + Math.random() * 0.045) * (0.6 + frac * 1.6);
        }
        dg.gain.setValueAtTime(0, end + 0.01);
        last = dn;
      }
      this._free(voice, last);
    } catch (e) { /* one lost crunch is not worth killing audio over */ }
  }

  /**
   * Hitting a person. Same skeleton as `impact`, stripped of everything
   * metallic — a soft body has no ring and leaves no debris.
   */
  pedImpact(severity) {
    if (!this._live()) return;
    try {
      const s = clamp(num(severity, 5) / 18, 0.05, 1);
      const voice = this._voice(0.3 + s * 0.5);
      if (!voice) return;
      const t = this._now();

      const dur = 0.10 + s * 0.16;
      const n = this._noise(t, dur + 0.06);
      const f = this._filt('lowpass', 180 + s * 130, 1.1);
      const g = this._gain(0);
      n.connect(f); f.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.45 + s * 0.35, 0.006, dur);

      const body = this._osc('sine', 86 + s * 20, t, dur + 0.05);
      body.frequency.exponentialRampToValueAtTime(hz(48), t + dur * 0.8);
      const bg = this._gain(0);
      body.connect(bg); bg.connect(voice);
      this._env(bg.gain, t, 0.3 + s * 0.25, 0.008, dur * 0.7);

      // Cloth scuff, so it isn't just a kick drum.
      const cn = this._noise(t + 0.01, 0.14);
      const cf = this._filt('bandpass', 620 + s * 400, 1.6);
      const cg = this._gain(0);
      cn.connect(cf); cf.connect(cg); cg.connect(voice);
      this._env(cg.gain, t + 0.01, 0.10 + s * 0.10, 0.010, 0.11);

      this._free(voice, n);
    } catch (e) { /* ignore */ }
  }

  /** Brief tyre chirp — a scrub too short for the continuous squeal to catch. */
  skid(intensity) {
    if (!this._live()) return;
    try {
      const now = this.ctx.currentTime;
      if (now - this._tSkid < 0.12) return;
      this._tSkid = now;

      const s = clamp01(num(intensity, 0.5));
      const voice = this._voice(0.12 + s * 0.22);
      if (!voice) return;
      const t = this._now();
      const dur = 0.13 + s * 0.16;

      const n = this._noise(t, dur + 0.04);
      const f = this._filt('bandpass', 1900 + s * 700, 11 + s * 10);
      f.frequency.exponentialRampToValueAtTime(hz(950 + s * 250), t + dur);
      const g = this._gain(0);
      n.connect(f); f.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.5, 0.008, dur);
      this._free(voice, n);
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------- held controls */

  /**
   * Horn. `down` is the button state, not a trigger — press and release.
   * Two sour-interval saws, which is what a real car horn is.
   */
  horn(down) {
    if (!this._live()) return;
    try {
      const on = !!down;
      if (on === this._hornDown) return;
      this._hornDown = on;
      if (!this._horn) this._buildHorn();
      const t = this.ctx.currentTime;
      const g = this._horn.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(g.value, 0.0001), t);
      if (on) {
        this._horn.detune.setTargetAtTime(0, t, 0.02);
        g.linearRampToValueAtTime(0.16, t + 0.014);
      } else {
        // Horns sag flat as the diaphragm dies. Free character.
        this._horn.detune.setTargetAtTime(-70, t, 0.03);
        g.linearRampToValueAtTime(0, t + 0.055);
      }
    } catch (e) { /* ignore */ }
  }

  _buildHorn() {
    const ctx = this.ctx;
    const out = this._gain(0);
    const shape = ctx.createWaveShaper();
    shape.curve = this.softCurve;
    const lp = this._filt('lowpass', 2800, 1.2);
    const detune = ctx.createConstantSource();
    detune.offset.value = 0;

    const mix = this._gain(0.4);
    for (const f of [398, 503]) {          // a deliberate, unpleasant interval
      const o = this._osc('sawtooth', f, ctx.currentTime, 1e6);
      detune.connect(o.detune);
      o.connect(mix);
    }
    mix.connect(shape);
    shape.connect(lp);
    lp.connect(out);
    out.connect(this.sfx);
    detune.start();
    this._horn = { gain: out, detune: detune.offset };
  }

  /**
   * Emergency siren. Two-tone wail: a square LFO rounded by a lowpass so the
   * pitch swoops between the tones instead of stepping.
   * @param {boolean} on
   */
  siren(on) {
    if (!this._live()) return;
    try {
      const want = !!on;
      if (want === this._sirenOn) return;
      this._sirenOn = want;
      if (!this._siren) this._buildSiren();
      const t = this.ctx.currentTime;
      this._siren.gain.gain.setTargetAtTime(want ? 0.12 : 0, t, want ? 0.08 : 0.15);
    } catch (e) { /* ignore */ }
  }

  _buildSiren() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const base = ctx.createConstantSource();
    base.offset.value = 720;

    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 1.55;
    /* Built by hand rather than via _filt because the cutoff is sub-audio and
       _filt clamps to the audible band. Rounding the square's corners is what
       turns a two-tone beep into a wail. */
    const round = ctx.createBiquadFilter();
    round.type = 'lowpass';
    round.frequency.value = 3.2;
    round.Q.value = 0.7;
    lfo.connect(round);
    const depth = this._gain(260);
    round.connect(depth);
    depth.connect(base.offset);

    const mix = this._gain(0.35);
    for (const [type, ratio, lvl] of [['sawtooth', 1, 0.6], ['square', 2, 0.18]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 0;
      const track = this._gain(ratio);
      base.connect(track);
      track.connect(o.frequency);
      const g = this._gain(lvl);
      o.connect(g);
      g.connect(mix);
      o.start(now);
    }

    const body = this._filt('bandpass', 1300, 1.4);
    const out = this._gain(0);
    mix.connect(body);
    body.connect(out);
    out.connect(this.sfx);

    base.start(now);
    lfo.start(now);
    this._siren = { gain: out };
  }

  /* --------------------------------------------------------- game feedback */

  /** Rising blip as the radar acquires a target. */
  radarLock() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.2);
      if (!voice) return;
      const t = this._now();
      const o = this._osc('triangle', 700, t, 0.16);
      o.frequency.exponentialRampToValueAtTime(1560, t + 0.11);
      const g = this._gain(0);
      o.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.55, 0.006, 0.12);
      this._free(voice, o);
    } catch (e) { /* ignore */ }
  }

  /** Shutter clack plus a confirming tone. */
  radarCapture() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.24);
      if (!voice) return;
      const t = this._now();
      // Two clicks: mirror up, mirror down.
      for (let i = 0; i < 2; i++) {
        const at = t + i * 0.045;
        const n = this._noise(at, 0.03);
        const f = this._filt('bandpass', i ? 1800 : 2900, 2.2);
        const g = this._gain(0);
        n.connect(f); f.connect(g); g.connect(voice);
        this._env(g.gain, at, i ? 0.5 : 0.7, 0.001, 0.022);
      }
      const o = this._osc('sine', 1245, t + 0.09, 0.14);
      const og = this._gain(0);
      o.connect(og); og.connect(voice);
      this._env(og.gain, t + 0.09, 0.22, 0.006, 0.11);
      this._free(voice, o);
    } catch (e) { /* ignore */ }
  }

  /** Paper, stamp, and a small two-note "that one's done". */
  citation() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.3);
      if (!voice) return;
      const t = this._now();

      // Paper: highpassed noise with a scheduled rustle envelope.
      const pn = this._noise(t, 0.2);
      const pf = this._filt('highpass', 2600, 0.8);
      const pg = this._gain(0.0001);
      pn.connect(pf); pf.connect(pg); pg.connect(voice);
      let gt = t;
      while (gt < t + 0.16) {
        pg.gain.setValueAtTime(0.05 + Math.random() * 0.14, gt);
        gt += 0.012 + Math.random() * 0.028;
      }
      pg.gain.setValueAtTime(0, t + 0.17);

      // Stamp.
      const st = t + 0.14;
      const sn = this._noise(st, 0.14);
      const sf = this._filt('lowpass', 340, 1.2);
      const sg = this._gain(0);
      sn.connect(sf); sf.connect(sg); sg.connect(voice);
      this._env(sg.gain, st, 0.6, 0.003, 0.11);
      const sb = this._osc('sine', 122, st, 0.14);
      sb.frequency.exponentialRampToValueAtTime(72, st + 0.1);
      const sbg = this._gain(0);
      sb.connect(sbg); sbg.connect(voice);
      this._env(sbg.gain, st, 0.34, 0.004, 0.1);

      // Confirmation: a rising fourth, warm.
      let last = sb;
      for (let i = 0; i < 2; i++) {
        const at = t + 0.26 + i * 0.09;
        const o = this._osc('triangle', i ? 880 : 659.25, at, 0.34);
        const g = this._gain(0);
        o.connect(g); g.connect(voice);
        this._env(g.gain, at, 0.20, 0.010, 0.30);
        last = o;
      }
      this._free(voice, last);
    } catch (e) { /* ignore */ }
  }

  /** Flat, dissonant, short. The sound of being told no. */
  denied() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.24);
      if (!voice) return;
      const t = this._now();

      const shape = this.ctx.createWaveShaper();
      shape.curve = this.hardCurve;
      const band = this._filt('bandpass', 620, 2.0);
      const g = this._gain(0);
      shape.connect(band); band.connect(g); g.connect(voice);

      let last = null;
      for (const f of [156, 149]) {          // second buzz sags: worse news
        const o = this._osc('sawtooth', f, t, 0.30);
        o.connect(shape);
        last = o;
      }
      // Two gated pulses rather than one drone.
      this._env(g.gain, t, 0.42, 0.004, 0.085);
      this._env(g.gain, t + 0.13, 0.36, 0.004, 0.11);
      this._free(voice, last);
    } catch (e) { /* ignore */ }
  }

  /** Button press. Short enough to feel like a mechanism, not a note. */
  uiClick() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.16);
      if (!voice) return;
      const t = this._now();
      const n = this._noise(t, 0.03);
      const f = this._filt('bandpass', 2400, 1.6);
      const g = this._gain(0);
      n.connect(f); f.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.5, 0.001, 0.022);
      const o = this._osc('triangle', 1900, t, 0.05);
      const og = this._gain(0);
      o.connect(og); og.connect(voice);
      this._env(og.gain, t, 0.22, 0.001, 0.036);
      this._free(voice, o);
    } catch (e) { /* ignore */ }
  }

  /** Deliberately near-subliminal; hover fires constantly. */
  uiHover() {
    if (!this._live()) return;
    try {
      const now = this.ctx.currentTime;
      if (now - this._tHover < 0.05) return;
      this._tHover = now;
      const voice = this._voice(0.05);
      if (!voice) return;
      const t = this._now();
      const o = this._osc('sine', 2950, t, 0.035);
      const g = this._gain(0);
      o.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.4, 0.002, 0.026);
      this._free(voice, o);
    } catch (e) { /* ignore */ }
  }

  /** Small add9 chord, arpeggiated just enough to feel played not triggered. */
  jobComplete() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.24);
      if (!voice) return;
      const t = this._now();
      const notes = [523.25, 659.25, 783.99, 987.77];
      let last = null;
      for (let i = 0; i < notes.length; i++) {
        const at = t + i * 0.048;
        const o = this._osc('triangle', notes[i], at, 1.0);
        const g = this._gain(0);
        o.connect(g); g.connect(voice);
        this._env(g.gain, at, 0.26 - i * 0.03, 0.012, 0.80 - i * 0.06);
        // A quiet octave above turns the triangle into something bell-ish.
        const h = this._osc('sine', notes[i] * 2, at, 0.6);
        const hg = this._gain(0);
        h.connect(hg); hg.connect(voice);
        this._env(hg.gain, at, 0.05, 0.006, 0.42);
        last = o;
      }
      this._free(voice, last);
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ mechanical */

  /** Latch click, then a hinge band sweeping down through the swing. */
  doorOpen() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.26);
      if (!voice) return;
      const t = this._now();
      this._latch(voice, t, 0.55);
      // Hinge: a band sweeping down over the swing.
      const n = this._noise(t + 0.03, 0.34);
      const f = this._filt('bandpass', 1500, 7);
      f.frequency.exponentialRampToValueAtTime(560, t + 0.33);
      const g = this._gain(0);
      n.connect(f); f.connect(g); g.connect(voice);
      this._env(g.gain, t + 0.03, 0.20, 0.03, 0.28);
      this._free(voice, n);
    } catch (e) { /* ignore */ }
  }

  /** Heavier than doorOpen: the thunk lands first, the latch catches after. */
  doorClose() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.32);
      if (!voice) return;
      const t = this._now();
      const n = this._noise(t, 0.20);
      const f = this._filt('lowpass', 300, 1.3);
      const g = this._gain(0);
      n.connect(f); f.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.7, 0.003, 0.15);
      const b = this._osc('sine', 132, t, 0.2);
      b.frequency.exponentialRampToValueAtTime(66, t + 0.14);
      const bg = this._gain(0);
      b.connect(bg); bg.connect(voice);
      this._env(bg.gain, t, 0.4, 0.004, 0.14);
      this._latch(voice, t + 0.02, 0.8);
      this._free(voice, n);
    } catch (e) { /* ignore */ }
  }

  /* The metallic click shared by both door sounds. */
  _latch(voice, t, level) {
    const n = this._noise(t, 0.05);
    const f = this._filt('bandpass', 2100, 3.5);
    const g = this._gain(0);
    n.connect(f); f.connect(g); g.connect(voice);
    this._env(g.gain, t, 0.45 * level, 0.001, 0.035);
  }

  /**
   * Footstep. Alternates band centre per step so a walk cycle doesn't turn
   * into a machine-gun of identical clicks. Rate-limited at the source.
   */
  footstep(running) {
    if (!this._live()) return;
    try {
      const now = this.ctx.currentTime;
      if (now - this._tStep < 0.09) return;
      this._tStep = now;

      const run = !!running;
      const voice = this._voice(run ? 0.2 : 0.13);
      if (!voice) return;
      const t = this._now();
      this._stepFlip ^= 1;

      const body = (this._stepFlip ? 330 : 392) * (run ? 1.12 : 1);
      const dur = run ? 0.055 : 0.085;
      const n = this._noise(t, dur + 0.04);
      const f = this._filt('bandpass', body, 1.5);
      const g = this._gain(0);
      n.connect(f); f.connect(g); g.connect(voice);
      this._env(g.gain, t, run ? 0.7 : 0.5, 0.002, dur);

      // Grit under the sole.
      const sn = this._noise(t, dur * 0.8);
      const sf = this._filt('highpass', run ? 3600 : 2800, 0.7);
      const sg = this._gain(0);
      sn.connect(sf); sf.connect(sg); sg.connect(voice);
      this._env(sg.gain, t, run ? 0.28 : 0.16, 0.001, dur * 0.7);

      this._free(voice, n);
    } catch (e) { /* ignore */ }
  }

  /** Glass and trim for the crashes that end a shift. */
  smash() {
    if (!this._live()) return;
    try {
      const voice = this._voice(0.4);
      if (!voice) return;
      const t = this._now();

      // The break itself.
      const n = this._noise(t, 0.18);
      const f = this._filt('highpass', 2200, 0.7);
      const shape = this.ctx.createWaveShaper();
      shape.curve = this.hardCurve;
      const g = this._gain(0);
      n.connect(f); f.connect(shape); shape.connect(g); g.connect(voice);
      this._env(g.gain, t, 0.55, 0.002, 0.14);

      /* Shards. Short high sines at unrelated frequencies — glass has no
         harmonic series, and picking them randomly per call means two
         smashes in a row are never the same object. */
      for (let i = 0; i < 8; i++) {
        const at = t + Math.random() * 0.13;
        const fr = 2600 + Math.random() * 4200;
        const o = this._osc('sine', fr, at, 0.14);
        o.frequency.exponentialRampToValueAtTime(hz(fr * 0.93), at + 0.12);
        const og = this._gain(0);
        o.connect(og); og.connect(voice);
        this._env(og.gain, at, 0.05 + Math.random() * 0.07, 0.001,
          0.05 + Math.random() * 0.08);
      }

      // Fragments landing.
      const tail = 0.9;
      const dn = this._noise(t + 0.05, tail + 0.05);
      const df = this._filt('bandpass', 4200, 1.1);
      const dg = this._gain(0.0001);
      dn.connect(df); df.connect(dg); dg.connect(voice);
      let gt = t + 0.08;
      const end = t + tail;
      while (gt < end) {
        const frac = (gt - t) / tail;
        dg.gain.setValueAtTime(
          Math.max(0.26 * (1 - frac) * Math.random(), 0.0001), gt);
        gt += (0.008 + Math.random() * 0.04) * (0.5 + frac * 2.2);
      }
      dg.gain.setValueAtTime(0, end + 0.01);

      this._free(voice, dn);
    } catch (e) { /* ignore */ }
  }
}
