import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSatelliteImageUrl } from '../js/graciosa-satellite.js';

const bounds = { minX: -4448.4, maxX: 3016.5, minZ: -6610.8, maxZ: 4514.4 };
const frame = { latitude: 29.2315, longitude: -13.503 };
const read = (file) => readFileSync(join(import.meta.dirname, '..', file), 'utf8');

test('satellite export is georeferenced to the island bounds in Web Mercator', () => {
  const url = new URL(createSatelliteImageUrl(bounds, frame));
  assert.equal(url.origin, 'https://server.arcgisonline.com');
  assert.match(url.pathname, /World_Imagery\/MapServer\/export$/);
  assert.equal(url.searchParams.get('bboxSR'), '3857');
  assert.equal(url.searchParams.get('imageSR'), '3857');
  assert.equal(url.searchParams.get('format'), 'jpg');
  assert.equal(url.searchParams.get('f'), 'image');
  assert.equal(url.searchParams.get('bbox').split(',').length, 4);
});

test('satellite export preserves aspect ratio at a responsive image size', () => {
  const url = new URL(createSatelliteImageUrl(bounds, frame));
  const [width, height] = url.searchParams.get('size').split(',').map(Number);
  const [minX, minY, maxX, maxY] = url.searchParams.get('bbox').split(',').map(Number);
  assert.ok(Math.max(width, height) <= 3072);
  assert.ok(Math.abs(width / height - (maxX - minX) / (maxY - minY)) < 0.001);
  assert.ok(new URL(createSatelliteImageUrl(bounds, frame, 4096)).searchParams.get('size').split(',').map(Number).includes(4096));
});

test('satellite bounds and service image dimensions are validated', () => {
  assert.throws(() => createSatelliteImageUrl({ ...bounds, maxX: bounds.minX }, frame), TypeError);
  assert.throws(() => createSatelliteImageUrl(bounds, frame, 4097), RangeError);
});

test('terrain UVs use island coordinates and satellite imagery has attribution and fallback', () => {
  const main = read('js/graciosa-main.js');
  const html = read('index.html');
  const css = read('css/style.css');
  const readme = read('README.md');
  assert.match(main, /geometry\.setAttribute\('uv', new THREE\.BufferAttribute\(uv, 2\)\)/);
  assert.match(main, /landMesh\.material\.colorNode = mix\([\s\S]*?texture\(satelliteTexture, uv\(\)\)\.rgb/);
  assert.match(main, /keeping procedural terrain/);
  assert.match(html, /id="imagery-attribution" hidden/);
  assert.match(css, /#imagery-attribution/);
  assert.match(readme, /Esri World Imagery/);
});
