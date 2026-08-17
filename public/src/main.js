import * as THREE from 'three';
import { World } from './world/world.js';
import { buildTerrain, buildBoundary, buildBackdrop } from './world/terrain.js';
import { buildRoads } from './world/roads.js';
import { buildBuildings, buildProps } from './world/buildings.js';
import { Sky } from './world/sky.js';
import { buildParkedCars } from './world/parking.js';
import { buildUtilities } from './world/utilities.js';
import { JobBoard } from './game/jobs.js';
import { resolveVehicleContacts, resolvePedContacts, resolveFootContacts, resolveParkedContacts, resolveKnockedContacts, resolveFootVsParked } from './game/physics.js';
import { disturbParked, stepParkedCars, cullParkedChunks } from './world/parking.js';
import { loadVehicleAssets } from './world/vehicleassets.js';
import { dentVehicle, SmokePool } from './game/effects.js';
import { Mission, SHIFT_END, OUTCOME } from './game/mission.js';
import { Audio } from './game/audio.js';
import { CAR_SPECS } from './game/vehicle.js';
import { GTAOPass } from '../vendor/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from '../vendor/jsm/postprocessing/ShaderPass.js';

/* Final grade. Runs after tonemapping on an LDR sRGB image: a soft vignette,
   a touch of film grain to break up flat gradients, and a gentle contrast/
   saturation lift so the frame doesn't sit flat and grey. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.028 },
    uContrast: { value: 1.055 },
    uSaturation: { value: 1.08 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uContrast, uSaturation;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // contrast around mid grey, then saturation
      c = (c - 0.5) * uContrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);

      // vignette
      vec2 d = vUv - 0.5;
      float vig = 1.0 - uVignette * dot(d, d) * 2.6;
      c *= vig;

      // animated grain, scaled down in the highlights so skies stay clean
      float g = hash(vUv * 1024.0 + fract(uTime) * 97.0) - 0.5;
      c += g * uGrain * (1.0 - l * 0.7);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from '../vendor/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { Input } from './core/input.js';
import { Player } from './game/player.js';
import { TrafficSim } from './game/traffic.js';
import { Enforcement } from './game/enforcement.js';
import { MiniMap, BigMap } from './game/minimap.js';
import { Radio } from './game/radio.js';
import { VIOLATIONS, SEVERITY_COLOR, EVIDENCE, fineFor } from './game/violations.js';
import { clamp, MPS_TO_MPH } from './core/util.js';

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  'loading', 'bar', 'loadmsg', 'startbtn', 'hud', 'standingVal', 'trustN', 'overN', 'heatN',
  'mTrust', 'mOver', 'mHeat', 'logbody', 'clock', 'funds', 'radioName', 'radioLine',
  'minimap', 'street', 'mph', 'limitN', 'modeLabel', 'reticle', 'radarBox', 'radarSpeed',
  'radarMeta', 'radarFlags', 'targetCard', 'tPlate', 'tName', 'tVio', 'prompt', 'toast',
  'citation', 'cWho', 'cList', 'cNone', 'cSus', 'cTotal', 'bCite', 'bWarn', 'bLet',
  'mapscreen', 'bigmap', 'help',
  'events', 'deltas', 'jobcard', 'jobTitle', 'jobWho', 'jobPay', 'jobbar',
  'objectives', 'objList', 'objBar', 'shiftClock', 'healthN', 'mHealth', 'hurt',
  'endscreen', 'endTitle', 'endLine', 'endScore', 'endStats', 'endShort', 'endBtn',
  'esCites', 'esJobs', 'esBad', 'esTrust',
]) els[id] = $(id);

const FIELD_LABEL = { trust: 'CIVIC TRUST', overreach: 'OVERREACH', heat: 'PD ATTENTION', funds: '' };

/* Pointer lock throws in some embedded/iframe contexts. It's a nicety, not a
   requirement — the game is fully playable without it. */
function lockPointer() {
  const c = $('gl');
  try {
    const r = c.requestPointerLock && c.requestPointerLock();
    // Newer Chrome returns a promise that rejects in embedded documents.
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* mouse look unavailable */ }
}
function unlockPointer() {
  try { document.exitPointerLock && document.exitPointerLock(); } catch { /* no-op */ }
}

const setProgress = (p, msg) => {
  els.bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
  if (msg) els.loadmsg.textContent = msg;
};

const state = {
  world: null, scene: null, camera: null, renderer: null,
  player: null, traffic: null, enforce: null, sky: null,
  mini: null, big: null, radio: null, input: null,
  running: false, mapOpen: false, helpOpen: false,
  last: 0, acc: 0, fps: 60, frames: 0, fpsT: 0,
};

/* ------------------------------------------------------------------ boot */

async function boot() {
  setProgress(0.04, 'fetching borough geometry');
  const world = await World.load('world');
  state.world = world;

  setProgress(0.22, 'creating renderer');
  const canvas = $('gl');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // ACES already pulls midtones down hard; at 1.02 there was no headroom and
  // the whole town sat ~1.5 stops under.
  renderer.toneMappingExposure = 1.5;
  state.renderer = renderer;

  const scene = new THREE.Scene();
  state.scene = scene;
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 4600);
  state.camera = camera;

  setProgress(0.30, 'raising terrain from USGS elevation');
  await frame();
  mark('start');
  buildTerrain(world, scene);
  buildBoundary(world, scene);
  state.backdrop = buildBackdrop(world, scene);
  mark('terrain');

  setProgress(0.48, 'paving 283 streets');
  await frame();
  buildRoads(world, scene);
  mark('roads');

  setProgress(0.62, `extruding ${world.buildings.length.toLocaleString()} building footprints`);
  await frame();
  state.buildings = buildBuildings(world, scene);
  mark('buildings');

  setProgress(0.74, 'planting trees, hanging signals');
  await frame();
  state.props = buildProps(world, scene);
  mark('props');

  setProgress(0.78, 'parking cars on every street');
  await frame();
  state.parking = buildParkedCars(world, scene);
  mark('parked cars');

  setProgress(0.84, 'stringing the pole lines');
  await frame();
  state.utilities = buildUtilities(world, scene);
  mark('utilities');

  setProgress(0.88, 'starting the sun');
  await frame();
  state.sky = new Sky(scene, renderer, world);
  mark('sky + IBL');

  /* ---- post chain
     Render -> AO -> Bloom -> tonemap -> grade -> antialias.

     Ambient occlusion is the single highest-value addition for geometry with
     no texture maps: it puts contact darkening back under eaves, kerbs, wheel
     arches and the gaps between parked cars, which is most of what stops flat
     colour from reading as moulded plastic. */
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));   // match the renderer
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));

  const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 0.85;
  gtao.updateGtaoMaterial({
    radius: 1.6,          // metres — kerb and eave scale, not room scale
    distanceExponent: 1.0,
    thickness: 1.0,
    scale: 1.0,
    samples: 12,
    screenSpaceRadius: false,
  });
  composer.addPass(gtao);
  state.gtao = gtao;

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    0.35,   // strength — pushed up at night
    0.72,   // radius
    0.86    // threshold: only genuinely bright things glow
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Vignette, film grain and a gentle S-curve, applied after tonemapping.
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  state.grade = grade;

  composer.addPass(new SMAAPass(innerWidth, innerHeight));
  state.composer = composer;
  state.bloom = bloom;
  mark('post');

  setProgress(0.90, 'looking for authored vehicle models');
  await frame();
  // No-op unless a model pack is installed in public/assets/vehicles/.
  await loadVehicleAssets('assets/vehicles', CAR_SPECS);
  mark('vehicle assets');

  setProgress(0.93, 'putting traffic on the road');
  await frame();

  // Spawn on Broad Avenue if we can find it — it's the spine of town.
  const spawn = findSpawn(world);
  // Player is built before Audio, so the handle is attached below.
  state.player = new Player(world, scene, spawn);
  state.traffic = new TrafficSim(world, scene);
  state.enforce = new Enforcement(world, state.traffic);
  // The sim needs a way back so warned drivers can reappear and so an
  // abandoned stop can cost the player something.
  state.traffic.enforcement = state.enforce;
  // And a handle on the parked fleet, so a knocked car can chain into it.
  state.traffic.parking = state.parking;
  // Audio first: JobBoard and Player both take a handle to it.
  state.audio = new Audio();
  state.player.audio = state.audio;
  state.jobs = new JobBoard(world, scene, state.enforce, state.audio);
  state.smoke = new SmokePool(scene);
  state.mission = new Mission(state.enforce, state.jobs, state.sky);
  state.radio = new Radio();
  state.input = new Input(canvas);
  state.mini = new MiniMap(world, els.minimap);
  state.big = new BigMap(world, els.bigmap);
  state.big.prewarm();   // pay for the static layer here, not on the first Tab
  state.mini.resize();

  // Warm the traffic sim so the streets aren't empty on the first frame.
  for (let i = 0; i < 90; i++) state.traffic.update(1 / 30, state.player);
  mark('traffic warmup');

  setProgress(1, 'ready');
  els.startbtn.disabled = false;
  els.startbtn.textContent = 'BEGIN SHIFT';
  els.startbtn.onclick = start;
  addEventListener('resize', onResize);
  wireUI();

  // Handy for poking at the sim from the console.
  state.physics = {
    resolveVehicleContacts, resolvePedContacts, resolveFootContacts,
    resolveParkedContacts, resolveKnockedContacts, disturbParked, stepParkedCars,
  };
  window.LEONIA = state;
}

/* Yield to the browser so the loading bar repaints between build phases.
   rAF is throttled hard in background tabs, so fall back to a timer race. */
const frame = () => new Promise((r) => {
  let done = false;
  const fire = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => setTimeout(fire, 0));
  setTimeout(fire, 60);
});

let phaseT = 0;
function mark(label) {
  const now = performance.now();
  if (phaseT) console.log(`  ${label}: ${Math.round(now - phaseT)}ms`);
  phaseT = now;
}

function findSpawn(world) {
  // Prefer a mid-rank street inside the borough, pointing along it.
  const prefer = ['Broad Avenue', 'Fort Lee Road', 'Grand Avenue', 'Leonia Avenue'];
  for (const name of prefer) {
    const road = world.roads.find((r) => r.n === name && r.p.length > 4);
    if (!road) continue;
    const i = Math.floor(road.p.length / 2);
    const a = road.p[i], b = road.p[i + 1] || road.p[i - 1];
    return { x: a[0], z: a[1], heading: Math.atan2(b[0] - a[0], b[1] - a[1]) };
  }
  const p = world.randomRoadPoint(3);
  return { x: p.x, z: p.z, heading: p.heading };
}

function onResize() {
  state.camera.aspect = innerWidth / innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(innerWidth, innerHeight);
  if (state.composer) state.composer.setSize(innerWidth, innerHeight);
  if (state.gtao) state.gtao.setSize(innerWidth, innerHeight);
  state.mini.resize();
}

/* Night dressing: window glow, street lamps, headlights, signal heads.
   Driven off the sky's day factor so everything comes up together at dusk. */
const _sigCol = new THREE.Color();
function updateNightAndSignals(dt) {
  const sky = state.sky;
  const night = 1 - clamp(sky.dayFactor * 1.5, 0, 1);

  if (state.buildings?.litMat) {
    state.buildings.litMat.opacity = night * 0.92;
    // Fully transparent additive geometry still costs fill rate; skip it.
    const lit = state.buildings.litMat.opacity > 0.01;
    for (const m of (state.buildings.litMeshes || [])) m.visible = lit;
    state.buildings.litMat.color.setRGB(1, 0.86 - night * 0.06, 0.62);
  }
  if (state.props?.lampBulbMat) {
    state.props.lampBulbMat.color.setRGB(
      0.13 + night * 0.87, 0.13 + night * 0.78, 0.11 + night * 0.52
    );
  }
  if (state.props?.lampPoolMat) {
    state.props.lampPoolMat.opacity = night * 0.55;
    if (state.props.lampPools) state.props.lampPools.visible = night > 0.02;
  }
  state.bloom.strength = 0.28 + night * 0.75;
  if (state.grade) {
    const u = state.grade.uniforms;
    u.uTime.value = performance.now() * 0.001;
    // Lean on the grade a little harder at night — more vignette, more grain.
    u.uVignette.value = 0.30 + night * 0.22;
    u.uGrain.value = 0.024 + night * 0.030;
    u.uSaturation.value = 1.09 - night * 0.16;
  }
  // Auto at dusk, but L overrides and the override sticks.
  const p = state.player;
  if (p.headlightsOverride) p.headlights = p.headlightsManual;
  else p.headlights = state.sky.dayFactor < 0.42;
  if (p.beams) for (const b of p.beams) b.intensity = p.headlights && !p.onFoot ? 3.6 : 0;

  // Traffic signal lenses: red / amber / green per axis from the sim clock.
  const lamps = state.props?.signalLamps;
  const list = state.props?.signalList;
  if (lamps && list) {
    const t = state.traffic;
    for (let i = 0; i < list.length; i++) {
      // Axis 0 runs roughly east-west; the sim alternates which one is green.
      const greenAxis = t.signalCycle;
      const late = t.signalPhase > 0.82;
      // The head's axis comes from the road bearing captured when the mast was
      // planted — index parity had lamps showing green across the sim's red.
      const rot = list[i].rot || 0;
      const axis = Math.abs(Math.sin(rot)) > Math.abs(Math.cos(rot)) ? 0 : 1;
      for (let k = 0; k < 3; k++) {
        // k: 0 = red (top), 1 = amber, 2 = green
        const myTurn = axis === greenAxis;
        let on = false;
        if (myTurn) on = late ? k === 1 : k === 2;
        else on = k === 0;
        if (on) {
          if (k === 0) _sigCol.setRGB(1.0, 0.10, 0.06);
          else if (k === 1) _sigCol.setRGB(1.0, 0.62, 0.06);
          else _sigCol.setRGB(0.16, 1.0, 0.30);
        } else {
          _sigCol.setRGB(0.055, 0.045, 0.038);
        }
        lamps.setColorAt(i * 3 + k, _sigCol);
      }
    }
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  }
}

function start() {
  els.loading.classList.add('hidden');
  els.hud.classList.remove('hidden');
  // Now that the HUD is laid out, the minimap canvas has a real size.
  state.mini.resize();
  state.running = true;
  state.last = performance.now();
  // First user gesture: this is the only moment the browser will let us start.
  state.audio.resume();
  state.audio.uiClick();
  lockPointer();
  state.enforce.say('Radar is R. Signal a stop with H. Approach with E.', 'info', 6);
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------- UI */

function wireUI() {
  els.bCite.onclick = () => resolveCitation('cite');
  els.bWarn.onclick = () => resolveCitation('warn');
  els.bLet.onclick = () => resolveCitation('let');
  // A new shift is a clean reload: the world build is deterministic, so this
  // is both the simplest and the most reliable reset available.
  els.endBtn.onclick = () => location.reload();
}

/** Freeze play and show the end-of-shift card. */
function showEndScreen(res) {
  els.endTitle.textContent = res.title;
  els.endTitle.className = res.tone;
  els.endLine.textContent = res.line;
  els.endScore.textContent = res.score.toLocaleString();
  els.endScore.style.color = res.won ? 'var(--good)' : 'var(--text)';
  els.esCites.textContent = res.citations;
  els.esJobs.textContent = res.jobs;
  els.esBad.textContent = res.badStops;
  els.esBad.style.color = res.badStops > 0 ? 'var(--bad)' : 'var(--text)';
  els.esTrust.textContent = res.trust;

  const short = state.mission.shortfall;
  if (!res.won && short) {
    els.endShort.textContent = `SHORT: ${short}`;
    els.endShort.style.display = '';
  } else {
    els.endShort.style.display = 'none';
  }

  els.endscreen.classList.remove('hidden');
  unlockPointer();
}

function resolveCitation(choice) {
  const hadEvidence = state.enforce.pendingCitation
    && state.enforce.pendingCitation.codes.length > 0;
  state.enforce.resolve(choice);
  if (choice === 'cite') {
    if (hadEvidence) state.audio.citation();
    else state.audio.denied();
  } else {
    state.audio.uiClick();
  }
  els.citation.classList.add('hidden');
  lockPointer();
}

function openCitation(pc) {
  const { npc, codes, suspected, hist } = pc;
  const prior = hist && hist.warned > 0;
  els.cWho.innerHTML = `${npc.plate} · ${npc.name} · ${npc.spec.name || 'Vehicle'}` +
    (prior
      ? `<br><span style="color:var(--hot)">PRIOR WARNING ON FILE — ${hist.warned}× · documented pattern, fine ×1.6</span>`
      : '');
  els.cList.innerHTML = '';

  if (codes.length) {
    els.cNone.classList.add('hidden');
    for (const code of codes) {
      const v = VIOLATIONS[code];
      const rec = npc.evidence.get(code) || {};
      const how = rec.lvl === EVIDENCE.SCANNED ? 'SCANNED' : 'WATCHED';
      // A speed charge should show the number you actually recorded.
      const reading = rec.mph != null && rec.limit != null
        ? ` · ${Math.round(rec.mph)} in a ${rec.limit}` : '';
      const li = document.createElement('li');
      li.innerHTML = `
        <span>
          <span style="color:${SEVERITY_COLOR[v.sev]}">${v.label}</span>
          <span class="c">— ${v.detail} · N.J.S.A. ${v.code} · ${how}${reading}</span>
        </span>
        <span class="amt">$${v.fine}</span>`;
      els.cList.appendChild(li);
    }
  } else {
    els.cNone.classList.remove('hidden');
    els.cNone.textContent =
      'You have no evidence against this driver. Nothing watched, nothing scanned. ' +
      'Citing anyway is exactly the thing you claim to be against.';
  }

  if (suspected.length) {
    els.cSus.classList.remove('hidden');
    els.cSus.innerHTML = 'HUNCHES (not admissible): ' +
      suspected.map((c) => VIOLATIONS[c]?.label || c).join(' · ') +
      '<br><span style="color:#8ea0ad">Scan the plate or witness it yourself to make these count.</span>';
  } else {
    els.cSus.classList.add('hidden');
  }

  const total = prior ? Math.round(fineFor(codes) * 1.6) : fineFor(codes);
  els.cTotal.textContent = `$${total}`;
  els.citation.classList.remove('hidden');
  unlockPointer();
}

/* ---------------------------------------------------------------- update */

function loop(now) {
  if (!state.running) return;
  requestAnimationFrame(loop);

  let dt = (now - state.last) / 1000;
  state.last = now;
  dt = Math.min(dt, 0.05);

  state.frames++;
  state.fpsT += dt;
  if (state.fpsT > 0.5) {
    state.fps = state.frames / state.fpsT;
    state.frames = 0; state.fpsT = 0;
  }

  const inp = state.input;
  const enf = state.enforce;
  inp.tick(dt);
  // The end card halts play but the world keeps rendering behind it.
  const shiftOver = state.mission.ended;
  const uiBlocking = !!enf.pendingCitation || state.mapOpen || state.helpOpen || shiftOver;

  /* The map and help screens are a pause. Previously sky.update and
     mission.update kept running behind them — the shift could end while you
     were reading the map — but the toast and delta timers did not, so time
     advanced inconsistently. Freeze the world together. */
  const paused = state.mapOpen || state.helpOpen;
  if (!shiftOver && !paused) {
    state.mission.update(dt);
    if (state.mission.ended) showEndScreen(state.mission.endedAt);
  }

  // ---- global keys
  if (inp.hit('Tab')) { state.mapOpen = !state.mapOpen; els.mapscreen.classList.toggle('hidden', !state.mapOpen); if (state.mapOpen) unlockPointer(); else lockPointer(); }
  if (inp.hit('Slash') || inp.hit('F1')) toggleHelp();
  if (inp.hit('Escape')) { if (state.helpOpen) toggleHelp(); else if (state.mapOpen) { state.mapOpen = false; els.mapscreen.classList.add('hidden'); lockPointer(); } }
  if (inp.hit('KeyN')) { const s = state.radio.cycle(); enf.say(`Tuned to ${s.name}`, 'info', 2.4); }
  if (inp.hit('KeyM')) { const on = state.radio.toggle(); enf.say(on ? 'Radio on.' : 'Radio off. Better.', 'info', 2.2); }
  // Master audio mute. A browser game that synthesises with no way to silence
  // it is not shippable.
  if (inp.hit('KeyK')) {
    const muted = !state.audio.muted;
    state.audio.setMuted(muted);
    enf.say(muted ? 'Audio muted. [K]' : 'Audio on. [K]', 'info', 2.2);
  }
  /* Skipping time is a real verb (school zones and rush hour are time-gated),
     but it must not be able to end your shift — four presses used to run the
     clock straight past 20:00 and resolve the day. Clamp short of the bell. */
  if (inp.hit('KeyT') && !state.mapOpen && !state.helpOpen) {
    const limit = SHIFT_END - 0.25;
    if (state.sky.time >= limit) {
      enf.say('Too late in the shift to wait around.', 'warn', 2.4);
    } else {
      state.sky.time = Math.min(limit, state.sky.time + 3);
      enf.say(`Waited until ${state.sky.clockString}`, 'info', 2.4);
    }
  }
  if (inp.hit('KeyL')) {
    state.player.headlightsManual = !state.player.headlightsManual;
    state.player.headlightsOverride = true;
  }

  // ---- citation hotkeys
  if (enf.pendingCitation) {
    if (inp.hit('Digit1')) resolveCitation('cite');
    else if (inp.hit('Digit2')) resolveCitation('warn');
    else if (inp.hit('Digit3')) resolveCitation('let');
  }

  // ---- sim
  if (!state.mapOpen && !state.helpOpen && !shiftOver) {
    state.player.update(dt, inp, state.camera, uiBlocking);
    // One definition of night for everyone; sky.isNight is hour-based and
    // disagreed with the dayFactor curve the player's lights used.
    state.traffic.headlightsOn = state.sky.dayFactor < 0.42;
    state.traffic.update(dt, state.player);

    /* ---- contact.
       Traffic is kinematic, so nothing stops the player driving through it
       unless we resolve it explicitly after both have moved. */
    if (!state.player.onFoot) {
      const v = state.player.vehicle;

      // Crumple from a wall or pole hit, queued by the vehicle model.
      if (v.pendingDent) {
        const pd = v.pendingDent;
        v.pendingDent = null;
        dentVehicle(state.player.carMesh, v.heading, v.x, v.z,
          pd.crushX, pd.crushZ, pd.cx, pd.cz, pd.severity);
        state.player.shake = Math.max(state.player.shake, Math.min(0.6, pd.severity * 0.04));
        state.audio.impact(pd.severity);
        // Driving into a house was previously free — the most common
        // high-speed crash in the game cost nothing.
        if (pd.severity > 6) {
          state.mission.hurt((pd.severity - 6) * 1.5,
            `${Math.round(pd.severity * 2.24)} mph impact`);
        }
      }

      resolveVehicleContacts(v, state.traffic, dt, (npc, severity, hit) => {
        state.player.shake = Math.min(0.7, severity * 0.045);
        state.audio.impact(severity);
        if (severity > 12) state.audio.smash();
        // Above a walking-pace tap, a crash hurts the person in the seat.
        if (severity > 8) {
          state.mission.hurt((severity - 8) * 1.0, `${Math.round(severity * 2.24)} mph collision`);
        }
        if (hit) {
          // Metal folds inward on both cars at the shared contact point.
          dentVehicle(state.player.carMesh, v.heading, v.x, v.z,
            -hit.nx, -hit.nz, hit.cx, hit.cz, severity);
          dentVehicle(npc.mesh, npc.heading, npc.x, npc.z,
            hit.nx, hit.nz, hit.cx, hit.cz, severity);
        }
        if (severity > 3) {
          enf.adjust('trust', -clamp(severity * 0.4, 0, 9), `rammed ${npc.plate}`,
            enf.COLLISION_TRUST_FLOOR);
          enf.adjust('heat', clamp(severity * 1.9, 0, 30), 'collision with another vehicle');
          enf.pushEvent('crash', 'COLLISION', `${npc.plate} · ${Math.round(severity * 2.24)} mph impact`, 'clean');
        }
      });
      // Anything already punted keeps colliding with the rest of traffic.
      resolveKnockedContacts(state.traffic, dt);

      // Tyre squeal on slip onset, not every frame of a long slide.
      const slip = clamp(Math.abs(v.lateral) / 7, 0, 1);
      if (slip > 0.35 && (state.lastSlip || 0) <= 0.35) state.audio.skid(slip);
      state.lastSlip = slip;
      resolveParkedContacts(v, state.parking, state.world, dt,
        (car, vx, vz, spin) => disturbParked(car, vx, vz, spin, state.parking),
        (car, severity, hit) => {
          state.player.shake = Math.max(state.player.shake, Math.min(0.6, severity * 0.04));
          state.audio.impact(severity * 0.85);
          if (severity > 8) {
            state.mission.hurt((severity - 8) * 0.85, 'struck a parked vehicle');
          }
          // Parked fleet is instanced, so only the player's shell crumples.
          if (hit) {
            dentVehicle(state.player.carMesh, v.heading, v.x, v.z,
              -hit.nx, -hit.nz, hit.cx, hit.cz, severity);
          }
          if (severity > 2.5) {
            enf.adjust('trust', -clamp(severity * 0.32, 0, 7), 'hit a parked car',
              enf.COLLISION_TRUST_FLOOR);
            enf.adjust('heat', clamp(severity * 1.5, 0, 24), 'unattended vehicle damage');
            enf.pushEvent('crash', 'PARKED VEHICLE STRUCK',
              `${car.spec.name} · ${Math.round(severity * 2.24)} mph`, 'clean');
          }
        });
      resolvePedContacts(v, state.traffic, state.world, dt, (ped, speed) => {
        const mph = Math.round(speed * 2.23694);
        state.audio.pedImpact(speed);
        /* Hitting someone is still the most expensive act in the game, but a
           single one is a hole to climb out of, not the end of the run. Trust
           bottoms out at the collision floor; what escalates instead is the
           repeat multiplier, which has no floor on overreach. One accident is
           forgiven. Working through a crosswalk is not. */
        enf.pedStrikes++;
        const rep = 1 + 0.6 * Math.min(enf.pedStrikes - 1, 3);
        enf.adjust('trust', -clamp((9 + speed * 0.85) * rep, 0, 30),
          `you hit a pedestrian at ${mph} mph`, enf.COLLISION_TRUST_FLOOR);
        enf.adjust('overreach', clamp((6 + speed * 0.4) * rep, 0, 34), 'you hit a pedestrian');
        enf.adjust('heat', clamp((20 + speed) * rep, 0, 70), 'pedestrian struck');
        state.mission.hurt(3, 'you hit someone');
        enf.say(enf.pedStrikes === 1
          ? `You hit someone at ${mph} mph. Stop, and earn that back.`
          : `Again — ${mph} mph. The town is counting, and so is the penalty.`,
          'bad', 6);
        enf.addLog({ kind: 'bad', plate: '—',
          text: `Struck a pedestrian at ${mph} mph${enf.pedStrikes > 1 ? ` (#${enf.pedStrikes})` : ''}` });
      });
    } else {
      resolveFootVsParked(state.player, state.parking);
      resolveFootContacts(state.player, state.traffic, dt, (npc, speed) => {
        enf.say(`${npc.plate} put you on the pavement.`, 'bad', 4);
        enf.adjust('heat', 6, 'you were struck in the roadway');
        // On foot there is no crumple zone; this is the fastest way to lose.
        state.mission.hurt(10 + speed * 1.6, `struck on foot by ${npc.plate}`);
        state.player.shake = Math.min(0.9, 0.3 + speed * 0.05);
      });
    }

    const camDir = state.player.camDir;
    enf.updateObservation(dt, state.player, camDir);

    // Aim with right-mouse (or hold R); capture with left-mouse. A scan is a
    // deliberate act — panning the reticle across a street must not silently
    // rubber-stamp the whole block as admissible evidence.
    const aiming = (inp.rightDown || inp.down('KeyR')) && !uiBlocking;
    enf.updateRadar(dt, state.player, camDir, aiming);
    // A fresh lock chirps once, not every frame it stays locked.
    if (enf.radarLocked && !state.wasLocked) state.audio.radarLock();
    state.wasLocked = enf.radarLocked;

    if (aiming && (inp.leftHit || inp.hit('KeyC'))) {
      if (enf.captureScan()) state.audio.radarCapture();
      else if (enf.radarTarget && !enf.scanArmed) {
        enf.say('Already captured — that reading is on the record.', 'info', 1.6);
      } else if (enf.radarTarget) {
        state.audio.denied();
        enf.say('No lock yet — hold the reticle on them.', 'warn', 1.8);
      }
    }

    enf.updatePlayerConduct(dt, state.player, state.player.onFoot ? null : state.player.vehicle);

    // Tap H for the horn; hold it to signal a stop, so nobody initiates a
    // legal stop by reflex reaching for a car horn.
    if (!uiBlocking) {
      if (inp.held('KeyH') > 0.4 && !state.hSignalled) {
        state.hSignalled = true;
        enf.requestPullOver(state.player, camDir);
      } else if (inp.releasedShort('KeyH', 0.4) && !state.hSignalled) {
        enf.say('*honk*', 'info', 1.1);
      }
      if (!inp.down('KeyH')) state.hSignalled = false;
    }

    if (!uiBlocking && inp.hit('KeyE')) {
      if (enf.tryApproach(state.player)) openCitation(enf.pendingCitation);
      else if (state.traffic.near(state.player.x, state.player.z, 11)
        .some(({ npc }) => npc.pullState === 'stopped')) {
        enf.say('Get out of the car and walk up to them. [F]', 'warn', 3);
      }
    }

    // Ambient road hum scales with how much traffic is actually around you.
    {
      let n = 0;
      for (const npc of state.traffic.npcs) {
        if (!npc.active) continue;
        const dx = npc.x - state.player.x, dz = npc.z - state.player.z;
        if (dx * dx + dz * dz < 1600) n++;
      }
      state.nearbyCount = n;
    }

    // Anything shunted out of a parking space is still rolling.
    stepParkedCars(state.parking, state.world, dt);
    // Keep distant parked chunks off both the colour and shadow passes.
    state.parkedChunksShown = cullParkedChunks(state.parking, state.player.x, state.player.z);

    /* ---- engine smoke.
       The player's car smokes past ~55 damage (oil-black past 110), and any
       badly hit NPC does the same, so a wreck keeps telling its story. */
    state.smokeT = (state.smokeT || 0) - dt;
    if (state.smokeT <= 0) {
      state.smokeT = 0.11;
      const v = state.player.vehicle;
      if (!state.player.onFoot && v.damage > 55) {
        const [fx, fz] = v.forward;
        state.smoke.emit(
          v.x + fx * v.spec.len * 0.40, v.y + v.spec.h * 0.75, v.z + fz * v.spec.len * 0.40,
          v.damage > 110
        );
      }
      const hurt = state.traffic.npcs.filter((n) => n.active && (n.damage || 0) > 50);
      if (hurt.length) {
        const n = hurt[(state.smokeIdx = ((state.smokeIdx || 0) + 1) % hurt.length)];
        const fx = Math.sin(n.heading), fz = Math.cos(n.heading);
        state.smoke.emit(
          n.x + fx * n.spec.len * 0.40, n.y + n.spec.h * 0.75, n.z + fz * n.spec.len * 0.40,
          n.damage > 110
        );
      }
    }
    state.smoke.update(dt);

    // Handyman work: hold Q at the marker.
    state.jobs.update(dt, state.player, inp.down('KeyQ') && !uiBlocking);
  }

  /* The horn is driven unconditionally. Inside the sim guards it could latch:
     open the map or hit 20:00 with H down and horn(false) was never delivered,
     so the tone sustained forever with no reachable way to stop it. */
  const hornOn = !paused && !shiftOver && !enf.pendingCitation
    && inp.down('KeyH') && inp.held('KeyH') <= 0.4;
  state.audio.horn(hornOn);
  /* PD attention finally has a voice: above 70 heat a siren closes in, which
     is the only warning before the borough cites you at 100. */
  state.audio.siren(!paused && !shiftOver && enf.heat > 70);

  state.sky.update(paused || shiftOver ? 0 : dt, state.player);
  state.radio.update(dt);
  updateNightAndSignals(dt);

  /* ---- audio bed. Engine tone tracks a load proxy rather than raw speed, so
     it lifts under throttle and backs off when you lift, and slip drives the
     tyre squeal. Cheap enough to run unconditionally. */
  {
    const p = state.player;
    const v = p.vehicle;
    // Once the shift resolves, feed silence rather than the frozen last frame,
    // which otherwise holds an engine tone under the end card forever.
    const spd = shiftOver ? 0 : Math.abs(v.speed);
    state.audio.update(dt, {
      speedMps: p.onFoot ? p.footSpeed : spd,
      throttle: shiftOver ? 0 : (p.throttleNow || 0),
      rpmNorm: clamp(0.12 + (spd / Math.max(8, v.spec.topMps)) * 0.88, 0, 1),
      onFoot: shiftOver ? true : p.onFoot,
      slipAmount: clamp(Math.abs(v.lateral) / 7, 0, 1),
      damage: v.damage,
      nearbyTraffic: state.nearbyCount,
      isNight: state.sky.isNight,
    });
  }

  updateHUD(dt);

  if (state.mapOpen) state.big.draw(state.player, state.traffic);
  else state.mini.draw(state.player, state.traffic, enf);

  state.composer.render();
  inp.endFrame();
}

function toggleHelp() {
  state.helpOpen = !state.helpOpen;
  els.help.classList.toggle('hidden', !state.helpOpen);
  if (state.helpOpen) unlockPointer();
  else lockPointer();
}

/* ------------------------------------------------------------------ HUD */

let lastLogLen = -1;

function updateHUD(dt) {
  const enf = state.enforce;
  const p = state.player;
  const w = state.world;

  // standing
  const st = enf.standing;
  els.standingVal.textContent = st.label;
  els.standingVal.style.color = st.color;
  els.trustN.textContent = Math.round(enf.trust);
  els.overN.textContent = Math.round(enf.overreach);
  els.heatN.textContent = Math.round(enf.heat);
  els.mTrust.firstElementChild.style.width = `${enf.trust}%`;
  els.mOver.firstElementChild.style.width = `${enf.overreach}%`;
  els.mHeat.firstElementChild.style.width = `${enf.heat}%`;

  // clock / funds / radio
  els.clock.textContent = state.sky.clockString;
  els.funds.textContent = `$${enf.funds.toLocaleString()}`;
  const rd = state.radio.display;
  els.radioName.textContent = rd.name;
  els.radioLine.textContent = rd.line;

  // speed
  const mph = Math.round(p.mph);
  const lim = w.speedLimitAt(p.x, p.z);
  els.mph.textContent = mph;
  els.limitN.textContent = lim.mph;
  els.mph.className = mph > lim.mph + 20 ? 'way-over' : mph > lim.mph + 8 ? 'over' : '';
  els.modeLabel.textContent = p.onFoot ? 'ON FOOT' : 'VEHICLE';
  els.street.textContent = w.streetNameAt(p.x, p.z) || (lim.onRoad ? 'unnamed road' : 'off road');

  // radar
  const showRadar = enf.radarActive;
  els.reticle.classList.toggle('on', showRadar);
  els.radarBox.classList.toggle('on', showRadar);
  if (showRadar) {
    const t = enf.radarTarget;
    if (!t) {
      els.radarSpeed.textContent = '—';
      els.radarSpeed.style.color = '';
      els.radarMeta.textContent = 'NO LOCK';
      els.radarFlags.innerHTML = '';
    } else {
      const tm = t.speed * MPS_TO_MPH;
      const locked = enf.radarLocked;
      els.radarSpeed.textContent = locked ? Math.round(tm) : '· · ·';
      const over = tm - t.currentLimit;
      els.radarSpeed.style.color = !locked ? '#8ea0ad'
        : over >= 20 ? 'var(--bad)' : over >= 10 ? 'var(--hot)' : 'var(--good)';
      els.radarMeta.textContent = locked
        ? `${t.plate} · LIMIT ${t.currentLimit} · ${t.currentRoadName || 'unnamed'}`
        : `ACQUIRING · ${t.plate}`;
      if (locked) {
        // Only what a radar can actually tell you: the number, and whether
        // the reading is citable. Everything else needs your own eyes.
        const band = over >= 10
          ? `<span style="color:${over >= 20 ? '#e0554a' : '#e8873a'}">${Math.round(over)} OVER — CITABLE</span>`
          : over > 2
            ? `<span style="color:#e8c15a">${Math.round(over)} over — under the threshold</span>`
            : '<span style="color:#5fd18a">at the limit</span>';
        els.radarFlags.innerHTML = enf.scanArmed
          ? `${band}<br><span style="color:#8ea0ad">[LEFT CLICK] capture</span>`
          : `${band}<br><span style="color:#5fd18a">CAPTURED</span>`;
      } else els.radarFlags.innerHTML = '';
    }
  }

  // target card for the driver being stopped
  const tgt = enf.target;
  if (tgt && tgt.pullState && tgt.pullState !== 'cited') {
    els.targetCard.classList.remove('hidden');
    els.tPlate.textContent = tgt.plate;
    els.tName.textContent = `${tgt.name} · ${tgt.spec.name || 'Vehicle'} · ${tgt.pullState.toUpperCase()}`;
    const ev = [];
    for (const [code, rec] of tgt.evidence) {
      const v = VIOLATIONS[code];
      if (!v) continue;
      ev.push(`<span style="color:${SEVERITY_COLOR[v.sev]}">${v.label}</span> <span style="color:#8ea0ad">— ${rec.lvl === EVIDENCE.SCANNED ? 'scanned' : 'watched'}</span>`);
    }
    const vHtml = ev.length ? ev.join('<br>') : '<span style="color:#e8c15a">no evidence on record</span>';
    if (vHtml !== state._vioKey) { state._vioKey = vHtml; els.tVio.innerHTML = vHtml; }
  } else {
    els.targetCard.classList.add('hidden');
  }

  // contextual prompt
  let prompt = null;
  if (!enf.pendingCitation) {
    const job = state.jobs.current;
    const stopped = state.traffic.near(p.x, p.z, 11).find(({ npc }) => npc.pullState === 'stopped');
    if (stopped && p.onFoot) prompt = '<kbd>E</kbd> approach the driver';
    else if (stopped) prompt = '<kbd>F</kbd> step out, then <kbd>E</kbd> approach';
    else if (job && job.inRange) prompt = '<kbd>Q</kbd> hold to work';
    else if (job && job.dist < 22 && !p.onFoot) prompt = '<kbd>F</kbd> step out for the job';
    else if (enf.target && enf.target.pullState === 'yielding') prompt = 'they are pulling over — stop behind them';
    else if (p.onFoot) prompt = '<kbd>F</kbd> get back in · hold <kbd>RMB</kbd> radar';
    else prompt = 'hold <kbd>RMB</kbd> radar · hold <kbd>H</kbd> signal a stop';
  }
  if (prompt) {
    if (prompt !== state._promptKey) { state._promptKey = prompt; els.prompt.innerHTML = prompt; }
    els.prompt.classList.remove('hidden');
  }
  else els.prompt.classList.add('hidden');

  // evidence events — the beat where you register that you saw something
  /* innerHTML is a full parse + DOM teardown + style recalc. These were being
     rebuilt every frame; only touch them when the content actually changes. */
  const lastE = enf.events[enf.events.length - 1];
  const evKey = enf.events.length + ':' + (lastE?.title || '') + ':' + (lastE?.detail || '');
  if (evKey !== state._evKey) {
    state._evKey = evKey;
    els.events.innerHTML = enf.events.map((e) =>
    `<div class="evcard panel ${e.tone}"><div class="h">${e.title}</div><div class="d">${e.detail}</div></div>`
    ).join('');
  }

  // stat deltas, with the reason attached
  /* Include the last entry's VALUE. adjust() merges repeats in place without
     changing length or reason, so a length+reason key pinned the speeding
     card at its first frame and it never accumulated. */
  const lastD = enf.deltas[enf.deltas.length - 1];
  const dKey = enf.deltas.length + ':' + (lastD?.reason || '') + ':' + (lastD ? lastD.delta.toFixed(1) : '');
  if (dKey !== state._dKey) {
    state._dKey = dKey;
    els.deltas.innerHTML = enf.deltas.map((d) => {
    const up = d.delta > 0;
    const lab = FIELD_LABEL[d.field];
    const amt = d.field === 'funds'
      ? `${up ? '+' : '-'}$${Math.abs(Math.round(d.delta))}`
      : `${up ? '+' : ''}${Math.abs(d.delta) < 1 ? d.delta.toFixed(1) : Math.round(d.delta)}`;
    const good = d.field === 'trust' || d.field === 'funds' ? up : !up;
      return `<div class="delta ${good ? 'up' : 'down'}"><b>${amt}${lab ? ' ' + lab : ''}</b><br><span class="r">${d.reason}</span></div>`;
    }).join('');
  }

  // ---- shift objectives
  const M = state.mission;
  els.shiftClock.textContent = M.clockString;
  els.shiftClock.style.color = M.hoursLeft < 2 ? 'var(--warn)' : 'var(--cyan)';
  const objs = M.objectives;
  const oKey = objs.map((o) => o.have + '/' + o.need + (o.done ? '!' : '')).join('|');
  if (oKey !== state._oKey) {
    state._oKey = oKey;
    els.objList.innerHTML = objs.map((o) =>
      `<div class="o${o.done ? ' done' : ''}"><span class="n">${o.label}</span>` +
      `<span class="v">${o.have}/${o.need}</span></div>`
    ).join('');
  }
  let doneCount = 0;
  for (const o of objs) if (o.done) doneCount++;
  els.objBar.firstElementChild.style.width = `${(doneCount / objs.length) * 100}%`;

  // ---- condition
  els.healthN.textContent = Math.round(M.health);
  els.mHealth.firstElementChild.style.width = `${M.health}%`;
  els.mHealth.className = `meter${M.health < 25 ? ' crit' : M.health < 55 ? ' low' : ''}`;
  els.hurt.style.opacity = (!M.ended && M.health < 55) ? (1 - M.health / 55) * 0.85 : 0;

  // handyman job
  const job = state.jobs.current;
  if (job) {
    els.jobcard.classList.remove('hidden');
    els.jobTitle.textContent = job.def.title;
    els.jobWho.textContent = job.inRange
      ? `${job.name} — hold [Q] to work`
      : `${job.name} · ${job.street} · ${Math.round(job.dist || 0)} m`;
    els.jobPay.textContent = `$${job.pay}`;
    els.jobbar.firstElementChild.style.width = `${Math.round(job.progress * 100)}%`;
  } else {
    els.jobcard.classList.add('hidden');
  }

  // toast
  if (enf.toast && enf.toastTime > 0) {
    els.toast.textContent = enf.toast.text;
    els.toast.className = `panel on ${enf.toast.tone}`;
  } else {
    els.toast.className = 'panel';
  }

  // log
  if (enf.log.length !== lastLogLen) {
    lastLogLen = enf.log.length;
    els.logbody.innerHTML = enf.log.slice(0, 7).map((e) => {
      if (e.kind === 'cite') return `<div class="e"><span class="p">${e.plate}</span> cited · $${e.fine}<br><span style="color:#8ea0ad">${e.codes.map((c) => VIOLATIONS[c].label).join(', ')}</span></div>`;
      if (e.kind === 'warn') return `<div class="e"><span class="p">${e.plate}</span> warned</div>`;
      if (e.kind === 'job') return `<div class="e">${e.text}<br><span style="color:#5fd18a">+$${e.pay}</span></div>`;
      if (e.kind === 'flee') return `<div class="e" style="color:#e0554a">${e.plate} refused to stop</div>`;
      if (e.kind === 'bad') return `<div class="e" style="color:#e0554a">${e.plate} — ${e.text}</div>`;
      if (e.kind === 'self') return `<div class="e" style="color:#e0554a">${e.text}</div>`;
      return '';
    }).join('');
  }

}

/* ---------------------------------------------------------------- launch */

boot().catch((err) => {
  console.error(err);
  els.loadmsg.innerHTML = `<span style="color:#e0554a">failed to load: ${err.message}</span>`;
});
