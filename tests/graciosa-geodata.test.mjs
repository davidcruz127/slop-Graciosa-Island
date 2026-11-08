import assert from 'node:assert/strict';
import test from 'node:test';
import { compileOverpass, FRAME, project } from '../tools/graciosa-geo.mjs';

test('La Graciosa uses the requested local tangent-plane frame', () => {
  assert.deepEqual(project(FRAME.longitude, FRAME.latitude), [0, 0]);
  const [x, z] = project(FRAME.longitude + 0.001, FRAME.latitude + 0.001);
  assert.ok(x > 0);
  assert.ok(z < 0);
  assert.equal(FRAME.bounds.south, 29.215);
  assert.equal(FRAME.bounds.west, -13.565);
});

test('Overpass features compile to island buildings, tracks and a closed coastline', () => {
  const data = compileOverpass({
    elements: [
      {
        type: 'way', id: 100, tags: { building: 'yes' },
        geometry: [
          { lon: -13.504, lat: 29.232 }, { lon: -13.503, lat: 29.232 },
          { lon: -13.503, lat: 29.231 }, { lon: -13.504, lat: 29.232 }
        ]
      },
      {
        type: 'way', id: 101, tags: { highway: 'track', surface: 'sand' },
        geometry: [{ lon: -13.504, lat: 29.232 }, { lon: -13.503, lat: 29.231 }]
      },
      {
        type: 'relation', id: 102, tags: { building: 'yes', 'building:levels': '2' },
        members: [
          { type: 'way', role: 'outer', geometry: [
            { lon: -13.502, lat: 29.232 }, { lon: -13.501, lat: 29.232 }, { lon: -13.501, lat: 29.231 }
          ] },
          { type: 'way', role: 'outer', geometry: [
            { lon: -13.501, lat: 29.231 }, { lon: -13.502, lat: 29.231 }, { lon: -13.502, lat: 29.232 }
          ] }
        ]
      },
      ...[
        [[-13.51, 29.24], [-13.50, 29.24]],
        [[-13.50, 29.24], [-13.50, 29.23]],
        [[-13.50, 29.23], [-13.51, 29.23]],
        [[-13.51, 29.23], [-13.51, 29.24]]
      ].map((line, index) => ({
        type: 'way', id: 200 + index, nodes: [index, (index + 1) % 4],
        tags: { natural: 'coastline' },
        geometry: line.map(([lon, lat]) => ({ lon, lat }))
      }))
    ]
  });

  assert.equal(data.buildings.length, 2);
  assert.equal(data.buildings[0].height, null);
  assert.equal(data.buildings[1].height, 6);
  assert.equal(data.roads[0].type, 'track');
  assert.equal(data.roads[0].surface, 'sand');
  assert.equal(data.roads[0].width, 3.2);
  assert.equal(data.land.length, 1);
  assert.equal(data.land[0][0][0], data.land[0].at(-1)[0]);
  assert.ok(data.bounds.minX < data.bounds.maxX);
  assert.ok(data.bounds.minZ < data.bounds.maxZ);
});

test('mapped piers, breakwaters and groynes compile as georeferenced harbor structures', () => {
  const data = compileOverpass({
    elements: [
      {
        type: 'way', id: 301, tags: { man_made: 'pier', name: 'Muelle cartografiado' },
        geometry: [{ lon: -13.503, lat: 29.2315 }, { lon: -13.5025, lat: 29.2315 }]
      },
      {
        type: 'way', id: 302, tags: { man_made: 'breakwater', width: '8' },
        geometry: [{ lon: -13.503, lat: 29.2315 }, { lon: -13.502, lat: 29.2315 }]
      },
      {
        type: 'way', id: 303, tags: { man_made: 'groyne' },
        geometry: [{ lon: -13.503, lat: 29.2315 }, { lon: -13.502, lat: 29.2315 }]
      },
      {
        type: 'way', id: 304, tags: { man_made: 'windmill' },
        geometry: [{ lon: -13.503, lat: 29.2315 }, { lon: -13.502, lat: 29.2315 }]
      }
    ]
  });

  assert.deepEqual(data.harborStructures.map(({ id, type, width }) => ({ id, type, width })), [
    { id: 301, type: 'pier', width: 4 },
    { id: 302, type: 'breakwater', width: 8 },
    { id: 303, type: 'groyne', width: 3 }
  ]);
  assert.deepEqual(data.harborStructures[0].points[0], [0, 0]);
  assert.ok(data.bounds.maxX > 0);
});
