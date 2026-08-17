/* Dashboard radio. Three stations, all of them exhausting in different ways,
   which is the point — the character's whole deal is that the shouting is
   noise and the stop sign on Christie Heights is real. Press N to change
   station, M to shut it off, which is the option the game quietly endorses. */

const STATIONS = [
  {
    id: 'WRGE',
    name: 'WRGE 1310 — The Grievance',
    tag: 'talk radio, right lane',
    lines: [
      'Caller says the county is coming for your gas stove. Caller has not left the house since March.',
      'Host has identified the real enemy, and it is a zoning subcommittee.',
      'Six minutes of ad reads for gold coins, then back to the collapse of everything.',
      'A man is very angry about a bike lane that was never actually built.',
      'Breaking: someone put up a flag. Someone else took a photo of the flag. That is the segment.',
      'Host promises to name names after the break. Host names no names.',
    ],
  },
  {
    id: 'KPFR',
    name: 'KPFR 89.1 — Community Signal',
    tag: 'talk radio, left lane',
    lines: [
      'Panel has spent nineteen minutes deciding whether the word "neighborhood" is doing harm.',
      'A guest is explaining that the traffic study is itself a form of violence.',
      'Pledge drive. Tote bags. Nobody has mentioned the intersection that keeps eating cyclists.',
      'Someone has proposed a working group to study forming a working group.',
      'Host apologizes for the previous segment, then delivers an identical segment.',
      'Land acknowledgment, then four minutes of dead air, then jazz.',
    ],
  },
  {
    id: 'WBGN',
    name: 'WBGN 640 — Bergen Traffic & Weather',
    tag: 'the only useful one',
    lines: [
      'Delays on the approach to the bridge. Nobody is surprised. Nobody has ever been surprised.',
      'Overpeck Creek fog through the morning. Watch the dip on the west side.',
      'Borough council reminds residents that the 25 limit is not a suggestion. It is treated as one.',
      'Two-car fender bender on Broad. Both drivers are fine. Both drivers are furious.',
      'School zone flashers are on. Nobody has slowed down. This has been your traffic report.',
      'Palisades ridge is clear. Everything below it is not.',
    ],
  },
];

export class Radio {
  constructor() {
    this.stationIdx = 2;      // start on the traffic station
    this.on = true;
    this.line = '';
    this.timer = 0;
    this.interval = 13;
    this.next();
  }

  get station() { return STATIONS[this.stationIdx]; }

  next() {
    const s = this.station;
    const opts = s.lines.filter((l) => l !== this.line);
    this.line = opts[Math.floor(Math.random() * opts.length)];
    this.timer = 0;
  }

  cycle() {
    this.on = true;
    this.stationIdx = (this.stationIdx + 1) % STATIONS.length;
    this.next();
    return this.station;
  }

  toggle() {
    this.on = !this.on;
    return this.on;
  }

  update(dt) {
    if (!this.on) return;
    this.timer += dt;
    if (this.timer > this.interval) this.next();
  }

  get display() {
    if (!this.on) return { name: 'RADIO OFF', tag: 'blessed silence', line: '' };
    return { name: this.station.name, tag: this.station.tag, line: this.line };
  }
}
