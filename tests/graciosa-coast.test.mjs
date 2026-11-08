import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { COAST_LAYERS, createCoastGeometry, prepareCoastRing } from '../js/graciosa-coast.js';
import { GEO } from '../js/graciosa-geodata.js';

test('coast rings remove duplicate closure points and keep shoreline segments smooth and bounded', () => {
  const ring = prepareCoastRing([
    [0, 0], [240, 0], [240, 0], [240, 80], [0, 80], [0, 0]
  ]);
  assert.ok(ring.length > 25);
  assert.notDeepEqual(ring[0], ring.at(-1));
  for (let index = 0; index < ring.length; index++) {
    const next = ring[(index + 1) % ring.length];
    const distance = Math.hypot(next[0] - ring[index][0], next[1] - ring[index][1]);
    assert.ok(distance > 0.05 && distance <= 14.01);
  }
});

test('the full island coastline and islet receive continuous shallows and wave-matched foam geometry', () => {
  const coastSource = readFileSync(new URL('../js/graciosa-coast.js', import.meta.url), 'utf8');
  assert.match(coastSource, /FOAM_OFFSETS = Object\.freeze\(\[1\.2, 5\.8\]\)/);
  const coast = createCoastGeometry(GEO.land, () => 0);
  const shoreVertices = coast.shorePositions.length / 3;
  const foamVertices = coast.foamPositions.length / 3;

  assert.equal(GEO.land.length, 2);
  assert.ok(shoreVertices > GEO.land.reduce((sum, ring) => sum + ring.length, 0) * 8);
  assert.equal(coast.shoreColors.length, coast.shorePositions.length);
  assert.equal(coast.shoreWaveMix.length, shoreVertices);
  assert.equal(foamVertices * COAST_LAYERS.length, shoreVertices * 2);
  assert.ok(coast.shoreIndices.length > shoreVertices * 4);
  assert.ok(coast.foamIndices.length > foamVertices * 2);
  assert.ok([...coast.shoreIndices].every((index) => index < shoreVertices));
  assert.ok([...coast.foamIndices].every((index) => index < foamVertices));
  assert.ok([...coast.shorePositions, ...coast.shoreColors, ...coast.foamPositions].every(Number.isFinite));
  assert.ok(coast.shorePositions.some((_, index) => index % 3 === 1 && Math.abs(coast.shorePositions[index] - 0.06) < 1e-5));
  assert.ok(coast.foamPositions.every((_, index) => index % 3 !== 1 || Math.abs(coast.foamPositions[index] - 0.12) < 1e-5));
});
