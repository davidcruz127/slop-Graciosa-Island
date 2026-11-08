export function decodeElevationGrid(grid) {
  if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
    || grid.width < 2 || grid.height < 2 || !(grid.step > 0)) {
    throw new TypeError('Invalid La Graciosa elevation grid metadata.');
  }
  const bytes = Uint8Array.from(atob(grid.elevations), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== grid.width * grid.height * 2) {
    throw new RangeError('La Graciosa elevation grid data has an unexpected length.');
  }
  const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heights = new Float32Array(grid.width * grid.height);
  for (let i = 0; i < heights.length; i++) heights[i] = values.getInt16(i * 2, true) / 10;
  return { ...grid, heights };
}

export function sampleElevation(grid, x, z) {
  const col = Math.max(0, Math.min(grid.width - 1, (x - grid.minX) / grid.step));
  const row = Math.max(0, Math.min(grid.height - 1, (z - grid.minZ) / grid.step));
  const x0 = Math.floor(col);
  const z0 = Math.floor(row);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const z1 = Math.min(grid.height - 1, z0 + 1);
  const tx = col - x0;
  const tz = row - z0;
  const top = grid.heights[z0 * grid.width + x0] * (1 - tx)
    + grid.heights[z0 * grid.width + x1] * tx;
  const bottom = grid.heights[z1 * grid.width + x0] * (1 - tx)
    + grid.heights[z1 * grid.width + x1] * tx;
  return top * (1 - tz) + bottom * tz;
}

function intervalsAtZ(land, z) {
  const intervals = [];
  for (const ring of land) {
    const crossings = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[j];
      if ((z0 > z) !== (z1 > z)) crossings.push(((x1 - x0) * (z - z0)) / (z1 - z0) + x0);
    }
    crossings.sort((a, b) => a - b);
    for (let i = 1; i < crossings.length; i += 2) intervals.push([crossings[i - 1], crossings[i]]);
  }
  return intervals;
}

function isInIntervals(intervals, x) {
  return intervals.some(([min, max]) => x >= min && x <= max);
}

export function createTerrainSurface(grid, land) {
  const positions = new Float32Array(grid.width * grid.height * 3);
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const index = row * grid.width + col;
      positions[index * 3] = grid.minX + col * grid.step;
      positions[index * 3 + 1] = grid.heights[index];
      positions[index * 3 + 2] = grid.minZ + row * grid.step;
    }
  }
  const indices = [];
  for (let row = 0; row < grid.height - 1; row++) {
    const z = grid.minZ + (row + 0.5) * grid.step;
    const topIntervals = intervalsAtZ(land, z + grid.step / 6);
    const bottomIntervals = intervalsAtZ(land, z - grid.step / 6);
    for (let col = 0; col < grid.width - 1; col++) {
      const topLeft = row * grid.width + col;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + grid.width;
      const bottomRight = bottomLeft + 1;
      const x = grid.minX + (col + 0.5) * grid.step;
      if (isInIntervals(topIntervals, x + grid.step / 6)) {
        indices.push(topLeft, bottomLeft, topRight);
      }
      if (isInIntervals(bottomIntervals, x - grid.step / 6)) {
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }
  }
  return { positions, indices: new Uint32Array(indices) };
}
