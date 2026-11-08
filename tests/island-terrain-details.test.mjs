import assert from 'node:assert/strict';
import test from 'node:test';
import { createIslandTerrainDetails } from '../js/island-terrain-details.js';

const flatNavigator = {
  isWalkable: (x, z) => x >= 0 && x <= 2000 && z >= 0 && z <= 2000,
  isNearRoad: (x, z, distance) => x < distance + 50 && z < distance + 50
};

test('terrain detail placement is deterministic, bounded, and avoids roads and unwalkable terrain', () => {
  const bounds = { minX: 0, maxX: 2000, minZ: 0, maxZ: 2000 };
  const elevation = () => 20;
  const first = createIslandTerrainDetails(bounds, elevation, flatNavigator, [1000, 1000]);
  const second = createIslandTerrainDetails(bounds, elevation, flatNavigator, [1000, 1000]);
  assert.deepEqual(first, second);
  assert.equal(first.scrub.length, 320);
  assert.equal(first.rocks.length, 110);
  assert.equal(first.dunes.length, 90);
  for (const placements of Object.values(first)) {
    for (const placement of placements) {
      assert.ok(flatNavigator.isWalkable(placement.x, placement.z));
      assert.equal(flatNavigator.isNearRoad(placement.x, placement.z, 10), false);
      assert.equal(placement.elevation, 20);
      assert.ok(placement.scaleX > 0 && placement.scaleY > 0 && placement.scaleZ > 0);
    }
  }
  assert.ok(first.scrub.some(({ x, z }) => Math.hypot(x - 1000, z - 1000) <= 700));
  assert.ok(first.dunes.some(({ x, z }) => Math.hypot(x - 1000, z - 1000) <= 700));
  assert.ok(first.dunes.some(({ x, z }) => Math.hypot(x - 1000, z - 1000) <= 200));
});

test('terrain detail placement keeps each ground cover type within its elevation and slope range', () => {
  const details = createIslandTerrainDetails(
    { minX: 0, maxX: 2000, minZ: 0, maxZ: 2000 },
    (x) => x * 0.3 + 50,
    {
      isWalkable: (x, z) => x >= 0 && x <= 2000 && z >= 0 && z <= 2000,
      isNearRoad: () => false
    }
  );
  assert.equal(details.dunes.length, 0);
  assert.ok(details.scrub.every(({ elevation }) => elevation <= 150));
  assert.ok(details.rocks.every(({ elevation, slopeX }) => elevation <= 180 && Math.abs(slopeX) < 0.58));
});
