import * as THREE from 'three';
import { clamp, lerp } from '../core/util.js';
import { paletteAt } from './palette.js';

/* Time of day drives sun angle, light colour, fog and street lamps.
   One in-game day is 24 real minutes by default. */

export class Sky {
  constructor(scene, renderer, world) {
    this.scene = scene;
    this.renderer = renderer;
    this.world = world;
    this.time = 9.5;            // hours
    /* 48 real minutes per game day, so the 08:00-20:00 shift is ~24 real
       minutes. At 24 min/day the shift was 12 minutes for 5 evidenced citations
       plus 3 jobs, which is not enough time for the stop cycle the design
       actually wants you to take slowly. */
    this.daySeconds = 2880;
    this.paused = false;

    this.hemi = new THREE.HemisphereLight(0x9fb6cc, 0x4a4a3f, 0.65);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const d = 190;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    // normalBias was 0.6 — 20x too large, which pushed every shadow off its
    // caster. Nothing had contact: cars floated above their own shadow and
    // tree trunks had none at all. Tight near/far keeps depth precision.
    this.sun.shadow.camera.near = 180;
    this.sun.shadow.camera.far = 520;
    this.sun.shadow.bias = -0.00005;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky dome
    const geo = new THREE.SphereGeometry(4200, 24, 16);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2e5f9e) },
        bottom: { value: new THREE.Color(0xf0a05a) },
        glow: { value: new THREE.Color(0xffc266) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunCol: { value: new THREE.Color(0xffd9a0) },
        haze: { value: 0.5 },
        uTime: { value: 0 },
        cover: { value: 0.52 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 bottom; uniform vec3 glow;
        uniform vec3 sunDir;
        uniform vec3 sunCol; uniform float haze; uniform float uTime;
        uniform float cover;
        varying vec3 vDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int k = 0; k < 4; k++) { s += vnoise(p) * a; p *= 2.03; a *= 0.5; }
          return s;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          float d = max(dot(dir, normalize(sunDir)), 0.0);

          /* A three-stop gradient, not two: zenith, horizon, and a warm glow
             band that sits just above the skyline and wraps toward the sun.
             The glow is what makes the sky read as a printed poster rather
             than a lerp — it gives the horizon a colour of its own. */
          vec3 col = mix(bottom, top, pow(h, 0.62));
          float band = pow(1.0 - clamp(abs(dir.y) * 2.6, 0.0, 1.0), 2.0);
          float toward = pow(clamp(d * 0.5 + 0.5, 0.0, 1.0), 2.2);
          col = mix(col, glow, band * (0.35 + 0.65 * toward) * 0.85);

          /* Cloud deck, deliberately flattened. The threshold is hard and the
             shading is two-tone, so clouds become flat shapes with defined
             edges — cut paper rather than photographed vapour. They are also
             stretched along x, which reads as stratified high cloud. */
          if (dir.y > 0.015) {
            vec2 p = dir.xz / dir.y * 0.55 + vec2(uTime * 0.0035, uTime * 0.0018);
            float n = fbm(p * vec2(0.9, 2.4));
            float m = smoothstep(cover, cover + 0.11, n);
            m *= smoothstep(0.015, 0.26, dir.y);
            // Two flat tones: sunward faces take the glow, the rest go cool.
            vec3 cloudLit  = mix(glow, sunCol, 0.35) * 1.06;
            vec3 cloudCore = mix(top, bottom, 0.35) * 0.86;
            vec3 cloud = mix(cloudCore, cloudLit, smoothstep(0.30, 0.72, n * (0.55 + 0.75 * toward)));
            col = mix(col, cloud, m * 0.80);
          }

          col += sunCol * pow(d, 300.0) * 2.2;              // disc, tighter
          col += glow * pow(d, 4.0) * 0.30 * haze;          // wide warm bloom
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.dome = new THREE.Mesh(geo, this.skyMat);
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    /* Exponential-squared, not linear. Linear fog with far = 2300 bleached the
       whole town silhouette to near-white by 800 m; exp2 keeps near geometry
       clean and only builds density in the true distance. */
    /* Kept only as a gentle blend for geometry the depth pass cannot reach
       cleanly (transparents, the far skirt). The real aerial perspective — the
       two-colour distance banding — lives in the atmosphere pass in main.js. */
    scene.fog = new THREE.FogExp2(0xd98f63, 0.00016);

    // ---- image-based lighting
    // A second, tiny scene holding only a copy of the sky shader, convolved
    // into a PMREM probe. This is what makes glass, chrome and car paint pick
    // up the real colour of the sky at this hour instead of looking like clay.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envMat = this.skyMat.clone();
    this.envMat.uniforms = this.skyMat.uniforms;      // share, so it tracks the sun
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 16, 12), this.envMat);
    this.envScene.add(envDome);
    // A dim ground plane so the lower hemisphere isn't pure sky.
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(49, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3d4238, side: THREE.BackSide })
    );
    this.envScene.add(ground);
    this.envRT = null;
    this.envAge = 99;
    this.envLastDay = -1;

    this.update(0);
    this.refreshEnvironment(true);
  }

  /** Rebuild the IBL probe. Cheap enough a few times a minute, not per frame. */
  refreshEnvironment(force = false) {
    /* Skip if it's too soon OR the sky hasn't meaningfully changed. With && the
       second clause stopped mattering the moment envAge passed 4, so the probe
       rebuilt every 4 s forever — a full cubemap render plus convolution plus a
       render-target realloc, i.e. a permanent hitch every four seconds. */
    if (!force && (this.envAge < 4 || Math.abs(this.dayFactor - this.envLastDay) < 0.04)) return;
    this.envAge = 0;
    this.envLastDay = this.dayFactor;
    const prev = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0.04);
    this.scene.environment = this.envRT.texture;
    if (prev) prev.dispose();
  }

  get isNight() { return this.time < 6.4 || this.time > 19.2; }

  update(dt, focus) {
    if (!this.paused) {
      this.time = (this.time + (dt / this.daySeconds) * 24) % 24;
    }

    // Sun elevation: peaks near 13:00.
    const t = ((this.time - 6) / 12) * Math.PI;      // 0 at 06:00, PI at 18:00
    const elev = Math.sin(t);
    const azim = ((this.time - 6) / 24) * Math.PI * 2 + 0.6;

    const dir = new THREE.Vector3(
      Math.cos(azim) * 0.75,
      Math.max(elev, -0.35),
      Math.sin(azim) * 0.75
    ).normalize();

    const fx = focus ? focus.x : 0;
    const fz = focus ? focus.z : 0;
    const fy = focus ? focus.y : 0;
    this.sun.position.set(fx + dir.x * 320, fy + dir.y * 320, fz + dir.z * 320);
    this.sun.target.position.set(fx, fy, fz);
    this.sun.target.updateMatrixWorld();

    /* The old curve was `clamp(elev * 1.9)`, which pinned to full daylight
       from 08:07 to 15:53 — eight identical hours, no golden hour — and then
       fell off a cliff, so 16:30 read as night under a still-blue sky.
       Smoothstep holds light later and gives a real dusk ramp. */
    const s = clamp((elev + 0.05) / 0.40, 0, 1);
    const day = s * s * (3 - 2 * s);
    // Golden hour: sun low but still up.
    const golden = clamp(1 - Math.abs(elev - 0.11) / 0.16, 0, 1);
    const dusk = clamp(1 - Math.abs(elev) * 3.2, 0, 1);

    /* Everything below is sampled from one palette keyframed across the day,
       rather than each value being lerped on its own curve. That is what keeps
       sun, sky, shade and haze in a single harmony at every hour instead of
       drifting into unrelated colours at the in-between times. */
    const pal = paletteAt(this.time);

    this.sun.intensity = pal.sunI;
    this.sun.color.copy(pal.sun);

    this.hemi.intensity = pal.hemiI;
    this.hemi.color.copy(pal.hemiSky);
    this.hemi.groundColor.copy(pal.hemiGnd);

    this.skyMat.uniforms.top.value.copy(pal.skyTop);
    this.skyMat.uniforms.bottom.value.copy(pal.skyHorizon);
    this.skyMat.uniforms.glow.value.copy(pal.skyGlow);
    this.skyMat.uniforms.sunDir.value.copy(dir);
    this.skyMat.uniforms.sunCol.value.copy(pal.sun);
    this.skyMat.uniforms.haze.value = 0.45 + dusk * 0.85;

    if (focus) this.dome.position.set(focus.x, 0, focus.z);
    this.dayFactor = day;
    this.palette = pal;

    /* The atmosphere pass owns the two-colour distance banding. Feeding it
       here keeps the bands locked to the same palette as the sky they are
       standing in front of — if these drift apart the far silhouettes stop
       reading as the same air. */
    if (this.atmos) {
      this.atmos.uniforms.uFogNear.value.copy(pal.fogNear);
      this.atmos.uniforms.uFogFar.value.copy(pal.fogFar);
    }

    // Scene fog is only the near blend; it tracks the warm band.
    this.scene.fog.color.copy(pal.fogNear);
    this.scene.fog.density = lerp(0.00030, 0.00013, day) + dusk * 0.00010;
    this.renderer.setClearColor(pal.fogFar);
    this.skyMat.uniforms.uTime.value += dt;
    this.skyMat.uniforms.cover.value = lerp(0.58, 0.50, day);

    this.envAge += dt;
    if (this.envRT) this.refreshEnvironment(false);
  }

  get clockString() {
    const h = Math.floor(this.time);
    const m = Math.floor((this.time - h) * 60);
    const ampm = h < 12 ? 'AM' : 'PM';
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
  }
}
