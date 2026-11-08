export const EXPLORATION_MODES = Object.freeze({
  person: Object.freeze({ label: 'A pie', walkSpeed: 5, runSpeed: 8.5, acceleration: 24, deceleration: 28 }),
  bicycle: Object.freeze({ label: 'Bicicleta', walkSpeed: 8.5, runSpeed: 13.5, acceleration: 18, deceleration: 24, reverseSpeed: 2.5, braking: 40 }),
  seagull: Object.freeze({ label: 'Gaviota', speed: 12, boostSpeed: 25 })
});

export function headingFromVelocity(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) < 1e-6) return null;
  return Math.atan2(-x, -z);
}

export function updateSeagullPose(pose, velocity, cameraYaw, deltaTime) {
  const dt = Math.max(0, Math.min(deltaTime, 0.05));
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  const targetYaw = horizontalSpeed > 0.8
    ? headingFromVelocity(velocity.x, velocity.z)
    : cameraYaw;
  const angleDelta = Math.atan2(Math.sin(targetYaw - pose.yaw), Math.cos(targetYaw - pose.yaw));
  const turnBlend = 1 - Math.exp(-dt * 4.5);
  const turn = angleDelta * turnBlend;
  pose.yaw += turn;

  const targetBank = Math.max(-0.48, Math.min(0.48, -turn / Math.max(dt, 1e-6) * 0.18));
  const bankBlend = 1 - Math.exp(-dt * 3.5);
  pose.bank += (targetBank - pose.bank) * bankBlend;

  const targetPitch = Math.max(-0.42, Math.min(0.42, Math.atan2(velocity.y, Math.max(2, horizontalSpeed)) * 0.62));
  pose.pitch += (targetPitch - pose.pitch) * bankBlend;
  return pose;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, z, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function distanceToRing(x, z, ring) {
  let distance = Infinity;
  for (let i = 0; i < ring.length; i++) distance = Math.min(distance, distanceToSegment(x, z, ring[i], ring[(i + 1) % ring.length]));
  return distance;
}

function insideBuilding(x, z, polygon, radius) {
  if (!pointInRing(x, z, polygon.outer)) {
    return distanceToRing(x, z, polygon.outer) < radius;
  }
  for (const hole of polygon.holes || []) {
    if (pointInRing(x, z, hole)) {
      if (distanceToRing(x, z, hole) >= radius) return false;
      return true;
    }
  }
  return true;
}

export function createIslandNavigator(geodata, elevationAt, options = {}) {
  const radius = options.radius ?? 0.42;
  const maxGrade = options.maxGrade ?? 0.72;
  const spawn = options.spawn || [0, 0];
  const land = geodata.land;
  const cellSize = 80;
  const buildings = geodata.buildings.flatMap((building) => building.polygons.map((polygon) => {
    const xs = polygon.outer.map(([x]) => x);
    const zs = polygon.outer.map(([, z]) => z);
    return {
      ...polygon,
      bounds: {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minZ: Math.min(...zs), maxZ: Math.max(...zs)
      }
    };
  }));
  const buildingCells = new Map();
  for (const polygon of buildings) {
    const minCellX = Math.floor(polygon.bounds.minX / cellSize);
    const maxCellX = Math.floor(polygon.bounds.maxX / cellSize);
    const minCellZ = Math.floor(polygon.bounds.minZ / cellSize);
    const maxCellZ = Math.floor(polygon.bounds.maxZ / cellSize);
    for (let x = minCellX; x <= maxCellX; x++) {
      for (let z = minCellZ; z <= maxCellZ; z++) {
        const key = `${x},${z}`;
        if (!buildingCells.has(key)) buildingCells.set(key, []);
        buildingCells.get(key).push(polygon);
      }
    }
  }
  const roadCells = new Map();
  for (const road of geodata.roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      const padding = Math.max(12, road.width);
      const minCellX = Math.floor((Math.min(a[0], b[0]) - padding) / cellSize);
      const maxCellX = Math.floor((Math.max(a[0], b[0]) + padding) / cellSize);
      const minCellZ = Math.floor((Math.min(a[1], b[1]) - padding) / cellSize);
      const maxCellZ = Math.floor((Math.max(a[1], b[1]) + padding) / cellSize);
      const segment = { a, b };
      for (let x = minCellX; x <= maxCellX; x++) {
        for (let z = minCellZ; z <= maxCellZ; z++) {
          const key = `${x},${z}`;
          if (!roadCells.has(key)) roadCells.set(key, []);
          roadCells.get(key).push(segment);
        }
      }
    }
  }
  const landBounds = land.map((ring) => ({
    ring,
    minX: Math.min(...ring.map(([x]) => x)), maxX: Math.max(...ring.map(([x]) => x)),
    minZ: Math.min(...ring.map(([, z]) => z)), maxZ: Math.max(...ring.map(([, z]) => z))
  }));
  const candidateBuildings = (x, z) => {
    const minX = Math.floor((x - radius) / cellSize);
    const maxX = Math.floor((x + radius) / cellSize);
    const minZ = Math.floor((z - radius) / cellSize);
    const maxZ = Math.floor((z + radius) / cellSize);
    const candidates = new Set();
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
        for (const polygon of buildingCells.get(`${cellX},${cellZ}`) || []) candidates.add(polygon);
      }
    }
    return candidates;
  };
  const isNearRoad = (x, z, distance = 10) => {
    const minX = Math.floor((x - distance) / cellSize);
    const maxX = Math.floor((x + distance) / cellSize);
    const minZ = Math.floor((z - distance) / cellSize);
    const maxZ = Math.floor((z + distance) / cellSize);
    const segments = new Set();
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
        for (const segment of roadCells.get(`${cellX},${cellZ}`) || []) segments.add(segment);
      }
    }
    for (const { a, b } of segments) if (distanceToSegment(x, z, a, b) < distance) return true;
    return false;
  };
  const spawnBuildings = buildings.filter((polygon) =>
    pointInRing(spawn[0], spawn[1], polygon.outer)
      && !(polygon.holes || []).some((hole) => pointInRing(spawn[0], spawn[1], hole)));
  const isOnLand = (x, z) => landBounds.some((island) =>
    x >= island.minX && x <= island.maxX && z >= island.minZ && z <= island.maxZ
      && pointInRing(x, z, island.ring));
  const hasBuildingCollision = (x, z) => {
    for (const polygon of candidateBuildings(x, z)) {
      if (x + radius >= polygon.bounds.minX && x - radius <= polygon.bounds.maxX
        && z + radius >= polygon.bounds.minZ && z - radius <= polygon.bounds.maxZ
        && insideBuilding(x, z, polygon, radius)) return true;
    }
    return false;
  };
  const hasWalkableGrade = (x, z) => {
    const sample = 6;
    const base = elevationAt(x, z);
    return [[sample, 0], [-sample, 0], [0, sample], [0, -sample]]
      .every(([dx, dz]) => Math.abs(elevationAt(x + dx, z + dz) - base) <= sample * maxGrade);
  };
  const isWalkable = (x, z) => {
    if (![x, z].every(Number.isFinite)) return false;
    for (const [dx, dz] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
      if (!isOnLand(x + dx, z + dz)) return false;
    }
    return !hasBuildingCollision(x, z) && hasWalkableGrade(x, z);
  };
  const canMove = (fromX, fromZ, toX, toZ, allowSpawnExit = false) => {
    const distance = Math.hypot(toX - fromX, toZ - fromZ);
    if (!isWalkable(toX, toZ)) {
      const leavingSpawn = allowSpawnExit && Math.hypot(fromX - spawn[0], fromZ - spawn[1]) < 30;
      if (!leavingSpawn || !isOnLand(toX, toZ)) return false;
      for (const polygon of candidateBuildings(toX, toZ)) {
        if (!spawnBuildings.includes(polygon) && insideBuilding(toX, toZ, polygon, radius)) return false;
      }
    }
    const elevationDelta = Math.abs(elevationAt(toX, toZ) - elevationAt(fromX, fromZ));
    return elevationDelta <= Math.max(0.6, distance * maxGrade);
  };
  const nearestWalkable = (x, z, maxDistance = 150) => {
    if (isWalkable(x, z)) return [x, z];
    const step = Math.max(2, radius * 2);
    for (let distance = step; distance <= maxDistance; distance += step) {
      for (let dx = -distance; dx <= distance; dx += step) {
        for (const dz of [-distance, distance]) {
          if (isWalkable(x + dx, z + dz)) return [x + dx, z + dz];
        }
      }
      for (let dz = -distance + step; dz < distance; dz += step) {
        for (const dx of [-distance, distance]) {
          if (isWalkable(x + dx, z + dz)) return [x + dx, z + dz];
        }
      }
    }
    return null;
  };
  return { isOnLand, isWalkable, isNearRoad, canMove, nearestWalkable };
}

export function updateIslandMovement(position, velocity, input, yaw, deltaTime, navigator, options = {}) {
  const dt = Math.max(0, Math.min(deltaTime, 0.05));
  const forwardInput = input.forward ?? 0;
  const sideInput = input.side ?? 0;
  const inputLength = Math.hypot(forwardInput, sideInput);
  const inputStrength = Math.min(1, inputLength);
  const inputScale = inputLength > 0 ? 1 / inputLength : 1;
  const forward = forwardInput * inputScale;
  const side = sideInput * inputScale;
  const speed = input.brake ? 0 : (input.reverse
    ? -(options.reverseSpeed ?? 2.5)
    : input.sprint ? (options.runSpeed ?? 8.5) : (options.walkSpeed ?? 5)) * inputStrength;
  const targetX = (Math.sin(yaw) * forward + Math.cos(yaw) * side) * speed;
  const targetZ = (-Math.cos(yaw) * forward + Math.sin(yaw) * side) * speed;
  const acceleration = input.brake
    ? (options.braking ?? 40)
    : inputLength ? (options.acceleration ?? 18) : (options.deceleration ?? 22);
  const differenceX = targetX - velocity.x;
  const differenceZ = targetZ - velocity.z;
  const differenceLength = Math.hypot(differenceX, differenceZ);
  const maxChange = acceleration * dt;
  if (differenceLength > maxChange && differenceLength > 0) {
    velocity.x += differenceX / differenceLength * maxChange;
    velocity.z += differenceZ / differenceLength * maxChange;
  } else {
    velocity.x = targetX;
    velocity.z = targetZ;
  }

  const fromX = position.x;
  const fromZ = position.z;
  const toX = fromX + velocity.x * dt;
  const toZ = fromZ + velocity.z * dt;
  const allowSpawnExit = !navigator.isWalkable(fromX, fromZ);
  if (navigator.canMove(fromX, fromZ, toX, toZ, allowSpawnExit)) {
    position.x = toX;
    position.z = toZ;
  } else {
    if (velocity.x && navigator.canMove(fromX, fromZ, toX, fromZ, allowSpawnExit)) position.x = toX;
    else velocity.x = 0;
    if (velocity.z && navigator.canMove(position.x, fromZ, position.x, toZ, allowSpawnExit)) position.z = toZ;
    else velocity.z = 0;
  }
  return { position, velocity, speed: Math.hypot(velocity.x, velocity.z) };
}

export function updateIslandJump(state, jumpPressed, deltaTime, options = {}) {
  const dt = Math.max(0, Math.min(deltaTime, 0.05));
  if (jumpPressed && state.grounded) {
    state.velocity = options.jumpVelocity ?? 7.5;
    state.grounded = false;
  }
  if (!state.grounded) {
    state.height += state.velocity * dt;
    state.velocity -= (options.gravity ?? 20) * dt;
    if (state.height <= 0) {
      state.height = 0;
      state.velocity = 0;
      state.grounded = true;
    }
  }
  return state;
}

export function updateIslandFlight(position, velocity, input, yaw, deltaTime, options = {}) {
  const dt = Math.max(0, Math.min(deltaTime, 0.05));
  const forwardInput = input.forward ?? 0;
  const sideInput = input.side ?? 0;
  const verticalInput = input.vertical ?? 0;
  const inputLength = Math.hypot(forwardInput, sideInput, verticalInput);
  const inputScale = inputLength > 1 ? 1 / inputLength : 1;
  const forward = forwardInput * inputScale;
  const side = sideInput * inputScale;
  const vertical = verticalInput * inputScale;
  const speed = input.sprint ? (options.boostSpeed ?? 60) : (options.speed ?? 24);
  const target = {
    x: (Math.sin(yaw) * forward + Math.cos(yaw) * side) * speed,
    y: vertical * speed,
    z: (-Math.cos(yaw) * forward + Math.sin(yaw) * side) * speed
  };
  const acceleration = inputLength ? (options.acceleration ?? 36) : (options.deceleration ?? 42);
  const difference = {
    x: target.x - velocity.x,
    y: target.y - velocity.y,
    z: target.z - velocity.z
  };
  const differenceLength = Math.hypot(difference.x, difference.y, difference.z);
  const maxChange = acceleration * dt;
  if (differenceLength > maxChange && differenceLength > 0) {
    velocity.x += difference.x / differenceLength * maxChange;
    velocity.y += difference.y / differenceLength * maxChange;
    velocity.z += difference.z / differenceLength * maxChange;
  } else {
    Object.assign(velocity, target);
  }
  position.x += velocity.x * dt;
  position.y += velocity.y * dt;
  position.z += velocity.z * dt;
  return { position, velocity, speed: Math.hypot(velocity.x, velocity.y, velocity.z) };
}

export const ISLAND_POIS = Object.freeze([
  Object.freeze({ id: 'caleta', name: 'Puerto · Caleta de Sebo', x: 0, z: 0, category: 'harbor' }),
  Object.freeze({ id: 'church', name: 'Parroquia Virgen del Mar', x: 73.5, z: -12.2, category: 'heritage' }),
  Object.freeze({ id: 'high-point', name: 'Agujas Grandes · cota DEM', x: -15, z: -2415, category: 'viewpoint' }),
  Object.freeze({ id: 'pedro-barba', name: 'Pedro Barba', x: 1513.5, z: -2588.6, category: 'village' })
]);

export function headingLabel(yaw) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(((yaw % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % directions.length];
}
