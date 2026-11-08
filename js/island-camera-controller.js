export const CAMERA_SETTINGS = Object.freeze({
  pitchMin: -Math.PI / 6,
  pitchMax: Math.PI / 3,
  mouseSensitivity: 0.0026,
  stickSensitivity: 2.6,
  focusHeight: 1.35,
  followSharpness: 8,
  aimSharpness: 9,
  fovSharpness: 7,
  autoCenterDelay: 1.8,
  autoCenterSharpness: 2.6,
  vehicleRotationDamping: 2.6,
  collisionRadius: 0.28,
  collisionPadding: 0.18,
  collisionReturnSharpness: 5.5,
  cameraDistances: Object.freeze({ standard: 8.5, aim: 5, vehicle: Object.freeze([6, 12, 19]), flight: 10 }),
  verticalOffsets: Object.freeze({ standard: 2.2, aim: 1.6, vehicle: 3, flight: 3.2 }),
  shoulderOffset: 0.62,
  fov: Object.freeze({ standard: 62, aim: 48, vehicle: 66, flight: 62 }),
  firstPersonHeight: 1.6,
  minimumDistance: 0.7
});

const shortestAngle = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const dampFactor = (sharpness, deltaTime) => 1 - Math.exp(-sharpness * deltaTime);

// Add the camera to the scene and pass the player or vehicle root as target.
export class CameraController {
  constructor({ THREE, camera, scene, target, settings = CAMERA_SETTINGS }) {
    this.THREE = THREE;
    this.camera = camera;
    this.scene = scene;
    this.target = target;
    this.settings = settings;
    this.mode = 'standard';
    this.yaw = 0;
    this.pitch = 0;
    this.distanceIndex = 0;
    this.distance = settings.cameraDistances.standard;
    this.firstPerson = false;
    this.zoomScale = 1;
    this.idleLookTime = 0;
    this.obstructionDistance = this.distance;
    this.fovInitialized = false;
    this.raycaster = new THREE.Raycaster();
    this.collisionObjects = [];
    scene.traverse((object) => {
      if (object.isMesh && object.userData.cameraCollision === true) this.collisionObjects.push(object);
    });
    this.origin = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.direction = new THREE.Vector3();
    this.cameraExclusions = new Set();
    this.setTarget(target);
  }

  setTarget(target) {
    this.target = target;
    this.cameraExclusions.clear();
    target?.traverse?.((object) => this.cameraExclusions.add(object));
  }

  setMode(mode) {
    if (['standard', 'aiming', 'vehicle', 'flight'].includes(mode)) this.mode = mode;
  }

  cycleVehicleDistance() {
    this.distanceIndex = (this.distanceIndex + 1) % this.settings.cameraDistances.vehicle.length;
    return this.distanceIndex;
  }

  zoom(direction) {
    if (!direction) return;
    const factor = direction > 0 ? 1.12 : 1 / 1.12;
    this.zoomScale = Math.max(0.65, Math.min(1.7, this.zoomScale * factor));
  }

  getVehicleDistanceLabel() {
    return ['cerca', 'lejos', 'cinemática'][this.distanceIndex];
  }

  setFirstPerson(enabled) {
    this.firstPerson = Boolean(enabled);
  }

  alignYaw(yaw) {
    this.yaw = yaw;
  }

  getYaw() {
    return this.yaw;
  }

  getPitch() {
    return this.pitch;
  }

  isLooking(input) {
    return Math.abs(input.lookX) > 0 || Math.abs(input.lookY) > 0
      || Math.abs(input.stickX) > 0.05 || Math.abs(input.stickY) > 0.05;
  }

  update(deltaTime, input, { target = this.target, velocity = { x: 0, z: 0 } } = {}) {
    const dt = Math.max(0, Math.min(deltaTime, 0.05));
    if (target !== this.target) this.setTarget(target);
    this.zoom(input.zoom);
    const manualLook = this.isLooking(input);
    if (manualLook) {
      this.yaw -= input.lookX * this.settings.mouseSensitivity;
      this.pitch += input.lookY * this.settings.mouseSensitivity;
      this.yaw += input.stickX * this.settings.stickSensitivity * dt;
      this.pitch += input.stickY * this.settings.stickSensitivity * dt;
      this.idleLookTime = 0;
    } else {
      this.idleLookTime += dt;
    }
    this.pitch = Math.max(this.settings.pitchMin, Math.min(this.settings.pitchMax, this.pitch));

    const speed = Math.hypot(velocity.x, velocity.z);
    if (this.mode === 'vehicle' && speed > 1 && !manualLook) {
      const velocityYaw = Math.atan2(velocity.x, -velocity.z);
      this.yaw += shortestAngle(this.yaw, velocityYaw) * dampFactor(this.settings.vehicleRotationDamping, dt);
    } else if (this.mode === 'standard' && speed > 0.8
      && this.idleLookTime >= this.settings.autoCenterDelay) {
      const movementYaw = Math.atan2(velocity.x, -velocity.z);
      this.yaw += shortestAngle(this.yaw, movementYaw) * dampFactor(this.settings.autoCenterSharpness, dt);
    }

    const distance = (this.mode === 'aiming'
      ? this.settings.cameraDistances.aim
      : this.mode === 'vehicle'
        ? this.settings.cameraDistances.vehicle[this.distanceIndex]
        : this.settings.cameraDistances[this.mode] || this.settings.cameraDistances.standard) * this.zoomScale;
    const focus = target.position;
    const cosPitch = Math.cos(this.pitch);
    this.forward.set(Math.sin(this.yaw) * cosPitch, -Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch).normalize();
    this.right.set(Math.cos(this.yaw), 0, Math.sin(this.yaw)).normalize();
    if (this.firstPerson && this.mode !== 'flight' && this.mode !== 'aiming') {
      this.origin.set(focus.x, focus.y + this.settings.firstPersonHeight, focus.z);
      this.lookTarget.copy(this.origin).addScaledVector(this.forward, 30);
      this.camera.position.lerp(this.origin, dampFactor(this.settings.followSharpness, dt));
      const firstPersonFov = this.settings.fov.standard;
      this.camera.fov += (firstPersonFov - this.camera.fov) * dampFactor(this.settings.fovSharpness, dt);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.lookTarget);
      this.obstructionDistance = this.settings.cameraDistances.standard;
      return { yaw: this.yaw, pitch: this.pitch, speed, mode: this.mode, manualLook };
    }
    const focusHeight = this.mode === 'flight' ? 0 : this.settings.focusHeight;
    this.origin.set(focus.x, focus.y + focusHeight, focus.z);
    const verticalOffset = this.settings.verticalOffsets[this.mode] || this.settings.verticalOffsets.standard;
    const shoulderOffset = this.mode === 'aiming' ? this.settings.shoulderOffset : 0;
    this.desiredPosition.copy(this.origin)
      .addScaledVector(this.forward, -distance)
      .addScaledVector(this.up, verticalOffset)
      .addScaledVector(this.right, shoulderOffset);
    if (this.mode === 'aiming') this.desiredPosition.y = this.origin.y + verticalOffset + Math.sin(this.pitch) * distance;

    const safeDistance = this.resolveCollision(this.origin, this.desiredPosition, this.right, this.up);
    if (safeDistance < this.obstructionDistance) this.obstructionDistance = safeDistance;
    else this.obstructionDistance += (safeDistance - this.obstructionDistance) * dampFactor(this.settings.collisionReturnSharpness, dt);

    if (this.mode === 'aiming') {
      this.direction.copy(this.forward);
      this.lookTarget.copy(this.origin).addScaledVector(this.direction, 35).addScaledVector(this.right, shoulderOffset * 0.45);
    } else {
      this.lookTarget.copy(this.origin);
    }
    const fullDistance = this.origin.distanceTo(this.desiredPosition);
    const actualDistance = Math.min(this.obstructionDistance, fullDistance);
    const collisionPosition = this.origin.clone().addScaledVector(
      this.direction.copy(this.desiredPosition).sub(this.origin).normalize(),
      actualDistance
    );
    if (actualDistance < fullDistance - 0.001) {
      this.camera.position.copy(collisionPosition);
    } else {
      this.camera.position.lerp(this.desiredPosition, dampFactor(
        this.mode === 'aiming' ? this.settings.aimSharpness : this.settings.followSharpness,
        dt
      ));
    }

    const targetFov = this.settings.fov[this.mode] || this.settings.fov.standard;
    this.camera.fov += (targetFov - this.camera.fov) * dampFactor(this.settings.fovSharpness, dt);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.lookTarget);
    return { yaw: this.yaw, pitch: this.pitch, speed, mode: this.mode, manualLook };
  }

  resolveCollision(origin, desired, right, up) {
    const path = this.direction.copy(desired).sub(origin);
    const fullDistance = path.length();
    if (fullDistance < this.settings.minimumDistance) return this.settings.minimumDistance;
    path.normalize();
    this.raycaster.far = fullDistance;
    const radius = this.settings.collisionRadius;
    const offsets = [
      [0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]
    ];
    let safeDistance = fullDistance;
    for (const [horizontal, vertical] of offsets) {
      const offset = this.right.clone().copy(right).multiplyScalar(horizontal)
        .add(this.up.clone().multiplyScalar(vertical));
      this.raycaster.set(origin.clone().add(offset), path);
      const hits = this.raycaster.intersectObjects(this.collisionObjects, false);
      const hit = hits.find(({ object }) => object.visible
        && !this.cameraExclusions.has(object)
        && object.userData.cameraCollision !== false
        && !object.name.startsWith('IslandPOI-'));
      if (hit) safeDistance = Math.min(safeDistance, Math.max(this.settings.minimumDistance, hit.distance - this.settings.collisionPadding));
    }
    return safeDistance;
  }
}
