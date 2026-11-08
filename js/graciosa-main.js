import * as THREE from 'three/webgpu';
import { Fn, attribute, color, cos, dot, float, floor, fract, mix, modelViewMatrix, normalize, positionLocal, positionWorld, sin, smoothstep, texture, time, uv, vec2, vec3, vec4 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createTerrainSurface, decodeElevationGrid, sampleElevation } from './graciosa-terrain.js';
import { createCoastGeometry } from './graciosa-coast.js';
import { createIslandNavigator, EXPLORATION_MODES, headingFromVelocity, headingLabel, ISLAND_POIS, updateIslandFlight, updateIslandJump, updateIslandMovement, updateSeagullPose } from './graciosa-exploration.js';
import { createIslandTerrainDetails } from './island-terrain-details.js';
import { CameraController } from './island-camera-controller.js';
import { IslandCameraInput } from './island-camera-input.js';
import { createIslandMinimap } from './island-minimap.js';
import { loadSatelliteTexture } from './graciosa-satellite.js';
import { ELEVATION } from './graciosa-elevation.js';
import { GEO } from './graciosa-geodata.js';

const SPAWN_HEIGHT = 2;
const HARBOR_ENTRY = Object.freeze({ x: 14.8, z: 185.1 });
const SPAWN_ANCHOR = Object.freeze({ x: 15, z: 183 });
const nearestCoastPoint = GEO.coast.flat().reduce((nearest, point) =>
  Math.hypot(point[0], point[1]) < Math.hypot(nearest[0], nearest[1]) ? point : nearest, [Infinity, Infinity]);
const SPAWN_YAW = Math.atan2(nearestCoastPoint[0], -nearestCoastPoint[1]);
const container = document.getElementById('canvas-container');
const status = document.getElementById('status');
const loadingScreen = document.getElementById('loading-screen');
const loadingProgress = document.getElementById('loading-progress');
const loadingProgressFill = document.getElementById('loading-progress-fill');
const loadingMessage = document.getElementById('loading-message');
const loadingError = document.getElementById('loading-error');
const loadingRetry = document.getElementById('loading-retry');
const minimapCanvas = document.getElementById('island-minimap');
const compassLabel = document.querySelector('#compass strong');
const compassNeedle = document.querySelector('#compass i');
const waypointArrow = document.getElementById('waypoint-arrow');
const cameraModeButton = document.getElementById('camera-mode');
const aimReticle = document.getElementById('aim-reticle');
const fpsCounter = document.getElementById('fps-counter');
const imageryAttribution = document.getElementById('imagery-attribution');
const setStatus = (message) => { if (status) status.textContent = message; };
const setLoadingProgress = (value, message) => {
  const progress = Math.max(0, Math.min(100, value));
  if (loadingProgress) loadingProgress.setAttribute('aria-valuenow', String(progress));
  if (loadingProgressFill) loadingProgressFill.style.width = `${progress}%`;
  if (loadingMessage) loadingMessage.textContent = message;
};
const showLoadingError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (loadingScreen) loadingScreen.classList.add('is-error');
  if (loadingMessage) loadingMessage.textContent = 'No se pudo iniciar el juego';
  if (loadingError) {
    loadingError.textContent = message;
    loadingError.hidden = false;
  }
  if (loadingRetry) loadingRetry.hidden = false;
};
loadingRetry?.addEventListener('click', () => location.reload());

const hash2D = Fn(([point]) => fract(sin(dot(point, vec2(127.1, 311.7))).mul(43758.5453)));
const valueNoise = Fn(([point]) => {
  const p = vec2(point).toVar();
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  const smooth = f.mul(f).mul(float(3).sub(f.mul(2))).toVar();
  return mix(
    mix(hash2D(cell), hash2D(cell.add(vec2(1, 0))), smooth.x),
    mix(hash2D(cell.add(vec2(0, 1))), hash2D(cell.add(vec2(1, 1))), smooth.x),
    smooth.y
  );
});

function createTexturedMaterial(base, highlight, roughness, scale) {
  const material = new THREE.MeshStandardMaterial({ color: base, roughness });
  const broad = valueNoise(positionWorld.xz.mul(scale));
  const grain = valueNoise(positionWorld.xz.mul(scale * 9));
  material.colorNode = mix(color(base), color(highlight), broad.mul(0.54).add(grain.mul(0.22)).add(0.12));
  material.roughnessNode = float(roughness);
  return material;
}

function oceanWaveNodes(localPosition) {
  const swell = localPosition.x.mul(0.02).add(localPosition.z.mul(0.007)).add(time.mul(0.45));
  const crossSwell = localPosition.z.mul(0.015).sub(localPosition.x.mul(0.01)).sub(time.mul(0.34));
  const shortSwell = localPosition.x.add(localPosition.z).mul(0.028).add(time.mul(0.62));
  return {
    height: sin(swell).mul(0.3)
      .add(sin(crossSwell).mul(0.15))
      .add(sin(shortSwell).mul(0.06)),
    slopeX: cos(swell).mul(0.006)
      .sub(cos(crossSwell).mul(0.00225))
      .add(cos(shortSwell).mul(0.00168)),
    slopeZ: cos(swell).mul(0.0021)
      .add(cos(crossSwell).mul(0.003))
      .add(cos(shortSwell).mul(0.00168))
  };
}

function buildSky(scene) {
  const geometry = new THREE.SphereGeometry(19000, 48, 24);
  const material = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const skyHeight = normalize(positionLocal).y;
  const gradient = mix(color(0xe4d9c2), color(0x6da7c3), smoothstep(float(-0.08), float(0.78), skyHeight));
  const cloudNoise = valueNoise(positionLocal.xz.mul(0.00058));
  const cloudMask = smoothstep(float(0.62), float(0.78), cloudNoise)
    .mul(smoothstep(float(0.02), float(0.3), skyHeight))
    .mul(smoothstep(float(0.02), float(0.32), float(0.92).sub(skyHeight)));
  material.colorNode = mix(gradient, color(0xf7eedc), cloudMask.mul(0.26));
  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'CanarianAtmosphereSky';
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
  return sky;
}

function buildLand(scene, terrain) {
  const material = new THREE.MeshStandardMaterial({ color: 0xb9a77f, roughness: 1 });
  const broad = valueNoise(positionWorld.xz.mul(0.009));
  const sand = valueNoise(positionWorld.xz.mul(0.035));
  const grain = valueNoise(positionWorld.xz.mul(0.32));
  const fineGrain = valueNoise(positionWorld.xz.mul(1.7));
  const sandTone = mix(color(0x927d55), color(0xd2bd8c), sand.mul(0.48).add(grain.mul(0.24)).add(fineGrain.mul(0.1)).add(0.08));
  const upland = smoothstep(float(12), float(175), positionWorld.y).mul(0.72);
  const terrainTone = mix(sandTone, mix(color(0x827965), color(0x5c584c), broad), upland);
  const volcanicPatches = smoothstep(float(0.66), float(0.84), broad).mul(upland.mul(0.78));
  material.colorNode = mix(terrainTone, color(0x45473f), volcanicPatches);
  material.roughnessNode = float(1);
  material.side = THREE.DoubleSide;
  const surface = createTerrainSurface(terrain, GEO.land);
  if (!surface.indices.length) throw new Error('The elevation grid does not overlap the island coastline.');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  const uv = new Float32Array(surface.positions.length / 3 * 2);
  const boundsWidth = GEO.bounds.maxX - GEO.bounds.minX;
  const boundsDepth = GEO.bounds.maxZ - GEO.bounds.minZ;
  for (let vertex = 0; vertex < surface.positions.length / 3; vertex++) {
    const x = surface.positions[vertex * 3];
    const z = surface.positions[vertex * 3 + 2];
    uv[vertex * 2] = Math.max(0, Math.min(1, (x - GEO.bounds.minX) / boundsWidth));
    uv[vertex * 2 + 1] = Math.max(0, Math.min(1, 1 - (z - GEO.bounds.minZ) / boundsDepth));
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'LaGraciosaElevationMesh';
  mesh.userData.proceduralColorNode = material.colorNode;
  mesh.userData.cameraCollision = false;
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  scene.add(mesh);
  return mesh;
}

function buildOcean(scene) {
  const b = GEO.bounds;
  const width = Math.max(12000, b.maxX - b.minX + 5000);
  const depth = Math.max(12000, b.maxZ - b.minZ + 5000);
  const geometry = new THREE.PlaneGeometry(width, depth, Math.ceil(width / 60), Math.ceil(depth / 60));
  geometry.rotateX(-Math.PI / 2);
  const waveSize = 128;
  const waveData = new Uint8Array(waveSize * waveSize * 4);
  for (let y = 0; y < waveSize; y++) {
    for (let x = 0; x < waveSize; x++) {
      const u = x / waveSize * Math.PI * 2;
      const v = y / waveSize * Math.PI * 2;
      const height = 0.5
        + Math.sin(u * 2 + v * 1.1) * 0.19
        + Math.sin(u * 1.25 - v * 2.1) * 0.15
        + Math.sin(u * 3 + v * 2) * 0.09;
      const value = Math.round(height * 255);
      const index = (y * waveSize + x) * 4;
      waveData[index] = value;
      waveData[index + 1] = value;
      waveData[index + 2] = value;
      waveData[index + 3] = 255;
    }
  }
  const waveTexture = new THREE.DataTexture(waveData, waveSize, waveSize, THREE.RGBAFormat, THREE.UnsignedByteType);
  waveTexture.wrapS = THREE.RepeatWrapping;
  waveTexture.wrapT = THREE.RepeatWrapping;
  waveTexture.repeat.set(42, 42);
  waveTexture.generateMipmaps = true;
  waveTexture.minFilter = THREE.LinearMipmapLinearFilter;
  waveTexture.magFilter = THREE.LinearFilter;
  waveTexture.needsUpdate = true;
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x126b7d,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
    roughness: 0.2,
    metalness: 0.06,
    clearcoat: 0.95,
    clearcoatRoughness: 0.1,
    specularIntensity: 1,
    specularColor: 0xc3edf1,
    bumpMap: waveTexture,
    bumpScale: 4
  });
  const waterVariation = valueNoise(positionWorld.xz.mul(0.0016));
  const rippleA = positionWorld.x.mul(0.015).add(positionWorld.z.mul(0.009)).add(time.mul(0.55));
  const rippleB = positionWorld.x.mul(-0.006).add(positionWorld.z.mul(0.02)).sub(time.mul(0.38));
  const waveCrests = smoothstep(float(0.82), float(1.35), sin(rippleA).add(sin(rippleB).mul(0.55)));
  material.colorNode = mix(color(0x07576c), color(0x43b9b0), waterVariation.mul(0.65).add(0.18))
    .add(color(0x75c9c4).mul(waveCrests.mul(0.32)));
  material.roughnessNode = mix(float(0.12), float(0.28), waterVariation);
  const waves = oceanWaveNodes(positionLocal);
  material.positionNode = positionLocal.add(vec3(0, waves.height, 0));
  material.normalNode = normalize(modelViewMatrix.mul(vec4(waves.slopeX.negate(), float(1), waves.slopeZ.negate(), float(0))).xyz);
  material.side = THREE.DoubleSide;
  const ocean = new THREE.Mesh(geometry, material);
  ocean.name = 'OpenAtlanticOcean';
  ocean.position.set(0, 0, 0);
  ocean.receiveShadow = true;
  scene.add(ocean);
  return ocean;
}

function buildCoast(scene, terrain) {
  const coast = createCoastGeometry(GEO.land, (x, z) => sampleElevation(terrain, x, z));
  if (!coast.shoreIndices.length) return;

  const shoreGeometry = new THREE.BufferGeometry();
  shoreGeometry.setAttribute('position', new THREE.BufferAttribute(coast.shorePositions, 3));
  shoreGeometry.setAttribute('color', new THREE.BufferAttribute(coast.shoreColors, 3));
  shoreGeometry.setAttribute('coastWaveMix', new THREE.BufferAttribute(coast.shoreWaveMix, 1));
  shoreGeometry.setIndex(new THREE.BufferAttribute(coast.shoreIndices, 1));
  shoreGeometry.computeVertexNormals();
  const shoreMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    side: THREE.DoubleSide
  });
  const shelfLocalPosition = positionLocal;
  const shelfWaveMix = attribute('coastWaveMix', 'float');
  const shelfWaves = oceanWaveNodes(shelfLocalPosition);
  shoreMaterial.positionNode = shelfLocalPosition.add(vec3(0, shelfWaves.height.mul(shelfWaveMix), 0));
  shoreMaterial.normalNode = normalize(modelViewMatrix.mul(vec4(
    shelfWaves.slopeX.mul(shelfWaveMix).negate(),
    float(1),
    shelfWaves.slopeZ.mul(shelfWaveMix).negate(),
    float(0)
  )).xyz);
  shoreMaterial.roughnessNode = mix(float(0.92), float(0.18), shelfWaveMix);
  const shore = new THREE.Mesh(shoreGeometry, shoreMaterial);
  shore.name = 'ContinuousShallowWaterShelf';
  shore.renderOrder = 1;
  scene.add(shore);

  const foamGeometry = new THREE.BufferGeometry();
  foamGeometry.setAttribute('position', new THREE.BufferAttribute(coast.foamPositions, 3));
  foamGeometry.setIndex(new THREE.BufferAttribute(coast.foamIndices, 1));
  foamGeometry.computeVertexNormals();
  foamGeometry.computeBoundingBox();
  foamGeometry.boundingBox.expandByVector(new THREE.Vector3(0, 2.5, 0));
  foamGeometry.computeBoundingSphere();

  const foamMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false
  });
  const foamFlow = positionWorld.x.mul(0.045).add(positionWorld.z.mul(0.032)).add(time.mul(1.7));
  const foamFleck = positionWorld.x.mul(0.17).sub(positionWorld.z.mul(0.11)).sub(time.mul(2.4));
  const foamPattern = sin(foamFlow).mul(0.65).add(sin(foamFleck).mul(0.35)).mul(0.5).add(0.5);
  const foamStrength = smoothstep(float(0.28), float(0.78), foamPattern);
  foamMaterial.colorNode = mix(color(0x8bc9c2), color(0xfff8e6), foamStrength);
  foamMaterial.opacityNode = float(0.24).add(foamStrength.mul(0.62));
  const foamLocalPosition = positionLocal;
  const foamWaves = oceanWaveNodes(foamLocalPosition);
  foamMaterial.positionNode = foamLocalPosition.add(vec3(0, foamWaves.height, 0));
  const foam = new THREE.Mesh(foamGeometry, foamMaterial);
  foam.name = 'AnimatedCoastalFoam';
  foam.renderOrder = 2;
  scene.add(foam);
}

function buildingHeight(building) {
  if (building.height !== null) return building.height;
  let seed = Math.imul(building.id | 0, 0x45d9f3) >>> 0;
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 0x45d9f3) >>> 0;
  return 3 + (seed % 3001) / 1000;
}

function containsPoint(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function buildBuildings(scene, terrain, playerSpawn) {
  const colors = [0xf3eddf, 0xe9dfca, 0xf7f3e8, 0xe3d7c1, 0xeee7d7, 0xdfd5c3];
  const materials = colors.map((tint) => {
    return createTexturedMaterial(tint, 0xfaf5e9, 0.96, 0.12);
  });
  const batches = colors.map(() => []);
  const windows = [];
  const shutters = [];
  const doors = [];
  const roofEdges = [];
  const roofTanks = [];
  for (const building of GEO.buildings) {
    const containsSpawn = building.polygons.some(({ outer, holes }) =>
      containsPoint(outer, playerSpawn.x, playerSpawn.z)
      && !holes.some((hole) => containsPoint(hole, playerSpawn.x, playerSpawn.z)));
    if (containsSpawn) {
      console.warn(`[graciosa] OSM building ${building.id} overlaps the requested Caleta de Sebo spawn; omitting its mesh.`);
      continue;
    }
    const height = buildingHeight(building);
    const materialIndex = Math.abs(building.id) % materials.length;
    for (const polygon of building.polygons) {
      const outline = polygon.outer;
      const center = outline.reduce((sum, [x, z]) => [sum[0] + x / outline.length, sum[1] + z / outline.length], [0, 0]);
      const baseElevation = sampleElevation(terrain, center[0], center[1]);
      let area = 0;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        area += outline[j][0] * outline[i][1] - outline[i][0] * outline[j][1];
      }
      const roofCenter = outline.reduce((sum, [x, z]) => [sum[0] + x / outline.length, sum[1] + z / outline.length], [0, 0]);
      if (height <= 7 && Math.abs(area) > 64 && Math.abs(building.id) % 4 === 0
        && containsPoint(outline, roofCenter[0], roofCenter[1])) {
        roofTanks.push({ x: roofCenter[0], y: baseElevation + height + 0.58, z: roofCenter[1] });
      }
      let doorEdge = -1;
      let longestEdge = 0;
      for (let i = 0; i < outline.length; i++) {
        const [x0, z0] = outline[i];
        const [x1, z1] = outline[(i + 1) % outline.length];
        const length = Math.hypot(x1 - x0, z1 - z0);
        if (length > longestEdge) { longestEdge = length; doorEdge = i; }
      }

      const shape = new THREE.Shape();
      outline.forEach(([x, z], index) => index ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
      shape.closePath();
      for (const ring of polygon.holes) {
        const hole = new THREE.Path();
        ring.forEach(([x, z], index) => index ? hole.lineTo(x, -z) : hole.moveTo(x, -z));
        hole.closePath();
        shape.holes.push(hole);
      }
      const buildingGeometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
      buildingGeometry.rotateX(-Math.PI / 2);
      buildingGeometry.translate(0, baseElevation + 0.14, 0);
      batches[materialIndex].push(buildingGeometry);

      for (let i = 0; i < outline.length; i++) {
        const [x0, z0] = outline[i];
        const [x1, z1] = outline[(i + 1) % outline.length];
        const dx = x1 - x0;
        const dz = z1 - z0;
        const length = Math.hypot(dx, dz);
        if (length < 0.8) continue;
        const yaw = Math.atan2(-dz, dx);
        const outside = area > 0 ? -1 : 1;
        const centerX = (x0 + x1) * 0.5 + (-dz / length) * outside * 0.045;
        const centerZ = (z0 + z1) * 0.5 + (dx / length) * outside * 0.045;
        roofEdges.push({ x: (x0 + x1) * 0.5, y: baseElevation + height + 0.19, z: (z0 + z1) * 0.5, yaw, sx: length, sy: 0.22, sz: 0.16 });
        if (length >= 2.2 && i !== doorEdge) {
          const count = Math.floor(length / 2.7);
          for (let window = 0; window < count; window++) {
            const t = (window + 0.5) / count;
            const x = x0 + dx * t + (-dz / length) * outside * 0.045;
            const z = z0 + dz * t + (dx / length) * outside * 0.045;
            for (const y of height > 4.8 ? [1.45, 3.7] : [1.45]) {
              if (y + 0.4 >= height) continue;
              windows.push({ x, y: baseElevation + y + 0.14, z, yaw, sx: 0.58, sy: 0.78, sz: 0.075 });
              shutters.push(
                { x: x - Math.cos(yaw) * 0.37, y: baseElevation + y + 0.14, z: z + Math.sin(yaw) * 0.37, yaw, sx: 0.15, sy: 0.82, sz: 0.09 },
                { x: x + Math.cos(yaw) * 0.37, y: baseElevation + y + 0.14, z: z - Math.sin(yaw) * 0.37, yaw, sx: 0.15, sy: 0.82, sz: 0.09 }
              );
            }
          }
        }
        if (i === doorEdge && height > 2.1) {
          doors.push({ x: centerX, y: baseElevation + Math.min(1.05, height * 0.42) + 0.14, z: centerZ, yaw, sx: 0.78, sy: Math.min(2.1, height - 0.2), sz: 0.09 });
        }
      }
    }
  }
  batches.forEach((geometries, index) => {
    if (!geometries.length) return;
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    const buildings = new THREE.Mesh(merged, materials[index]);
    buildings.name = 'LaGraciosaWhitewashedBuildings';
    buildings.userData.cameraCollision = true;
    buildings.castShadow = true;
    buildings.receiveShadow = true;
    scene.add(buildings);
  });

  const addDetails = (name, instances, tint, roughness = 0.9) => {
    if (!instances.length) return;
    const palette = Array.isArray(tint) ? tint : [tint];
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: palette.length > 1 ? 0xffffff : palette[0], roughness }),
      instances.length
    );
    mesh.name = name;
    mesh.castShadow = name === 'CanarianRoofParapets';
    const transform = new THREE.Object3D();
    instances.forEach(({ x, y, z, yaw, sx, sy, sz }, index) => {
      transform.position.set(x, y, z);
      transform.rotation.set(0, yaw, 0);
      transform.scale.set(sx, sy, sz);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      if (palette.length > 1) {
        const variation = Math.abs(Math.floor(x * 13 + z * 7 + index * 3)) % palette.length;
        mesh.setColorAt(index, new THREE.Color(palette[variation]));
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
  };
  addDetails('MutedSeaGlassWindows', windows, [0x527a80, 0x66848a, 0x456b74], 0.72);
  addDetails('PastelCanarianShutters', shutters, [0x9cad94, 0x7d9d9a, 0xb9a98a, 0x78909a]);
  addDetails('DarkWoodAndTerracottaDoors', doors, [0x80543d, 0x9a5945, 0x6a7770]);
  addDetails('CanarianRoofParapets', roofEdges, [0xe4dac3, 0xd8cfbd, 0xeee6d4]);
  if (roofTanks.length) {
    const tanks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.38, 0.42, 0.86, 10),
      new THREE.MeshStandardMaterial({ color: 0xd7d5c9, roughness: 0.84 }),
      roofTanks.length
    );
    tanks.name = 'CanarianRooftopWaterTanks';
    const transform = new THREE.Object3D();
    roofTanks.forEach(({ x, y, z }, index) => {
      transform.position.set(x, y, z);
      transform.rotation.set(0, (index % 4) * Math.PI / 2, 0);
      transform.updateMatrix();
      tanks.setMatrixAt(index, transform.matrix);
      tanks.setColorAt(index, new THREE.Color(index % 3 === 0 ? 0xb9c6c2 : index % 3 === 1 ? 0xd7d5c9 : 0xc6c8bd));
    });
    tanks.instanceMatrix.needsUpdate = true;
    if (tanks.instanceColor) tanks.instanceColor.needsUpdate = true;
    tanks.castShadow = true;
    tanks.receiveShadow = true;
    scene.add(tanks);
  }
}

function buildLandmarks(scene, terrain, pois) {
  for (const poi of pois) {
    if (poi.id === 'caleta') continue;
    const height = sampleElevation(terrain, poi.x, poi.z);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 8),
      new THREE.MeshStandardMaterial({ color: poi.category === 'viewpoint' ? 0xf3a58f : 0xffe6a8, emissive: 0x553322 })
    );
    marker.name = `IslandPOI-${poi.id}`;
    marker.position.set(poi.x, height + 0.65, poi.z);
    scene.add(marker);
  }
}

function buildNativeScrub(scene, terrain, navigator) {
  const details = createIslandTerrainDetails(
    GEO.bounds,
    (x, z) => sampleElevation(terrain, x, z),
    navigator,
    [SPAWN_ANCHOR.x, SPAWN_ANCHOR.z]
  );
  const transform = new THREE.Object3D();
  const addInstances = (name, kind, geometry, material, verticalScale, castShadow) => {
    const placements = details[kind];
    if (!placements.length) return;
    const instances = new THREE.InstancedMesh(geometry, material, placements.length);
    instances.name = name;
    instances.castShadow = castShadow;
    instances.receiveShadow = true;
    placements.forEach((detail, index) => {
      transform.position.set(detail.x, detail.elevation + detail.scaleY * verticalScale, detail.z);
      transform.rotation.set(Math.atan(detail.slopeZ), detail.yaw, -Math.atan(detail.slopeX));
      transform.scale.set(detail.scaleX, detail.scaleY, detail.scaleZ);
      transform.updateMatrix();
      instances.setMatrixAt(index, transform.matrix);
      instances.setColorAt(index, new THREE.Color(detail.tint));
    });
    instances.instanceMatrix.needsUpdate = true;
    if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
    scene.add(instances);
  };
  addInstances(
    'SparseXerophyticIslandScrub',
    'scrub',
    new THREE.ConeGeometry(0.9, 1.25, 5, 1).rotateY(Math.PI / 5),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
    0.55,
    false
  );
  addInstances(
    'LowPolyVolcanicRocks',
    'rocks',
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98 }),
    0.4,
    true
  );
  addInstances(
    'SoftCoastalSandDunes',
    'dunes',
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
    0.52,
    true
  );
}

function buildHarborBoats(scene, navigator) {
  const places = [
    { x: -22, z: 195, yaw: -0.3 },
    { x: -10, z: 225, yaw: 0.25 },
    { x: 61, z: 222, yaw: -0.55 }
  ];
  const boats = [];
  places.forEach((place, index) => {
    if (navigator.isOnLand(place.x, place.z)) return;
    const boat = new THREE.Group();
    boat.name = `CaletaHarborBoat-${index + 1}`;
    boat.position.set(place.x, 0.55, place.z);
    boat.rotation.y = place.yaw;
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: [0xeee7d4, 0xc36d53, 0xe4e1d4][index],
      roughness: 0.72
    });
    const cabinMaterial = new THREE.MeshStandardMaterial({ color: 0xf4eee0, roughness: 0.9 });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: 0x31535a,
      roughness: 0.26,
      metalness: 0.2
    });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x414844, roughness: 0.68, metalness: 0.24 });
    const fenderMaterial = new THREE.MeshStandardMaterial({ color: 0x273b3c, roughness: 0.85 });
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(7.5, 0.7, 2.2),
      hullMaterial
    );
    hull.position.y = 0.35;
    hull.castShadow = true;
    boat.add(hull);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.15, 1.65),
      cabinMaterial
    );
    cabin.position.set(-0.4, 1.15, 0);
    cabin.castShadow = true;
    boat.add(cabin);
    const bow = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 2.4, 4),
      new THREE.MeshStandardMaterial({ color: 0xf5eddb, roughness: 0.8 })
    );
    bow.rotation.z = Math.PI / 2;
    bow.position.set(4.5, 0.35, 0);
    boat.add(bow);
    const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(2.65, 0.13, 1.9), cabinMaterial);
    cabinRoof.position.set(-0.4, 1.79, 0);
    cabinRoof.castShadow = true;
    boat.add(cabinRoof);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 1.3), glassMaterial);
    windshield.position.set(0.82, 1.38, 0);
    boat.add(windshield);
    for (const side of [-1, 1]) {
      const sideWindow = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.32, 0.06), glassMaterial);
      sideWindow.position.set(-0.35, 1.38, side * 0.84);
      boat.add(sideWindow);
      for (const x of [-2.3, 0, 2.1]) {
        const fender = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), fenderMaterial);
        fender.position.set(x, 0.22, side * 1.12);
        boat.add(fender);
      }
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 2.35, 8), darkMetal);
    mast.position.set(-2.65, 1.65, 0);
    mast.castShadow = true;
    boat.add(mast);
    const flag = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.32, 0.035),
      new THREE.MeshStandardMaterial({ color: index === 1 ? 0xe8c06e : 0xb85f48, roughness: 0.85 })
    );
    flag.position.set(-2.35, 2.55, 0);
    boat.add(flag);
    const lifeRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.25, 0.07, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0xc85b42, roughness: 0.78 })
    );
    lifeRing.position.set(-1.25, 0.95, 0.86);
    boat.add(lifeRing);
    scene.add(boat);
    boats.push({
      boat,
      phase: index * 2.1,
      x: place.x,
      z: place.z,
      yaw: place.yaw
    });
  });
  return boats;
}

function buildRoads(scene, terrain) {
  const buckets = new Map();
  for (const road of GEO.roads) {
    const group = road.type === 'track' ? 'track' : road.type === 'path' || road.type === 'footway' ? 'path' : 'street';
    if (!buckets.has(group)) buckets.set(group, []);
    const segments = buckets.get(group);
    const points = road.points;
    for (let i = 1; i < points.length; i++) {
      const [x0, z0] = points[i - 1];
      const [x1, z1] = points[i];
      const length = Math.hypot(x1 - x0, z1 - z0);
      if (length < 0.01) continue;
      const half = road.width * 0.5;
      const nx = ((z1 - z0) / length) * half;
      const nz = (-(x1 - x0) / length) * half;
      const subdivisions = Math.max(1, Math.ceil(length / 5));
      for (let part = 0; part < subdivisions; part++) {
        const start = part / subdivisions;
        const end = (part + 1) / subdivisions;
        const startX = x0 + (x1 - x0) * start;
        const startZ = z0 + (z1 - z0) * start;
        const endX = x0 + (x1 - x0) * end;
        const endZ = z0 + (z1 - z0) * end;
        const startY = sampleElevation(terrain, startX, startZ) + 0.28;
        const endY = sampleElevation(terrain, endX, endZ) + 0.28;
        segments.push(
          new THREE.Vector3(startX - nx, startY, startZ - nz), new THREE.Vector3(startX + nx, startY, startZ + nz),
          new THREE.Vector3(endX - nx, endY, endZ - nz), new THREE.Vector3(endX + nx, endY, endZ + nz)
        );
      }
    }
  }
  const colors = { track: 0xcda45e, path: 0xd8b773, street: 0xd2ae68 };
  for (const [type, vertices] of buckets) {
    const positions = [];
    for (let i = 0; i < vertices.length; i += 4) {
      const a = vertices[i], b = vertices[i + 1], c = vertices[i + 2], d = vertices[i + 3];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: colors[type], roughness: 1 });
    material.side = THREE.DoubleSide;
    const roads = new THREE.Mesh(geometry, material);
    roads.name = `Island-${type}-and-sand-roads`;
    roads.receiveShadow = true;
    scene.add(roads);
  }
}

function buildHarborStructures(scene, terrain) {
  const appendQuad = (vertices, a, b, c, d) => {
    vertices.push(...a, ...b, ...c, ...b, ...d, ...c);
  };
  const surfaces = new Map([
    ['pier', []],
    ['breakwater', []],
    ['groyne', []]
  ]);
  for (const structure of GEO.harborStructures) {
    const vertices = surfaces.get(structure.type);
    if (!vertices) continue;
    const points = structure.points;
    const halfWidth = structure.width * 0.5;
    const shoreHeight = sampleElevation(terrain, points[0][0], points[0][1]);
    const top = structure.type === 'pier'
      ? Math.max(0.55, Math.min(3.5, shoreHeight + 0.35))
      : Math.max(0.45, Math.min(2.4, shoreHeight + 0.2));
    for (let i = 1; i < points.length; i++) {
      const [x0, z0] = points[i - 1];
      const [x1, z1] = points[i];
      const length = Math.hypot(x1 - x0, z1 - z0);
      if (length < 0.01) continue;
      const nx = ((z1 - z0) / length) * halfWidth;
      const nz = (-(x1 - x0) / length) * halfWidth;
      const left0 = [x0 - nx, top, z0 - nz];
      const right0 = [x0 + nx, top, z0 + nz];
      const left1 = [x1 - nx, top, z1 - nz];
      const right1 = [x1 + nx, top, z1 + nz];
      const bottom = 0.08;
      const bottomLeft0 = [left0[0], bottom, left0[2]];
      const bottomRight0 = [right0[0], bottom, right0[2]];
      const bottomLeft1 = [left1[0], bottom, left1[2]];
      const bottomRight1 = [right1[0], bottom, right1[2]];
      appendQuad(vertices, left0, right0, left1, right1);
      appendQuad(vertices, left0, left1, bottomLeft0, bottomLeft1);
      appendQuad(vertices, right1, right0, bottomRight1, bottomRight0);
      appendQuad(vertices, left0, bottomLeft0, right0, bottomRight0);
      appendQuad(vertices, right1, bottomRight1, left1, bottomLeft1);
    }
  }
  const palette = {
    pier: [0x92968f, 0xc0c4bb],
    breakwater: [0x6d7069, 0x88877b],
    groyne: [0x756f61, 0x928872]
  };
  for (const [type, positions] of surfaces) {
    if (!positions.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const [base, highlight] = palette[type];
    const material = createTexturedMaterial(base, highlight, 0.96, 0.18);
    material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `MappedOSM-${type}`;
    mesh.userData.cameraCollision = true;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }
}

function buildHarborDetails(scene, terrain, navigator) {
  const supportMatrices = [];
  const bollardMatrices = [];
  const marker = new THREE.Object3D();
  const addMatrix = (target, x, y, z, scaleY = 1) => {
    marker.position.set(x, y, z);
    marker.scale.set(1, scaleY, 1);
    marker.updateMatrix();
    target.push(marker.matrix.clone());
  };

  for (const structure of GEO.harborStructures) {
    if (structure.type !== 'pier' || structure.points.length < 2) continue;
    const isLocalHarbor = structure.points.some(([x, z]) =>
      Math.hypot(x - HARBOR_ENTRY.x, z - HARBOR_ENTRY.z) < 700);
    if (!isLocalHarbor) continue;

    const shoreHeight = sampleElevation(terrain, ...structure.points[0]);
    const top = Math.max(0.55, Math.min(3.5, shoreHeight + 0.35));
    let travelled = 0;
    let nextSupport = 14;
    let nextBollard = 20;
    for (let i = 1; i < structure.points.length; i++) {
      const [x0, z0] = structure.points[i - 1];
      const [x1, z1] = structure.points[i];
      const length = Math.hypot(x1 - x0, z1 - z0);
      if (length < 0.01) continue;
      const nx = (z1 - z0) / length;
      const nz = -(x1 - x0) / length;
      const halfWidth = structure.width * 0.5;
      const segmentEnd = travelled + length;

      while (nextSupport < segmentEnd) {
        const along = (nextSupport - travelled) / length;
        const x = x0 + (x1 - x0) * along;
        const z = z0 + (z1 - z0) * along;
        if (!navigator.isOnLand(x, z)) {
          const pileHeight = Math.max(0.35, top - 0.1);
          for (const side of [-1, 1]) {
            const offset = side * halfWidth * 0.65;
            addMatrix(supportMatrices, x + nx * offset, pileHeight * 0.5 + 0.05, z + nz * offset, pileHeight);
          }
        }
        nextSupport += 12;
      }

      while (nextBollard < segmentEnd) {
        const along = (nextBollard - travelled) / length;
        const x = x0 + (x1 - x0) * along;
        const z = z0 + (z1 - z0) * along;
        const side = Math.round(nextBollard / 20) % 2 === 0 ? 1 : -1;
        const offset = side * (halfWidth - 0.25);
        addMatrix(bollardMatrices, x + nx * offset, top + 0.21, z + nz * offset);
        nextBollard += 20;
      }

      travelled = segmentEnd;
    }
  }

  if (supportMatrices.length) {
    const supports = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.18, 0.24, 1, 8),
      new THREE.MeshStandardMaterial({ color: 0x686b63, roughness: 0.94 }),
      supportMatrices.length
    );
    supports.name = 'CaletaMappedPierSupportPiles';
    supportMatrices.forEach((matrix, index) => supports.setMatrixAt(index, matrix));
    supports.instanceMatrix.needsUpdate = true;
    supports.castShadow = true;
    supports.receiveShadow = true;
    scene.add(supports);
  }

  if (bollardMatrices.length) {
    const bollards = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.13, 0.2, 0.42, 8),
      new THREE.MeshStandardMaterial({ color: 0x4b514c, roughness: 0.72, metalness: 0.18 }),
      bollardMatrices.length
    );
    bollards.name = 'CaletaMappedPierMooringBollards';
    bollardMatrices.forEach((matrix, index) => bollards.setMatrixAt(index, matrix));
    bollards.instanceMatrix.needsUpdate = true;
    bollards.castShadow = true;
    bollards.receiveShadow = true;
    scene.add(bollards);
  }

  const lampLocations = [
    [HARBOR_ENTRY.x - 2, HARBOR_ENTRY.z - 14],
    [HARBOR_ENTRY.x + 15, HARBOR_ENTRY.z - 14]
  ];
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x51534c, roughness: 0.76, metalness: 0.28 });
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0xffe6af,
    emissive: 0xe6a653,
    emissiveIntensity: 1.1,
    roughness: 0.42
  });
  for (const [index, [x, z]] of lampLocations.entries()) {
    if (!navigator.isOnLand(x, z)) continue;
    const ground = sampleElevation(terrain, x, z);
    const lamp = new THREE.Group();
    lamp.name = `CaletaHarborQuayLight-${index + 1}`;
    lamp.position.set(x, ground, z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.22, 8), poleMaterial);
    base.position.y = 0.11;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.09, 3.4, 8), poleMaterial);
    pole.position.y = 1.82;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.07), poleMaterial);
    arm.position.set(0.25, 3.45, 0);
    const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.27), lampMaterial);
    lantern.position.set(0.52, 3.31, 0);
    for (const part of [base, pole, arm, lantern]) {
      part.castShadow = true;
      part.receiveShadow = true;
      lamp.add(part);
    }
    scene.add(lamp);
  }
}

function addTubeBetween(group, start, end, radius, material) {
  const from = new THREE.Vector3(...start);
  const to = new THREE.Vector3(...end);
  const direction = to.clone().sub(from);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 8), material);
  tube.position.copy(from).add(to).multiplyScalar(0.5);
  tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  group.add(tube);
}

function buildBeachCharacter() {
  const character = new THREE.Group();
  character.name = 'BeachCharacter';
  character.position.y = -1.8;

  const materials = {
    skin: new THREE.MeshStandardMaterial({ color: 0xc98e69, roughness: 0.88 }),
    shirt: new THREE.MeshStandardMaterial({ color: 0xf2eee0, roughness: 0.95 }),
    shorts: new THREE.MeshStandardMaterial({ color: 0x318b89, roughness: 0.9 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xf1c77f, roughness: 0.86 }),
    straw: new THREE.MeshStandardMaterial({ color: 0xd7b66f, roughness: 1 }),
    hair: new THREE.MeshStandardMaterial({ color: 0x49382d, roughness: 0.96 }),
    glasses: new THREE.MeshStandardMaterial({ color: 0x273b3b, roughness: 0.42, metalness: 0.12 }),
    sandals: new THREE.MeshStandardMaterial({ color: 0x6a4835, roughness: 0.95 })
  };
  const addMesh = (parent, geometry, material, name) => {
    const mesh = new THREE.Mesh(geometry, material);
    if (name) mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const capsule = (radius, length) => new THREE.CapsuleGeometry(radius, length, 4, 8);
  const upperBody = new THREE.Group();
  upperBody.name = 'BeachCharacterUpperBody';
  upperBody.position.y = 0.86;
  character.add(upperBody);

  const torso = addMesh(upperBody, capsule(0.27, 0.4), materials.shirt, 'LinenBeachShirt');
  torso.position.set(0, 0.24, 0);
  torso.scale.set(1.05, 1, 0.82);

  const collar = addMesh(upperBody, new THREE.TorusGeometry(0.115, 0.018, 6, 12), materials.trim);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.6, -0.015);
  const shorts = addMesh(upperBody, new THREE.CylinderGeometry(0.27, 0.29, 0.36, 10), materials.shorts, 'BeachShorts');
  shorts.position.y = -0.16;
  const waistband = addMesh(upperBody, new THREE.CylinderGeometry(0.278, 0.278, 0.045, 10), materials.trim);
  waistband.position.y = 0;

  const head = new THREE.Group();
  head.name = 'BeachCharacterHead';
  head.position.y = 0.71;
  upperBody.add(head);
  const face = addMesh(head, sphere, materials.skin);
  face.position.y = 0.08;
  face.scale.set(0.15, 0.19, 0.145);
  const hair = addMesh(head, sphere, materials.hair);
  hair.position.set(0, 0.19, 0.025);
  hair.scale.set(0.153, 0.09, 0.15);
  const brim = addMesh(head, new THREE.CylinderGeometry(0.255, 0.255, 0.035, 14), materials.straw, 'StrawSunHatBrim');
  brim.position.y = 0.285;
  const crown = addMesh(head, new THREE.CylinderGeometry(0.145, 0.165, 0.16, 12), materials.straw);
  crown.position.y = 0.38;
  const hatBand = addMesh(head, new THREE.CylinderGeometry(0.166, 0.166, 0.025, 12), materials.trim);
  hatBand.position.y = 0.34;
  for (const x of [-0.067, 0.067]) {
    const lens = addMesh(head, sphere, materials.glasses, 'Sunglasses');
    lens.position.set(x, 0.115, -0.132);
    lens.scale.set(0.061, 0.042, 0.025);
  }
  const bridge = addMesh(head, new THREE.BoxGeometry(0.045, 0.018, 0.018), materials.glasses);
  bridge.position.set(0, 0.115, -0.15);

  const arms = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'LeftArm' : 'RightArm';
    pivot.position.set(side * 0.29, 0.45, 0);
    const sleeve = addMesh(pivot, capsule(0.105, 0.16), materials.shirt);
    sleeve.position.y = -0.12;
    const elbow = new THREE.Group();
    elbow.position.y = -0.25;
    pivot.add(elbow);
    const arm = addMesh(elbow, capsule(0.075, 0.2), materials.skin);
    arm.position.y = -0.13;
    const hand = addMesh(elbow, sphere, materials.skin);
    hand.position.y = -0.31;
    hand.scale.set(0.075, 0.09, 0.065);
    upperBody.add(pivot);
    return { pivot, elbow };
  });

  const legs = [-1, 1].map((side) => {
    const hip = new THREE.Group();
    hip.name = side < 0 ? 'LeftLeg' : 'RightLeg';
    hip.position.set(side * 0.14, 0.56, 0);
    const thigh = addMesh(hip, capsule(0.105, 0.24), materials.skin);
    thigh.position.y = -0.17;
    const knee = new THREE.Group();
    knee.position.y = -0.34;
    hip.add(knee);
    const calf = addMesh(knee, capsule(0.078, 0.25), materials.skin);
    calf.position.y = -0.15;
    const foot = new THREE.Group();
    foot.name = side < 0 ? 'LeftFoot' : 'RightFoot';
    foot.position.y = -0.25;
    knee.add(foot);
    const sandal = addMesh(foot, new THREE.BoxGeometry(0.17, 0.075, 0.27), materials.sandals, 'BeachSandal');
    sandal.position.set(0, -0.1, -0.055);
    const strap = addMesh(foot, new THREE.BoxGeometry(0.13, 0.025, 0.045), materials.trim);
    strap.position.set(0, -0.06, -0.105);
    character.add(hip);
    return { hip, knee, foot };
  });

  return { character, upperBody, head, arms, legs };
}

function buildBicycle() {
  const bicycle = new THREE.Group();
  bicycle.name = 'IslandBicycle';
  const rubber = new THREE.MeshStandardMaterial({ color: 0x292c2b, roughness: 0.94 });
  const frame = new THREE.MeshStandardMaterial({ color: 0xb85f3e, roughness: 0.7, metalness: 0.12 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xd0c7ad, roughness: 0.55, metalness: 0.35 });
  for (const z of [-0.75, 0.75]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.055, 8, 24), rubber);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(0, -1.18, z);
    bicycle.add(wheel);
  }
  const rear = [0, -1.18, 0.75];
  const front = [0, -1.18, -0.75];
  const crank = [0, -1.08, 0.12];
  const seat = [0, -0.55, 0.38];
  const head = [0, -0.62, -0.42];
  for (const [from, to, radius] of [
    [rear, crank, 0.035], [crank, seat, 0.035], [seat, rear, 0.035],
    [seat, head, 0.035], [head, crank, 0.035], [head, front, 0.035],
    [seat, [0, -0.48, 0.48], 0.055], [head, [0, -0.38, -0.5], 0.03],
    [[0, -0.38, -0.5], [0, -0.38, -0.78], 0.035]
  ]) addTubeBetween(bicycle, from, to, radius, frame);
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 8), metal);
  axle.rotation.z = Math.PI / 2;
  axle.position.set(0, -1.18, 0);
  bicycle.add(axle);
  return bicycle;
}

function buildSeagull() {
  const gull = new THREE.Group();
  gull.name = 'PlayerSeagull';
  const plumage = new THREE.MeshStandardMaterial({ color: 0xf3f0e8, roughness: 0.86 });
  const feather = new THREE.MeshStandardMaterial({ color: 0xd7d8d3, roughness: 0.9 });
  const wingPlumage = plumage.clone();
  wingPlumage.side = THREE.DoubleSide;
  const covertMaterial = feather.clone();
  covertMaterial.side = THREE.DoubleSide;
  const darkWing = new THREE.MeshStandardMaterial({ color: 0x4b5152, roughness: 0.92, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12), plumage);
  body.name = 'SeagullBody';
  body.scale.set(0.78, 0.78, 1.55);
  gull.add(body);
  const breast = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 10), plumage);
  breast.position.set(0, -0.035, -0.23);
  breast.scale.set(0.82, 0.82, 1.05);
  gull.add(breast);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.15, 0.34, 10), plumage);
  neck.position.set(0, 0.08, -0.38);
  neck.rotation.x = -0.38;
  gull.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.205, 16, 12), plumage);
  head.name = 'SeagullHead';
  head.position.set(0, 0.16, -0.54);
  gull.add(head);
  const eyeRing = new THREE.MeshStandardMaterial({ color: 0xb7b5aa, roughness: 0.8 });
  const eye = new THREE.MeshStandardMaterial({ color: 0x171b1b, roughness: 0.36 });
  for (const side of [-1, 1]) {
    const orbital = new THREE.Mesh(new THREE.SphereGeometry(0.064, 10, 8), eyeRing);
    orbital.position.set(side * 0.175, 0.19, -0.59);
    gull.add(orbital);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8), eye);
    pupil.position.set(side * 0.205, 0.195, -0.615);
    gull.add(pupil);
  }
  const beakMaterial = new THREE.MeshStandardMaterial({ color: 0xe2b944, roughness: 0.68 });
  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(0.095, 0.31, 7),
    beakMaterial
  );
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 0.115, -0.78);
  gull.add(beak);
  const beakBand = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.045, 7), darkWing);
  beakBand.rotation.x = -Math.PI / 2;
  beakBand.position.set(0, 0.115, -0.695);
  gull.add(beakBand);

  const tailShape = new THREE.Shape();
  tailShape.moveTo(-0.2, 0);
  tailShape.lineTo(0.2, 0);
  tailShape.lineTo(0.37, 0.64);
  tailShape.lineTo(0.16, 0.92);
  tailShape.lineTo(0, 0.7);
  tailShape.lineTo(-0.16, 0.92);
  tailShape.lineTo(-0.37, 0.64);
  tailShape.closePath();
  const tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape), feather);
  tail.name = 'SeagullTailFeathers';
  tail.position.set(0, 0.035, 0.48);
  tail.rotation.x = Math.PI / 2;
  gull.add(tail);

  const legMaterial = new THREE.MeshStandardMaterial({ color: 0xd87559, roughness: 0.72 });
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.28, 7), legMaterial);
    leg.position.set(side * 0.13, -0.31, 0.12);
    leg.rotation.x = -0.22;
    gull.add(leg);
    for (const toeSide of [-1, 0, 1]) {
      const toe = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.01, 0.16, 6), legMaterial);
      toe.position.set(side * 0.13 + toeSide * 0.035, -0.45, 0.015 - Math.abs(toeSide) * 0.015);
      toe.rotation.x = Math.PI / 2;
      toe.rotation.z = toeSide * 0.38;
      gull.add(toe);
    }
  }

  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.16);
  wingShape.lineTo(0.42, 0.36);
  wingShape.lineTo(1.05, 0.48);
  wingShape.lineTo(1.82, 0.42);
  wingShape.lineTo(2.55, 0.23);
  wingShape.lineTo(3.12, 0.025);
  wingShape.lineTo(2.87, -0.08);
  wingShape.lineTo(2.65, -0.04);
  wingShape.lineTo(2.49, -0.34);
  wingShape.lineTo(2.31, -0.12);
  wingShape.lineTo(2.15, -0.39);
  wingShape.lineTo(1.97, -0.11);
  wingShape.lineTo(1.76, -0.35);
  wingShape.lineTo(1.59, -0.09);
  wingShape.lineTo(1.33, -0.29);
  wingShape.lineTo(1.08, -0.06);
  wingShape.lineTo(0.69, -0.19);
  wingShape.lineTo(0.34, -0.04);
  wingShape.lineTo(0, 0.02);
  wingShape.closePath();
  const wingGeometry = new THREE.ShapeGeometry(wingShape);
  wingGeometry.rotateX(-Math.PI / 2);

  const tipShape = new THREE.Shape();
  tipShape.moveTo(2.2, 0.32);
  tipShape.lineTo(3.12, 0.025);
  tipShape.lineTo(2.87, -0.08);
  tipShape.lineTo(2.65, -0.04);
  tipShape.lineTo(2.49, -0.34);
  tipShape.lineTo(2.31, -0.12);
  tipShape.closePath();
  const tipGeometry = new THREE.ShapeGeometry(tipShape);
  tipGeometry.rotateX(-Math.PI / 2);
  const covertShape = new THREE.Shape();
  covertShape.moveTo(0.3, -0.045);
  covertShape.lineTo(0.72, 0.075);
  covertShape.lineTo(1.48, 0.11);
  covertShape.lineTo(2.15, 0.025);
  covertShape.lineTo(1.62, -0.11);
  covertShape.lineTo(0.9, -0.12);
  covertShape.closePath();
  const covertGeometry = new THREE.ShapeGeometry(covertShape);
  covertGeometry.rotateX(-Math.PI / 2);

  const wings = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'LeftSeagullWing' : 'RightSeagullWing';
    pivot.position.set(side * 0.13, 0.045, -0.02);
    pivot.scale.x = side;
    const wing = new THREE.Mesh(wingGeometry, wingPlumage);
    wing.name = 'TaperedSeagullWing';
    pivot.add(wing);
    const coverts = new THREE.Mesh(covertGeometry, covertMaterial);
    coverts.name = 'SeagullWingCoverts';
    pivot.add(coverts);
    const tip = new THREE.Mesh(tipGeometry, darkWing);
    tip.name = 'DarkSeagullPrimaryFeathers';
    pivot.add(tip);
    gull.add(pivot);
    return { pivot, side };
  });
  return { gull, wings };
}

async function start() {
  if (!container) throw new Error('The island canvas container is missing.');
  setLoadingProgress(8, 'Cargando el relieve y los datos de la isla…');
  const terrain = decodeElevationGrid(ELEVATION);
  const { gull, wings: seagullWings } = buildSeagull();
  const navigator = createIslandNavigator(
    GEO,
    (x, z) => sampleElevation(terrain, x, z),
    { spawn: [SPAWN_ANCHOR.x, SPAWN_ANCHOR.z] }
  );
  const harborLanding = navigator.nearestWalkable(SPAWN_ANCHOR.x, SPAWN_ANCHOR.z, 30);
  if (!harborLanding) throw new Error('No se encontró un punto transitable en la entrada del puerto de Caleta de Sebo.');
  const playerSpawn = {
    x: harborLanding[0],
    y: sampleElevation(terrain, harborLanding[0], harborLanding[1]) + SPAWN_HEIGHT,
    z: harborLanding[1]
  };
  setLoadingProgress(22, 'Buscando un punto seguro en Caleta de Sebo…');
  gull.position.set(playerSpawn.x, playerSpawn.y + 15, playerSpawn.z);
  const pois = ISLAND_POIS.filter((poi) => navigator.nearestWalkable(poi.x, poi.z, 150));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd8d4c7);
  scene.fog = new THREE.Fog(0xd8d4c7, 4200, 15500);
  buildSky(scene);
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 20000);
  camera.position.set(playerSpawn.x, playerSpawn.y, playerSpawn.z);
  camera.rotation.set(0, SPAWN_YAW, 0);
  setLoadingProgress(34, 'Preparando el motor gráfico WebGPU…');
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  await renderer.init();

  setLoadingProgress(58, 'Construyendo costa, puerto y terreno…');
  scene.add(new THREE.HemisphereLight(0xdce9f1, 0x927856, 1.5));
  const sun = new THREE.DirectionalLight(0xffdcae, 2.55);
  sun.position.set(-1200, 2500, -800);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -5000;
  sun.shadow.camera.right = 4000;
  sun.shadow.camera.top = 7000;
  sun.shadow.camera.bottom = -5000;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 18000;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  scene.add(sun);
  const ocean = buildOcean(scene);
  const landMesh = buildLand(scene, terrain);
  loadSatelliteTexture(THREE, GEO.bounds, GEO.frame).then((satelliteTexture) => {
    satelliteTexture.anisotropy = 8;
    landMesh.material.colorNode = mix(
      landMesh.userData.proceduralColorNode,
      texture(satelliteTexture, uv()).rgb,
      float(0.68)
    );
    landMesh.material.needsUpdate = true;
    if (imageryAttribution) imageryAttribution.hidden = false;
  }).catch((error) => {
    console.warn('Satellite imagery could not be loaded; keeping procedural terrain.', error);
    if (imageryAttribution) {
      imageryAttribution.textContent = 'Imagen satelital no disponible · terreno procedural activo';
      imageryAttribution.hidden = false;
    }
  });
  buildRoads(scene, terrain);
  buildHarborStructures(scene, terrain);
  buildHarborDetails(scene, terrain, navigator);
  buildCoast(scene, terrain);
  buildBuildings(scene, terrain, playerSpawn);
  buildNativeScrub(scene, terrain, navigator);
  buildLandmarks(scene, terrain, pois);
  const boats = buildHarborBoats(scene, navigator);

  setLoadingProgress(82, 'Preparando controles y cámara…');
  const avatar = new THREE.Group();
  avatar.name = 'SpawnedAvatar-Caleta-de-Sebo';
  avatar.position.set(playerSpawn.x, playerSpawn.y, playerSpawn.z);
  const {
    character,
    upperBody: characterUpperBody,
    head: characterHead,
    arms: characterArms,
    legs: characterLegs
  } = buildBeachCharacter();
  avatar.add(character);
  scene.add(avatar);

  const bicycle = buildBicycle();
  bicycle.visible = false;
  avatar.add(bicycle);
  gull.visible = false;
  scene.add(gull);
  const cameraController = new CameraController({ THREE, camera, scene, target: avatar });
  cameraController.alignYaw(SPAWN_YAW);
  const cameraInput = new IslandCameraInput(renderer.domElement);
  let yaw = SPAWN_YAW;
  let explorationMode = 'person';
  let groundMode = 'person';
  let flightMode = false;
  const movementVelocity = { x: 0, z: 0 };
  const jumpState = { height: 0, velocity: 0, grounded: true };
  const flightVelocity = { x: 0, y: 0, z: 0 };
  const seagullPose = { yaw: SPAWN_YAW, bank: 0, pitch: 0 };
  const flightPosition = gull.position.clone();
  const groundPosition = avatar.position.clone();
  const touchJumpButton = document.querySelector('[data-jump]');
  const modeButtons = [...document.querySelectorAll('[data-exploration-mode]')];
  const setExplorationMode = (nextMode) => {
    if (!EXPLORATION_MODES[nextMode] || nextMode === explorationMode) return;
    if (nextMode === 'seagull') {
      groundMode = explorationMode;
      groundPosition.set(
        avatar.position.x,
        sampleElevation(terrain, avatar.position.x, avatar.position.z) + SPAWN_HEIGHT,
        avatar.position.z
      );
      avatar.position.copy(groundPosition);
      flightPosition.copy(avatar.position);
      flightPosition.y += 15;
    } else {
      if (explorationMode === 'seagull') {
        avatar.position.copy(groundPosition);
        avatar.position.y = sampleElevation(terrain, avatar.position.x, avatar.position.z) + SPAWN_HEIGHT;
      }
      groundMode = nextMode;
    }
    explorationMode = nextMode;
    flightMode = explorationMode === 'seagull';
    if (flightMode) gull.position.copy(flightPosition);
    cameraInput.actions.clear();
    movementVelocity.x = movementVelocity.z = 0;
    jumpState.height = jumpState.velocity = 0;
    jumpState.grounded = true;
    avatar.position.y = sampleElevation(terrain, avatar.position.x, avatar.position.z) + SPAWN_HEIGHT;
    flightVelocity.x = flightVelocity.y = flightVelocity.z = 0;
    bicycle.visible = explorationMode === 'bicycle';
    gull.visible = flightMode;
    cameraController.setTarget(flightMode ? gull : avatar);
    cameraController.setFirstPerson(false);
    cameraController.setMode(flightMode ? 'flight' : explorationMode === 'bicycle' ? 'vehicle' : 'standard');
    cameraController.distanceIndex = 0;
    cameraInput.setAimToggled(false);
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.explorationMode === explorationMode));
    }
    if (cameraModeButton) {
      cameraModeButton.disabled = flightMode;
      cameraModeButton.setAttribute('aria-pressed', 'true');
      cameraModeButton.textContent = flightMode
        ? 'Vista: gaviota'
        : 'Vista: tercera persona';
    }
    if (aimReticle) aimReticle.hidden = true;
    if (touchJumpButton) {
      const touchAction = explorationMode === 'seagull' ? 'Subir' : 'Salto';
      touchJumpButton.textContent = touchAction;
      touchJumpButton.setAttribute('aria-label', explorationMode === 'seagull' ? 'Subir como gaviota' : 'Saltar');
      touchJumpButton.hidden = explorationMode !== 'person';
    }
    setStatus(explorationMode === 'person'
      ? 'WASD o las flechas mueven al personaje. Arrastra el ratón para girar la cámara; Mayús corre y Espacio salta.'
      : 'Gaviota: WASD para volar, E/Q para subir y bajar; arrastra el ratón para mirar.');
  };

  let waypoint = null;
  const moveTo = (x, z) => {
    const destination = navigator.nearestWalkable(x, z, 90);
    if (!destination) {
      setStatus('No hay un punto transitable cerca: el destino está en el mar, dentro de un edificio o en terreno impracticable.');
      return false;
    }
    avatar.position.set(destination[0], sampleElevation(terrain, destination[0], destination[1]) + SPAWN_HEIGHT, destination[1]);
    groundPosition.copy(avatar.position);
    cameraInput.actions.clear();
    movementVelocity.x = movementVelocity.z = 0;
    jumpState.height = jumpState.velocity = 0;
    jumpState.grounded = true;
    if (flightMode) {
      flightPosition.set(avatar.position.x, avatar.position.y + 15, avatar.position.z);
      flightVelocity.x = flightVelocity.y = flightVelocity.z = 0;
    }
    setStatus(`Teletransportado a X ${Math.round(destination[0])} m, Z ${Math.round(destination[1])} m.`);
    return true;
  };
  const setWaypoint = (x, z, poi) => {
    const destination = [x, z].every(Number.isFinite) ? navigator.nearestWalkable(x, z, 150) : null;
    if (!destination) {
      setStatus('No se puede marcar un destino dentro del mar, un edificio o una pendiente impracticable.');
      return;
    }
    waypoint = { x: destination[0], z: destination[1], name: poi?.name || 'Destino seleccionado' };
    setStatus(`Rumbo marcado: ${waypoint.name}.`);
  };
  const minimap = minimapCanvas ? createIslandMinimap(minimapCanvas, GEO, moveTo, pois, setWaypoint) : null;
  minimap?.updatePlayer(avatar.position.x, avatar.position.z, SPAWN_YAW);
  cameraModeButton?.addEventListener('click', () => {
    if (flightMode) return;
    cameraController.setFirstPerson(!cameraController.firstPerson);
    cameraModeButton.setAttribute('aria-pressed', String(!cameraController.firstPerson));
    cameraModeButton.textContent = `Vista: ${cameraController.firstPerson ? 'primera' : 'tercera'} persona`;
  });
  const actionByCode = {
    KeyW: 'forward', KeyA: 'left', KeyS: 'backward', KeyD: 'right',
    KeyE: 'up', KeyQ: 'down', Space: 'jump', ShiftLeft: 'sprint'
  };
  modeButtons.forEach((button) => {
    button.addEventListener('click', () => setExplorationMode(button.dataset.explorationMode));
  });
  document.querySelectorAll('[data-move], [data-fly], [data-run], [data-jump]').forEach((button) => {
    const code = button.getAttribute('data-move')
      || (button.getAttribute('data-fly') === 'up' ? 'KeyE'
        : button.getAttribute('data-fly') === 'down' ? 'KeyQ'
          : button.hasAttribute('data-jump') ? 'Space' : 'ShiftLeft');
    const action = actionByCode[code];
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      cameraInput.setAction(action, true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, () => cameraInput.setAction(action, false));
    }
  });
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  let previousFrame = performance.now();
  let fpsWindowStart = previousFrame;
  let fpsFrameCount = 0;
  let gaitPhase = 0;
  let gaitWeight = 0;
  function animate() {
    const now = performance.now();
    fpsFrameCount++;
    const fpsElapsed = now - fpsWindowStart;
    if (fpsElapsed >= 500) {
      const fps = Math.round((fpsFrameCount * 1000) / fpsElapsed);
      if (fpsCounter) {
        fpsCounter.textContent = `${fps} FPS`;
        fpsCounter.setAttribute('aria-label', `${fps} fotogramas por segundo`);
      }
      fpsWindowStart = now;
      fpsFrameCount = 0;
    }
    const dt = Math.min((now - previousFrame) / 1000, 0.05);
    previousFrame = now;
    const input = cameraInput.sample(dt);
    for (const mode of ['person', 'seagull']) {
      if (input.edges.has(mode)) setExplorationMode(mode);
    }
    if (input.edges.has('toggleFlight')) setExplorationMode(flightMode ? groundMode : 'seagull');
    if (input.edges.has('toggleView') && !flightMode) {
      cameraController.setFirstPerson(!cameraController.firstPerson);
      if (cameraModeButton) {
        cameraModeButton.setAttribute('aria-pressed', String(!cameraController.firstPerson));
        cameraModeButton.textContent = `Vista: ${cameraController.firstPerson ? 'primera' : 'tercera'} persona`;
      }
    }
    const aiming = input.aiming && explorationMode === 'person' && !flightMode;
    if (aimReticle) aimReticle.hidden = !aiming;
    cameraController.setMode(flightMode ? 'flight' : explorationMode === 'bicycle' ? 'vehicle' : aiming ? 'aiming' : 'standard');
    const cameraState = cameraController.update(dt, input, {
      target: flightMode ? gull : avatar,
      velocity: flightMode ? flightVelocity : movementVelocity
    });
    yaw = cameraState.yaw;
    const rawForward = input.forward;
    const rawSide = input.side;
    const sprint = input.sprint;
    const modeSettings = EXPLORATION_MODES[explorationMode];
    if (flightMode) {
      updateIslandFlight(flightPosition, flightVelocity, {
        forward: rawForward,
        side: rawSide,
        vertical: input.vertical + Number(input.pressed.has('jump')),
        sprint
      }, yaw, dt, modeSettings);
      flightPosition.y = Math.max(2, flightPosition.y);
      gull.position.copy(flightPosition);
      updateSeagullPose(seagullPose, flightVelocity, yaw, dt);
      gull.rotation.set(seagullPose.pitch, seagullPose.yaw, seagullPose.bank);
      const horizontalSpeed = Math.hypot(flightVelocity.x, flightVelocity.z);
      const flapIntensity = Math.max(0.12, Math.min(1, 1 - horizontalSpeed / 30));
      const flapRate = 7 + Math.min(horizontalSpeed, 25) * 0.16;
      const flap = Math.sin(now * 0.001 * flapRate) * (0.08 + flapIntensity * 0.42);
      for (const { pivot, side: wingSide } of seagullWings) {
        pivot.rotation.z = wingSide * flap;
        pivot.rotation.x = Math.max(-0.08, Math.min(0.08, flightVelocity.y * 0.008));
      }
    } else {
      let movement;
      if (explorationMode === 'bicycle') {
        movementVelocity.x = 0;
        movementVelocity.z = 0;
        movement = { position: avatar.position, velocity: movementVelocity, speed: 0 };
      } else {
        movement = updateIslandMovement(
          avatar.position,
          movementVelocity,
          {
            forward: rawForward, side: rawSide, sprint,
            jump: input.jumpPressed
          },
          yaw,
          dt,
          navigator,
          modeSettings
        );
      }
      let turnRate = 0;
      if (movement.speed > 0.12) {
        const movementYaw = headingFromVelocity(movementVelocity.x, movementVelocity.z);
        const angleDelta = Math.atan2(
          Math.sin(movementYaw - avatar.rotation.y),
          Math.cos(movementYaw - avatar.rotation.y)
        );
        const turnAmount = 1 - Math.exp(-dt * 14);
        avatar.rotation.y += angleDelta * turnAmount;
        turnRate = dt > 0 ? angleDelta * turnAmount / dt : 0;
      } else if (aiming) {
        const angleDelta = Math.atan2(
          Math.sin(yaw - avatar.rotation.y),
          Math.cos(yaw - avatar.rotation.y)
        );
        avatar.rotation.y += angleDelta * (1 - Math.exp(-dt * 9));
      }
      const walking = explorationMode === 'person' && movement.speed > 0.18;
      const targetGaitWeight = walking
        ? Math.min(1, movement.speed / modeSettings.runSpeed)
        : 0;
      const gaitBlend = 1 - Math.exp(-dt * (targetGaitWeight > gaitWeight ? 12 : 7));
      gaitWeight += (targetGaitWeight - gaitWeight) * gaitBlend;
      if (gaitWeight > 0.001) gaitPhase += movement.speed * dt * 1.15;
      const stride = Math.sin(gaitPhase) * gaitWeight;
      const stepLift = (1 - Math.cos(gaitPhase * 2)) * 0.5 * gaitWeight;
      const runBlend = Math.max(0, Math.min(1, (movement.speed - modeSettings.walkSpeed) / (modeSettings.runSpeed - modeSettings.walkSpeed)));
      character.position.y = -1.8 + stepLift * (0.025 + runBlend * 0.035);
      character.rotation.z = (Math.sin(gaitPhase) * 0.018 - Math.max(-2.5, Math.min(2.5, turnRate)) * 0.015) * gaitWeight;
      characterUpperBody.rotation.x = -gaitWeight * (0.025 + runBlend * 0.075);
      characterUpperBody.rotation.y = Math.sin(gaitPhase) * 0.025 * gaitWeight;
      characterUpperBody.rotation.z = Math.sin(gaitPhase + Math.PI / 2) * 0.035 * gaitWeight;
      characterHead.rotation.x = -characterUpperBody.rotation.x * 0.35;
      characterHead.rotation.y = -characterUpperBody.rotation.y * 0.7;
      characterHead.rotation.z = -characterUpperBody.rotation.z * 0.5;
      characterArms.forEach(({ pivot, elbow }, index) => {
        const swing = stride * (index === 0 ? 0.52 : -0.52);
        pivot.rotation.x = swing - runBlend * gaitWeight * 0.08;
        pivot.rotation.z = (index === 0 ? -1 : 1) * gaitWeight * 0.035;
        elbow.rotation.x = 0.16 + Math.max(0, -swing) * (0.3 + runBlend * 0.22);
      });
      characterLegs.forEach(({ hip, knee, foot }, index) => {
        const swing = stride * (index === 0 ? -0.58 : 0.58);
        hip.rotation.x = swing;
        const kneeLift = Math.max(0, swing);
        knee.rotation.x = kneeLift * (0.82 + runBlend * 0.3);
        foot.rotation.x = -kneeLift * (0.18 + runBlend * 0.24) + Math.max(0, -swing) * 0.08;
      });
      if (explorationMode === 'person') {
        updateIslandJump(jumpState, input.jumpPressed, dt);
      }
      avatar.position.y = sampleElevation(terrain, avatar.position.x, avatar.position.z) + SPAWN_HEIGHT + jumpState.height;
      groundPosition.copy(avatar.position);
    }
    const viewPosition = flightMode ? flightPosition : avatar.position;
    minimap?.updatePlayer(viewPosition.x, viewPosition.z, yaw);
    if (compassLabel) compassLabel.textContent = headingLabel(yaw);
    if (compassNeedle) compassNeedle.style.transform = `rotate(${yaw}rad)`;
    if (waypoint) {
      const dxToWaypoint = waypoint.x - viewPosition.x;
      const dzToWaypoint = waypoint.z - viewPosition.z;
      if (waypointArrow) {
        waypointArrow.hidden = false;
        waypointArrow.style.transform = `rotate(${Math.atan2(dxToWaypoint, -dzToWaypoint) - yaw}rad)`;
      }
    }
    boats.forEach(({ boat, phase, x, z, yaw }) => {
      const swell = now * 0.0012 + phase;
      boat.position.set(
        x + Math.sin(swell * 0.43) * 0.12,
        0.55 + Math.sin(swell) * 0.12,
        z + Math.cos(swell * 0.38) * 0.08
      );
      boat.rotation.set(
        Math.sin(swell * 0.71) * 0.018,
        yaw + Math.sin(swell * 0.36) * 0.014,
        Math.sin(swell * 0.83) * 0.032
      );
    });
    const waveTexture = ocean.material.bumpMap;
    waveTexture.offset.x = (waveTexture.offset.x + dt * 0.00045) % 1;
    waveTexture.offset.y = (waveTexture.offset.y - dt * 0.0008 + 1) % 1;
    renderer.render(scene, camera);
    if (loadingScreen && !loadingScreen.classList.contains('is-ready')) {
      setLoadingProgress(100, '¡La isla está lista!');
      loadingScreen.classList.add('is-ready');
      window.setTimeout(() => { loadingScreen.hidden = true; }, 450);
    }
    requestAnimationFrame(animate);
  }
  cameraController.setMode('standard');
  cameraController.update(1 / 60, {
    lookX: 0, lookY: 0, stickX: 0, stickY: 0
  });
  cameraModeButton?.setAttribute('aria-pressed', 'true');
  if (cameraModeButton) cameraModeButton.textContent = 'Vista: tercera persona';
  setStatus(`La Graciosa · DEM 0–${Math.round(ELEVATION.maxElevation)} m · ${GEO.buildings.length.toLocaleString()} edificios · 1 a pie, 3 gaviota`);
  requestAnimationFrame(animate);
}

start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`No se pudo iniciar WebGPU: ${message}`);
  showLoadingError(error);
  console.error(error);
});
