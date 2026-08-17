import * as THREE from 'three';
import { clamp, lerp } from '../core/util.js';

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
        top: { value: new THREE.Color(0x2f6ea8) },
        bottom: { value: new THREE.Color(0xbcd0e0) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunCol: { value: new THREE.Color(0xffd9a0) },
        haze: { value: 0.5 },
        uTime: { value: 0 },
        cover: { value: 0.46 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir;
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
          for (int k = 0; k < 5; k++) { s += vnoise(p) * a; p *= 2.03; a *= 0.5; }
          return s;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.75));
          float d = max(dot(dir, normalize(sunDir)), 0.0);

          /* Clouds: project the view ray onto a flat deck and run fbm across
             it. Cheap, and it gives the horizon and the fog colour something
             to actually come from instead of a bare two-stop gradient. */
          if (dir.y > 0.015) {
            vec2 p = dir.xz / dir.y * 0.55 + vec2(uTime * 0.0035, uTime * 0.0018);
            float n = fbm(p * 1.7);
            float m = smoothstep(cover, cover + 0.30, n);
            // fade the deck out toward the horizon so it doesn't form a wall
            m *= smoothstep(0.015, 0.30, dir.y);
            // shade: lit tops toward the sun, denser cores stay grey
            float lit = 0.55 + 0.45 * d;
            vec3 cloud = mix(vec3(0.62, 0.65, 0.70), vec3(1.02, 0.99, 0.95), lit);
            cloud *= mix(0.75, 1.0, smoothstep(0.0, 0.55, n));
            col = mix(col, cloud * (0.45 + 0.55 * max(sunCol.r, 0.25)), m * 0.85);
          }

          col += sunCol * pow(d, 220.0) * 2.5;              // disc
          col += sunCol * pow(d, 6.0) * 0.35 * haze;        // glow
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.dome = new THREE.Mesh(geo, this.skyMat);
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    /* Exponential-squared, not linear. Linear fog with far = 2300 bleached the
       whole town silhouette to near-white by 800 m; exp2 keeps near geometry
       clean and only builds density in the true distance. */
    scene.fog = new THREE.FogExp2(0x9fb2c4, 0.00042);

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

    this.sun.intensity = lerp(0.0, 2.9, day);
    // Warm and redden as it drops, rather than simply dimming.
    this.sun.color.setRGB(
      1.0,
      lerp(0.58, 0.95, day) - golden * 0.16,
      lerp(0.34, 0.88, day) - golden * 0.34
    );

    /* Skylight is roughly a fifth of direct sun in reality and it is BRIGHT.
       At 0.70 max, every surface not facing the sun crushed to mud and the
       frame read as underexposed against a correct-looking sky. */
    this.hemi.intensity = lerp(0.34, 1.55, day);
    this.hemi.color.setHex(day > 0.2 ? 0x8fb0d4 : 0x2c3a4c);
    this.hemi.groundColor.setHex(day > 0.2 ? 0x55554a : 0x1b1d1c);

    const topDay = new THREE.Color(0x2f6ea8), topNight = new THREE.Color(0x080d18);
    const botDay = new THREE.Color(0xc2d4e2), botNight = new THREE.Color(0x141c28);
    const botDusk = new THREE.Color(0xd8875a);
    this.skyMat.uniforms.top.value.copy(topNight).lerp(topDay, day);
    this.skyMat.uniforms.bottom.value.copy(botNight).lerp(botDay, day).lerp(botDusk, dusk * 0.65);
    this.skyMat.uniforms.sunDir.value.copy(dir);
    this.skyMat.uniforms.sunCol.value.setRGB(1, lerp(0.55, 0.92, day), lerp(0.3, 0.8, day));
    this.skyMat.uniforms.haze.value = 0.35 + dusk * 0.9;

    if (focus) this.dome.position.set(focus.x, 0, focus.z);
    this.dayFactor = day;

    const fogCol = new THREE.Color(0x0e141d).lerp(new THREE.Color(0xa8bccd), day).lerp(botDusk, dusk * 0.5);
    this.scene.fog.color.copy(fogCol);
    // Thicker at night and at dawn/dusk, thinnest at midday.
    this.scene.fog.density = lerp(0.00085, 0.00030, day) + dusk * 0.00022;
    this.renderer.setClearColor(fogCol);
    this.skyMat.uniforms.uTime.value += dt;
    // Broken cloud by day, more overcast-looking at night.
    this.skyMat.uniforms.cover.value = lerp(0.56, 0.44, day);

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
