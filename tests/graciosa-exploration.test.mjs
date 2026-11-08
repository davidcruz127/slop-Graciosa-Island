import assert from 'node:assert/strict';
import test from 'node:test';
import { ELEVATION } from '../js/graciosa-elevation.js';
import { GEO } from '../js/graciosa-geodata.js';
import { decodeElevationGrid, sampleElevation } from '../js/graciosa-terrain.js';
import { createIslandNavigator, EXPLORATION_MODES, headingFromVelocity, headingLabel, ISLAND_POIS, updateIslandFlight, updateIslandJump, updateIslandMovement, updateSeagullPose } from '../js/graciosa-exploration.js';

const square = (minX, minZ, maxX, maxZ) => [
  [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]
];

test('walking heading points the model forward along its actual world velocity', () => {
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1]]) {
    const yaw = headingFromVelocity(x, z);
    const length = Math.hypot(x, z);
    assert.ok(Math.abs(-Math.sin(yaw) - x / length) < 1e-9);
    assert.ok(Math.abs(-Math.cos(yaw) - z / length) < 1e-9);
  }
  assert.equal(headingFromVelocity(0, 0), null);
});

test('walking stays on land, avoids building footprints, roads and steep grades', () => {
  const geodata = {
    land: [square(0, 0, 30, 30)],
    buildings: [{ polygons: [{ outer: square(10, 10, 15, 15), holes: [] }] }],
    roads: [{ width: 3, points: [[2, 20], [28, 20]] }]
  };
  const navigator = createIslandNavigator(geodata, (x) => x > 24 ? 30 : 0, { radius: 0.5 });
  assert.equal(navigator.isWalkable(5, 5), true);
  assert.equal(navigator.isWalkable(12, 12), false);
  assert.equal(navigator.isWalkable(-1, 5), false);
  assert.equal(navigator.isNearRoad(12, 20, 2), true);
  assert.equal(navigator.isNearRoad(12, 5, 2), false);
  assert.equal(navigator.canMove(5, 5, 12, 12), false);
  assert.equal(navigator.isWalkable(26, 5), false);
});

test('walking acceleration normalizes diagonal input and keeps blocked motion inside land', () => {
  const navigator = createIslandNavigator({ land: [square(-20, -20, 20, 20)], buildings: [], roads: [] }, () => 0);
  const position = { x: 0, z: 0 };
  const velocity = { x: 0, z: 0 };
  updateIslandMovement(position, velocity, { forward: 1, side: 1 }, 0, 0.05, navigator);
  assert.ok(Math.abs(Math.hypot(velocity.x, velocity.z) - 0.9) < 1e-9);
  assert.ok(Math.abs(velocity.x + velocity.z) < 1e-9);

  const edgeNavigator = {
    isWalkable: (x, z) => x < 1 && x > -20 && z < 20 && z > -20,
    canMove: (_fromX, _fromZ, toX, toZ) => toX < 1 && toX > -20 && toZ < 20 && toZ > -20
  };
  const edgePosition = { x: 0, z: 0 };
  const edgeVelocity = { x: 0, z: 0 };
  for (let i = 0; i < 40; i++) {
    updateIslandMovement(edgePosition, edgeVelocity, { forward: 1, side: 0 }, Math.PI / 2, 0.05, edgeNavigator);
  }
  assert.ok(edgePosition.x < 1);
  assert.equal(edgeVelocity.x, 0);
});

test('analog movement scales walking speed for precise steering', () => {
  const navigator = createIslandNavigator({ land: [square(-100, -100, 100, 100)], buildings: [], roads: [] }, () => 0);
  const position = { x: 0, z: 0 };
  const velocity = { x: 0, z: 0 };
  let movement;
  for (let frame = 0; frame < 60; frame++) {
    movement = updateIslandMovement(position, velocity, { forward: 0.3, side: 0 }, 0, 0.05, navigator);
  }
  assert.ok(Math.abs(movement.speed - 1.5) < 1e-9);
  assert.ok(position.z < 0 && position.z > -5);
});

test('person and bicycle modes apply distinct travel speeds while the gull can fly over the sea', () => {
  assert.deepEqual(Object.keys(EXPLORATION_MODES), ['person', 'bicycle', 'seagull']);
  const navigator = createIslandNavigator({ land: [square(-100, -100, 100, 100)], buildings: [], roads: [] }, () => 0);
  const travelSpeed = (mode, sprint) => {
    const position = { x: 0, z: 0 };
    const velocity = { x: 0, z: 0 };
    let result;
    for (let i = 0; i < 80; i++) {
      result = updateIslandMovement(position, velocity, { forward: 1, side: 0, sprint }, 0, 0.05, navigator, mode);
    }
    return result.speed;
  };
  assert.equal(travelSpeed(EXPLORATION_MODES.person, false), 5);
  assert.equal(travelSpeed(EXPLORATION_MODES.bicycle, false), 8.5);
  assert.equal(travelSpeed(EXPLORATION_MODES.person, true), 8.5);
  assert.equal(travelSpeed(EXPLORATION_MODES.bicycle, true), 13.5);
  assert.equal(EXPLORATION_MODES.seagull.speed, 12);
  assert.equal(EXPLORATION_MODES.seagull.boostSpeed, 25);
});

test('bicycle reverse and handbrake have distinct movement behavior', () => {
  const navigator = createIslandNavigator({ land: [square(-100, -100, 100, 100)], buildings: [], roads: [] }, () => 0);
  const position = { x: 0, z: 0 };
  const velocity = { x: 0, z: 0 };
  for (let i = 0; i < 80; i++) {
    updateIslandMovement(position, velocity, { forward: 1, reverse: true }, 0, 0.05, navigator, EXPLORATION_MODES.bicycle);
  }
  assert.ok(Math.abs(velocity.z - EXPLORATION_MODES.bicycle.reverseSpeed) < 1e-9);
  for (let i = 0; i < 5; i++) {
    updateIslandMovement(position, velocity, { forward: 0, brake: true }, 0, 0.05, navigator, EXPLORATION_MODES.bicycle);
  }
  assert.equal(velocity.z, 0);
});

test('the foot jump follows a gravity arc, lands, and cannot double-jump in the air', () => {
  const state = { height: 0, velocity: 0, grounded: true };
  updateIslandJump(state, true, 0.05);
  assert.equal(state.grounded, false);
  assert.ok(state.height > 0);
  const firstVelocity = state.velocity;
  updateIslandJump(state, true, 0.05);
  assert.ok(state.velocity < firstVelocity);
  for (let i = 0; i < 80; i++) updateIslandJump(state, false, 0.05);
  assert.deepEqual(state, { height: 0, velocity: 0, grounded: true });
});

test('free-flight controls climb vertically, accelerate and brake without ground constraints', () => {
  const position = { x: 0, y: 10, z: 0 };
  const velocity = { x: 0, y: 0, z: 0 };
  updateIslandFlight(position, velocity, { forward: 0, side: 0, vertical: 1, sprint: false }, 0, 0.05);
  assert.ok(position.y > 10);
  assert.equal(position.x, 0);
  assert.equal(position.z, 0);
  const walkingSpeed = velocity.y;
  for (let i = 0; i < 10; i++) {
    updateIslandFlight(position, velocity, { forward: 0, side: 0, vertical: 1, sprint: true }, 0, 0.05);
  }
  assert.ok(velocity.y > walkingSpeed);
  const speedBeforeBrake = velocity.y;
  updateIslandFlight(position, velocity, { forward: 0, side: 0, vertical: 0, sprint: false }, 0, 0.05);
  assert.ok(velocity.y < speedBeforeBrake);
});

test('the seagull banks into turns and pitches smoothly while climbing', () => {
  const pose = { yaw: 0, bank: 0, pitch: 0 };
  const velocity = { x: 12, y: 4, z: 0 };
  updateSeagullPose(pose, velocity, 0, 0.05);
  assert.ok(pose.yaw < 0 && pose.yaw > -Math.PI / 2);
  assert.ok(pose.bank > 0);
  assert.ok(pose.pitch > 0);
  for (let frame = 0; frame < 80; frame++) updateSeagullPose(pose, velocity, 0, 0.05);
  assert.ok(Math.abs(pose.yaw + Math.PI / 2) < 0.001);
  assert.ok(pose.bank > 0 && pose.bank <= 0.48);
  assert.ok(pose.pitch > 0 && pose.pitch <= 0.42);
});

test('spawn inside mapped building can exit and teleport candidates find nearby safe ground', () => {
  const geodata = {
    land: [square(0, 0, 40, 40)],
    buildings: [{ polygons: [{ outer: square(8, 8, 14, 14), holes: [] }] }],
    roads: []
  };
  const navigator = createIslandNavigator(geodata, () => 0, { spawn: [10, 10], radius: 0.5 });
  assert.equal(navigator.isWalkable(10, 10), false);
  assert.equal(navigator.canMove(10, 10, 15, 10, true), true);
  assert.deepEqual(navigator.nearestWalkable(10, 10), [6, 6]);
  assert.equal(navigator.nearestWalkable(-30, -30, 5), null);
});

test('island points of interest have stable ids and compass headings wrap north', () => {
  assert.ok(ISLAND_POIS.some(({ id }) => id === 'caleta'));
  assert.ok(ISLAND_POIS.some(({ id }) => id === 'high-point'));
  assert.equal(headingLabel(0), 'N');
  assert.equal(headingLabel(Math.PI / 2), 'E');
  assert.equal(headingLabel(Math.PI), 'S');
  assert.equal(headingLabel(-Math.PI / 2), 'W');
});

test('all displayed real-island landmarks resolve to safe teleport destinations', () => {
  const terrain = decodeElevationGrid(ELEVATION);
  const navigator = createIslandNavigator(GEO, (x, z) => sampleElevation(terrain, x, z), { spawn: [0, 0] });
  for (const poi of ISLAND_POIS) {
    const destination = navigator.nearestWalkable(poi.x, poi.z, 150);
    assert.ok(destination, `${poi.name} should have nearby walkable ground`);
    assert.equal(navigator.isWalkable(destination[0], destination[1]), true);
  }
});
