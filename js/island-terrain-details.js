export function createIslandTerrainDetails(bounds, sampleElevation, navigator, focus = null) {
  if (!bounds || typeof sampleElevation !== 'function' || typeof navigator?.isWalkable !== 'function') {
    throw new TypeError('Terrain details require bounds, an elevation sampler, and an island navigator.');
  }

  const details = { scrub: [], rocks: [], dunes: [] };
  const limits = { scrub: 320, rocks: 110, dunes: 90 };
  const minimumSpacing = { scrub: 11, rocks: 25, dunes: 32 };
  const focusedCounts = { scrub: 0, rocks: 0, dunes: 0 };
  const focusedLimits = { scrub: 176, rocks: 60, dunes: 49 };
  let seed = 0x4c475244;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const focusedGridSize = 25;
  const focusedGrid = Array.from({ length: focusedGridSize * focusedGridSize }, (_, index) => {
    const column = index % focusedGridSize;
    const row = Math.floor(index / focusedGridSize);
    return {
      column,
      row,
      distance: Math.hypot(column - (focusedGridSize - 1) / 2, row - (focusedGridSize - 1) / 2)
    };
  }).sort((a, b) => a.distance - b.distance);
  const spaced = (kind, x, z) => details[kind].every((detail) =>
    Math.hypot(detail.x - x, detail.z - z) >= minimumSpacing[kind]);

  for (let attempt = 0; attempt < 16000; attempt++) {
    if (Object.keys(limits).every((kind) => details[kind].length >= limits[kind])) break;
    const hasFocus = Array.isArray(focus) && focus.length === 2;
    const isFocused = hasFocus && (attempt < focusedGridSize * focusedGridSize || random() < 0.58);
    let x;
    let z;
    if (hasFocus && attempt < focusedGrid.length) {
      const { column, row } = focusedGrid[attempt];
      x = focus[0] + (column - (focusedGridSize - 1) / 2) * 55;
      z = focus[1] + (row - (focusedGridSize - 1) / 2) * 55;
    } else if (isFocused) {
      x = focus[0] + (random() - 0.5) * 1400;
      z = focus[1] + (random() - 0.5) * 1400;
    } else {
      x = bounds.minX + random() * (bounds.maxX - bounds.minX);
      z = bounds.minZ + random() * (bounds.maxZ - bounds.minZ);
    }
    if (isFocused && Math.hypot(x - focus[0], z - focus[1]) < 35) continue;
    if (!navigator.isWalkable(x, z) || navigator.isNearRoad(x, z, 10)) continue;

    const elevation = sampleElevation(x, z);
    const slopeX = (sampleElevation(x + 5, z) - sampleElevation(x - 5, z)) / 10;
    const slopeZ = (sampleElevation(x, z + 5) - sampleElevation(x, z - 5)) / 10;
    const slope = Math.hypot(slopeX, slopeZ);
    if (elevation >= 5 && elevation <= 180 && slope < 0.58 && details.rocks.length < limits.rocks
      && (!isFocused || focusedCounts.rocks < focusedLimits.rocks)
      && spaced('rocks', x, z)) {
      const height = 0.35 + random() * 1.1;
      details.rocks.push({
        x, z, elevation, slopeX, slopeZ,
        scaleX: height * (0.8 + random() * 0.8),
        scaleY: height * (0.55 + random() * 0.7),
        scaleZ: height * (0.75 + random() * 0.8),
        yaw: random() * Math.PI * 2,
        tint: [0x514b40, 0x62584a, 0x716654][Math.floor(random() * 3)]
      });
      if (isFocused) focusedCounts.rocks++;
    }

    if (elevation <= 38 && slope < 0.16 && details.dunes.length < limits.dunes
      && (!isFocused || focusedCounts.dunes < focusedLimits.dunes)
      && spaced('dunes', x, z)) {
      const scale = 1.8 + random() * 2.4;
      details.dunes.push({
        x, z, elevation, slopeX, slopeZ,
        scaleX: scale * (1.2 + random() * 0.8),
        scaleY: scale * (0.18 + random() * 0.12),
        scaleZ: scale * (0.55 + random() * 0.7),
        yaw: random() * Math.PI * 2,
        tint: [0xc1a36f, 0xd0b27a, 0xb99d6d][Math.floor(random() * 3)]
      });
      if (isFocused) focusedCounts.dunes++;
    }

    if (elevation <= 150 && details.scrub.length < limits.scrub
      && (!isFocused || focusedCounts.scrub < focusedLimits.scrub)
      && spaced('scrub', x, z)) {
      const scale = 0.65 + random() * 0.8;
      details.scrub.push({
        x, z, elevation, slopeX, slopeZ,
        scaleX: scale * (0.85 + random() * 0.35),
        scaleY: scale,
        scaleZ: scale * (0.8 + random() * 0.4),
        yaw: random() * Math.PI * 2,
        tint: [0x78876c, 0x929274, 0x756f59, 0x9c956d][Math.floor(random() * 4)]
      });
      if (isFocused) focusedCounts.scrub++;
    }
  }
  return details;
}
