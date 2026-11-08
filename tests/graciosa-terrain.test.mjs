import assert from 'node:assert/strict';
import test from 'node:test';
import { ELEVATION } from '../js/graciosa-elevation.js';
import { GEO } from '../js/graciosa-geodata.js';
import { createTerrainSurface, decodeElevationGrid, sampleElevation } from '../js/graciosa-terrain.js';

function gridFromDecimeters(values, width, height, minX = 0, minZ = 0, step = 5) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  return decodeElevationGrid({ width, height, minX, minZ, step, elevations: bytes.toString('base64') });
}

test('elevation grids decode signed decimetres and bilinearly sample in world coordinates', () => {
  const grid = gridFromDecimeters([0, 10, 20, 10, 20, 30, 20, 30, 40], 3, 3);
  assert.equal(sampleElevation(grid, 0, 0), 0);
  assert.equal(sampleElevation(grid, 5, 5), 2);
  assert.equal(sampleElevation(grid, 2.5, 2.5), 1);
  assert.throws(() => decodeElevationGrid({ ...grid, elevations: '' }), /unexpected length/);
});

test('terrain surface creates upward-facing, coastline-clipped island triangles', () => {
  const grid = gridFromDecimeters([0, 10, 20, 10, 20, 30, 20, 30, 40], 3, 3);
  const land = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const surface = createTerrainSurface(grid, land);
  assert.equal(surface.positions.length, 27);
  assert.equal(surface.indices.length, 24);
  assert.ok(surface.indices.every((index) => index >= 0 && index < 9));
  const [a, b, c] = surface.indices;
  const ax = surface.positions[a * 3], az = surface.positions[a * 3 + 2];
  const bx = surface.positions[b * 3], bz = surface.positions[b * 3 + 2];
  const cx = surface.positions[c * 3], cz = surface.positions[c * 3 + 2];
  assert.ok((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0);
});

test('the compiled island DEM contains meaningful above-sea-level relief', () => {
  assert.equal(ELEVATION.step, 15);
  assert.ok(ELEVATION.width > 400 && ELEVATION.height > 400);
  assert.ok(ELEVATION.minElevation >= 0);
  assert.ok(ELEVATION.maxElevation > 200 && ELEVATION.maxElevation < 300);
  const grid = decodeElevationGrid(ELEVATION);
  assert.ok(sampleElevation(grid, 0, 0) > 0);
  const surface = createTerrainSurface(grid, GEO.land);
  assert.ok(surface.indices.length > 100_000);
});

test('the Caleta port spawn is covered by a rendered terrain triangle', () => {
  const grid = decodeElevationGrid(ELEVATION);
  const surface = createTerrainSurface(grid, GEO.land);
  const x = 15;
  const z = 183;
  const col = Math.floor((x - grid.minX) / grid.step);
  const row = Math.floor((z - grid.minZ) / grid.step);
  const cellVertices = new Set([
    row * grid.width + col,
    row * grid.width + col + 1,
    (row + 1) * grid.width + col,
    (row + 1) * grid.width + col + 1
  ]);
  let covered = false;

  for (let i = 0; i < surface.indices.length; i += 3) {
    const a = surface.indices[i];
    const b = surface.indices[i + 1];
    const c = surface.indices[i + 2];
    if (!cellVertices.has(a) || !cellVertices.has(b) || !cellVertices.has(c)) continue;
    const ax = surface.positions[a * 3], az = surface.positions[a * 3 + 2];
    const bx = surface.positions[b * 3], bz = surface.positions[b * 3 + 2];
    const cx = surface.positions[c * 3], cz = surface.positions[c * 3 + 2];
    const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(denominator) < 1e-8) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
    if (u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001) {
      covered = true;
      break;
    }
  }

  assert.ok(covered, 'the player spawn must be on the rendered land mesh, not a coastline hole');
});
