import * as THREE from 'three';
import { clamp, lerp, angleDelta, MPS_TO_MPH } from '../core/util.js';
import { Vehicle, CAR_SPECS, buildCarMesh, animateWheels } from './vehicle.js';
import { setLights } from '../world/carbuilder.js';

/* Player: drives a car, or gets out and walks. Camera is a chase rig with
   mouse orbit; on foot it drops to an over-the-shoulder rig. */

export class Player {
  constructor(world, scene, spawn, audio = null) {
    this.world = world;
    this.scene = scene;
    this.audio = audio;

    this.vehicle = new Vehicle(world, CAR_SPECS.wagon, spawn.x, spawn.z, spawn.heading);
    this.carMesh = buildCarMesh(CAR_SPECS.wagon, 0x39434c, { name: 'player_car' });
    scene.add(this.carMesh);

    // On-foot state
    this.onFoot = false;
    this.footX = spawn.x;
    this.footZ = spawn.z;
    this.footY = world.heightAt(spawn.x, spawn.z);
    this.footHeading = spawn.heading;
    this.footSpeed = 0;
    this.bob = 0;

    this.avatar = buildAvatar();
    this.avatar.visible = false;
    scene.add(this.avatar);

    // Camera rig
    this.camYaw = spawn.heading;
    this.camPitch = 0.20;
    this.camDist = 8.2;
    this.shake = 0;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camDir = new THREE.Vector3(0, 0, 1);
    this.enterCooldown = 0;
    this.headlights = false;
    this.headlightsManual = false;
    this.headlightsOverride = false;

    /* Two real spotlights on the player's car only. Everything else in town
       fakes its lighting with additive decals, but you have to be able to
       actually see the road you are driving down after dark. */
    this.beams = [];
    for (const side of [-1, 1]) {
      const s = new THREE.SpotLight(0xfff0d0, 0, 52, 0.50, 0.62, 1.3);
      s.castShadow = false;
      s.target.position.set(0, 0, 1);
      this.carMesh.add(s, s.target);
      s.position.set(side * 0.55, 0.62, 2.1);
      s.target.position.set(side * 0.35, -0.45, 24);
      this.beams.push(s);
    }
  }

  get x() { return this.onFoot ? this.footX : this.vehicle.x; }
  get z() { return this.onFoot ? this.footZ : this.vehicle.z; }
  get y() { return this.onFoot ? this.footY : this.vehicle.y; }
  get heading() { return this.onFoot ? this.footHeading : this.vehicle.heading; }
  get mph() { return this.onFoot ? this.footSpeed * MPS_TO_MPH : this.vehicle.mph; }

  update(dt, input, camera, uiBlocking) {
    this.enterCooldown = Math.max(0, this.enterCooldown - dt);

    // ---- mouse look
    if (input.locked) {
      this.camYaw -= input.mouseDX * 0.0026;
      this.camPitch = clamp(this.camPitch + input.mouseDY * 0.0021, -0.35, 1.05);
    }
    if (input.wheel) this.camDist = clamp(this.camDist + input.wheel * 0.006, 3.6, 17);

    // ---- enter / exit vehicle
    if (!uiBlocking && input.hit('KeyF') && this.enterCooldown === 0 && !this.knockedDown) {
      if (this.onFoot) {
        const d = Math.hypot(this.footX - this.vehicle.x, this.footZ - this.vehicle.z);
        if (d < 4.5) {
          this.onFoot = false;
          this.avatar.visible = false;
          this.enterCooldown = 0.4;
          if (this.audio) this.audio.doorClose();
        }
      } else if (this.vehicle.mph < 3) {
        this.onFoot = true;
        this.avatar.visible = true;
        // Step out to the driver's side.
        const [fx, fz] = this.vehicle.forward;
        this.footX = this.vehicle.x + (-fz) * -1.9;
        this.footZ = this.vehicle.z + (fx) * -1.9;
        this.footY = this.world.heightAt(this.footX, this.footZ);
        this.footHeading = this.vehicle.heading;
        this.enterCooldown = 0.4;
        if (this.audio) this.audio.doorOpen();
      }
    }

    if (this.onFoot) this._updateFoot(dt, input, uiBlocking);
    else this._updateDrive(dt, input, uiBlocking);

    this._updateCamera(dt, camera);
  }

  _updateDrive(dt, input, uiBlocking) {
    let throttle = 0, steer = 0, brake = 0, handbrake = false;
    // Hold the car still while a panel is up — otherwise you roll away down
    // the Palisades grade in the middle of writing someone a ticket.
    if (uiBlocking) brake = 1;
    if (!uiBlocking) {
      const fwd = input.down('KeyW') || input.down('ArrowUp');
      const back = input.down('KeyS') || input.down('ArrowDown');
      steer = input.axis('KeyA', 'KeyD') || input.axis('ArrowLeft', 'ArrowRight');
      handbrake = input.down('Space');

      if (fwd) throttle = 1;
      if (back) {
        // S brakes when rolling forward, reverses once stopped.
        if (this.vehicle.speed > 0.6) brake = 1;
        else throttle = -1;
      }
    }

    // Surfaced for the audio bed, which needs pedal state rather than speed.
    this.throttleNow = Math.max(0, throttle);
    this.brakingNow = brake > 0 || handbrake;
    this.vehicle.update(dt, { throttle, steer, brake, handbrake });
    this.vehicle.applyTo(this.carMesh);
    animateWheels(this.carMesh, this.vehicle);

    setLights(this.carMesh, {
      head: this.headlights,
      brake: brake > 0 || handbrake,
    });

    // Keep the avatar riding along so exiting is seamless.
    this.footX = this.vehicle.x;
    this.footZ = this.vehicle.z;
  }

  _updateFoot(dt, input, uiBlocking) {
    // Knocked down by a car: slide, lie there, get back up.
    if (this.knockedDown) {
      this.downTime += dt;
      this.footX += this.downVX * dt;
      this.footZ += this.downVZ * dt;
      this.downVX *= Math.exp(-dt * 3.2);
      this.downVZ *= Math.exp(-dt * 3.2);
      const [cx, cz] = this.world.clampToWorld(this.footX, this.footZ, 8);
      this.footX = cx; this.footZ = cz;
      this.footY = this.world.heightAt(this.footX, this.footZ);
      this.footSpeed = 0;

      this.avatar.position.set(this.footX, this.footY, this.footZ);
      this.avatar.rotation.set(0, this.footHeading, 0);
      // Fold flat, then push back up over the last second.
      const rise = clamp((this.downTime - 3.0) / 1.0, 0, 1);
      this.avatar.rotateX((Math.PI / 2) * (1 - rise));
      if (this.downTime > 4.0) {
        this.knockedDown = false;
        this.avatar.rotation.set(0, this.footHeading, 0);
      }
      return;
    }

    let mx = 0, mz = 0;
    if (!uiBlocking) {
      const f = input.axis('KeyS', 'KeyW') || input.axis('ArrowDown', 'ArrowUp');
      const s = input.axis('KeyA', 'KeyD') || input.axis('ArrowLeft', 'ArrowRight');
      // Move relative to where the camera is looking.
      const cy = this.camYaw;
      const fx = Math.sin(cy), fz = Math.cos(cy);
      const rx = -fz, rz = fx;
      mx = fx * f + rx * s;
      mz = fz * f + rz * s;
    }
    const len = Math.hypot(mx, mz);
    const running = input.down('ShiftLeft');
    const maxSpeed = running ? 5.4 : 2.5;

    if (len > 0.01) {
      mx /= len; mz /= len;
      this.footSpeed = lerp(this.footSpeed, maxSpeed, clamp(dt * 8, 0, 1));
      this.footHeading = Math.atan2(mx, mz);
    } else {
      this.footSpeed = lerp(this.footSpeed, 0, clamp(dt * 11, 0, 1));
    }

    if (this.footSpeed > 0.01) {
      let nx = this.footX + mx * this.footSpeed * dt;
      let nz = this.footZ + mz * this.footSpeed * dt;
      const push = this.world.collideBuildings(nx, nz, 0.42);
      if (push && push.depth > 0) {
        nx += push.x * push.depth;
        nz += push.z * push.depth;
      }
      const [cx, cz] = this.world.clampToWorld(nx, nz, 10);
      this.footX = cx; this.footZ = cz;
    }

    this.footY = this.world.heightAt(this.footX, this.footZ);
    const prevBob = this.bob;
    this.bob += this.footSpeed * dt * 2.6;
    /* One step per half cycle of the walk bob, so the rate follows the actual
       pace rather than a fixed timer. Audio.footstep is internally limited. */
    if (this.audio && this.footSpeed > 0.6
        && Math.floor(prevBob / Math.PI) !== Math.floor(this.bob / Math.PI)) {
      this.audio.footstep(this.footSpeed > 4);
    }

    this.avatar.position.set(this.footX, this.footY, this.footZ);
    this.avatar.rotation.y = this.footHeading;
    this.avatar.children[0].position.y = 0.92 + Math.sin(this.bob * 3) * 0.045 * clamp(this.footSpeed, 0, 2);
    // Arm swing
    const sw = Math.sin(this.bob * 3) * clamp(this.footSpeed * 0.16, 0, 0.55);
    if (this.avatar.userData.armL) {
      this.avatar.userData.armL.rotation.x = sw;
      this.avatar.userData.armR.rotation.x = -sw;
    }
  }

  _updateCamera(dt, camera) {
    const targetX = this.x, targetZ = this.z;
    const baseY = this.y;

    if (!this.onFoot) {
      // Chase cam: let it drift toward the direction of travel at speed.
      const v = this.vehicle;
      if (v.mph > 8) {
        const travel = v.heading;
        const d = angleDelta(this.camYaw, travel);
        this.camYaw += d * clamp(dt * 0.9 * clamp(v.mph / 45, 0, 1), 0, 0.09);
      }
    }

    const dist = this.onFoot ? 4.0 : this.camDist + clamp(this.vehicle.mph / 26, 0, 2.4);
    const pitch = this.camPitch;
    const height = this.onFoot ? 1.55 : 1.85;

    const cx = targetX - Math.sin(this.camYaw) * Math.cos(pitch) * dist;
    const cz = targetZ - Math.cos(this.camYaw) * Math.cos(pitch) * dist;
    const cy = baseY + height + Math.sin(pitch) * dist;

    /* Don't let the camera sink into a hill — or sit inside a wall. The boom
       is probed outward from the subject and pulled in on the first solid
       thing it meets, which is what stops the chase cam ending up inside the
       house you are driving past. */
    let bx = cx, bz = cz;
    const sx = targetX, sz = targetZ;
    const STEPS = 5;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const px = sx + (cx - sx) * t;
      const pz = sz + (cz - sz) * t;
      if (this.world.collideBuildings(px, pz, 0.55)) {
        // Stop just short of the obstruction.
        const back = Math.max(0, t - 1 / STEPS);
        bx = sx + (cx - sx) * back;
        bz = sz + (cz - sz) * back;
        break;
      }
    }
    const ground = this.world.heightAt(bx, bz) + 1.2;
    const desired = new THREE.Vector3(bx, Math.max(cy, ground), bz);

    if (this.camPos.lengthSq() === 0) this.camPos.copy(desired);
    const follow = this.onFoot ? 14 : 9;
    this.camPos.lerp(desired, clamp(dt * follow, 0, 1));

    const lookY = baseY + (this.onFoot ? 1.5 : 1.15);
    const shoulder = this.onFoot ? 0.55 : 0;
    const rx = Math.cos(this.camYaw), rz = -Math.sin(this.camYaw);
    this.camLook.lerp(
      new THREE.Vector3(targetX + rx * shoulder, lookY, targetZ + rz * shoulder),
      clamp(dt * 16, 0, 1)
    );

    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);

    // Impact shake: a short decaying jitter. Set by main on hard contacts.
    if (this.shake > 0.003) {
      camera.position.x += (Math.random() - 0.5) * this.shake;
      camera.position.y += (Math.random() - 0.5) * this.shake * 0.7;
      camera.position.z += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 7.5);
    }

    // Widen the lens with speed — the cheapest sense of velocity there is.
    const targetFov = this.onFoot ? 62 : 62 + clamp(this.vehicle.mph / 60, 0, 1) * 9;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * clamp(dt * 3.5, 0, 1);
      camera.updateProjectionMatrix();
    }

    // Flat forward direction, used for the view cone in Enforcement.
    this.camDir.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).normalize();
  }
}

function buildAvatar() {
  const g = new THREE.Group();
  const jacket = new THREE.MeshStandardMaterial({ color: 0x2f3a45, roughness: 0.8 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x232629, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xa9866c, roughness: 0.85 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.56, 3, 8), jacket);
  torso.position.y = 0.92;
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 8, 7), skin);
  head.position.y = 1.44;
  head.castShadow = true;
  g.add(head);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.09, 8), pants);
  cap.position.y = 1.56;
  g.add(cap);

  const armGeo = new THREE.CapsuleGeometry(0.075, 0.42, 3, 6);
  const armL = new THREE.Group();
  const aL = new THREE.Mesh(armGeo, jacket);
  aL.position.y = -0.24;
  armL.add(aL);
  armL.position.set(-0.32, 1.14, 0);
  const armR = new THREE.Group();
  const aR = new THREE.Mesh(armGeo, jacket);
  aR.position.y = -0.24;
  armR.add(aR);
  armR.position.set(0.32, 1.14, 0);
  g.add(armL, armR);

  const legGeo = new THREE.CapsuleGeometry(0.095, 0.46, 3, 6);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, pants);
    leg.position.set(s * 0.13, 0.36, 0);
    g.add(leg);
  }

  g.userData = { armL, armR };
  return g;
}
