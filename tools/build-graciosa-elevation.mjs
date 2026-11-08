import { inflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO } from '../js/graciosa-geodata.js';
import { createTerrainSurface, decodeElevationGrid } from '../js/graciosa-terrain.js';
import { FRAME } from './graciosa-geo.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(ROOT, '..', 'js', 'graciosa-elevation.js');
const ZOOM = 12;
const STEP = 15;
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('Elevation tile is not a PNG image.');
  let width;
  let height;
  let bitDepth;
  let colorType;
  const compressed = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!width || !height || bitDepth !== 8 || !channels) {
    throw new Error(`Unsupported elevation PNG format (bit depth ${bitDepth}, color type ${colorType}).`);
  }
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(height * stride);
  const paeth = (left, above, upperLeft) => {
    const base = left + above - upperLeft;
    const dl = Math.abs(base - left);
    const da = Math.abs(base - above);
    const du = Math.abs(base - upperLeft);
    return dl <= da && dl <= du ? left : da <= du ? above : upperLeft;
  };
  for (let row = 0; row < height; row++) {
    const filter = packed[row * (stride + 1)];
    const packedOffset = row * (stride + 1) + 1;
    const rowOffset = row * stride;
    for (let col = 0; col < stride; col++) {
      const raw = packed[packedOffset + col];
      const left = col >= channels ? pixels[rowOffset + col - channels] : 0;
      const above = row > 0 ? pixels[rowOffset - stride + col] : 0;
      const upperLeft = row > 0 && col >= channels ? pixels[rowOffset - stride + col - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
      pixels[rowOffset + col] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

const n = 2 ** ZOOM;
const worldPixel = (x, z) => {
  const latitude = FRAME.latitude - z / (FRAME.radius * Math.PI / 180);
  const longitude = FRAME.longitude + x / (FRAME.radius * Math.PI / 180 * Math.cos(FRAME.latitude * Math.PI / 180));
  const pixelScale = n * 256;
  return [
    ((longitude + 180) / 360) * pixelScale,
    ((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2) * pixelScale
  ];
};
const points = GEO.land.flat();
if (!points.length) throw new Error('No coastline rings are available to build the elevation grid.');
const rawBounds = {
  minX: Math.min(...points.map(([x]) => x)),
  maxX: Math.max(...points.map(([x]) => x)),
  minZ: Math.min(...points.map(([, z]) => z)),
  maxZ: Math.max(...points.map(([, z]) => z))
};
const minX = Math.floor(rawBounds.minX / STEP) * STEP;
const maxX = Math.ceil(rawBounds.maxX / STEP) * STEP;
const minZ = Math.floor(rawBounds.minZ / STEP) * STEP;
const maxZ = Math.ceil(rawBounds.maxZ / STEP) * STEP;
const width = Math.round((maxX - minX) / STEP) + 1;
const height = Math.round((maxZ - minZ) / STEP) + 1;
const pixelsAtCorners = [
  worldPixel(minX, minZ), worldPixel(minX, maxZ),
  worldPixel(maxX, minZ), worldPixel(maxX, maxZ)
];
const minTileX = Math.floor(Math.min(...pixelsAtCorners.map(([x]) => x)) / 256);
const maxTileX = Math.floor((Math.max(...pixelsAtCorners.map(([x]) => x)) + 1) / 256);
const minTileY = Math.floor(Math.min(...pixelsAtCorners.map(([, y]) => y)) / 256);
const maxTileY = Math.floor((Math.max(...pixelsAtCorners.map(([, y]) => y)) + 1) / 256);
const tiles = new Map();
for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
  for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
    const url = `${TILE_URL}/${ZOOM}/${tileX}/${tileY}.png`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Elevation tile request failed (${response.status}): ${url}`);
    const tile = decodePng(Buffer.from(await response.arrayBuffer()));
    if (tile.width !== 256 || tile.height !== 256) throw new Error(`Unexpected tile dimensions from ${url}.`);
    tiles.set(`${tileX},${tileY}`, tile);
    console.log(`[graciosa] downloaded elevation tile ${tileX}/${tileY}`);
  }
}

const pixelElevation = (pixelX, pixelY) => {
  const tileX = Math.floor(pixelX / 256);
  const tileY = Math.floor(pixelY / 256);
  const tile = tiles.get(`${tileX},${tileY}`);
  if (!tile) throw new Error(`Missing elevation tile ${tileX}/${tileY}.`);
  const x = Math.max(0, Math.min(255, pixelX - tileX * 256));
  const y = Math.max(0, Math.min(255, pixelY - tileY * 256));
  const offset = (y * tile.width + x) * tile.channels;
  return tile.pixels[offset] * 256 + tile.pixels[offset + 1] + tile.pixels[offset + 2] / 256 - 32768;
};
const sampleTerrain = (x, z) => {
  const [pixelX, pixelY] = worldPixel(x, z);
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const tx = pixelX - x0;
  const ty = pixelY - y0;
  const top = pixelElevation(x0, y0) * (1 - tx) + pixelElevation(x0 + 1, y0) * tx;
  const bottom = pixelElevation(x0, y0 + 1) * (1 - tx) + pixelElevation(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
};

const encoded = Buffer.alloc(width * height * 2);
let minElevation = Infinity;
let maxElevation = -Infinity;
for (let row = 0; row < height; row++) {
  for (let col = 0; col < width; col++) {
    const elevation = Math.max(0, sampleTerrain(minX + col * STEP, minZ + row * STEP));
    if (!Number.isFinite(elevation) || elevation < -100 || elevation > 1000) {
      throw new Error(`Invalid elevation ${elevation} at grid coordinate ${col},${row}.`);
    }
    minElevation = Math.min(minElevation, elevation);
    maxElevation = Math.max(maxElevation, elevation);
    encoded.writeInt16LE(Math.round(elevation * 10), (row * width + col) * 2);
  }
}
const elevationGrid = {
  width, height, minX, minZ, step: STEP,
  source: 'AWS Terrain Tiles (Terrarium encoding; SRTM-derived DEM)',
  tileZoom: ZOOM,
  elevations: encoded.toString('base64')
};
const decodedGrid = decodeElevationGrid(elevationGrid);
const surface = createTerrainSurface(decodedGrid, GEO.land);
if (!surface.indices.length) throw new Error('The DEM grid does not overlap any closed island coastline.');
minElevation = Infinity;
maxElevation = -Infinity;
for (const index of surface.indices) {
  const elevation = surface.positions[index * 3 + 1];
  minElevation = Math.min(minElevation, elevation);
  maxElevation = Math.max(maxElevation, elevation);
}
elevationGrid.minElevation = Math.floor(minElevation * 10) / 10;
elevationGrid.maxElevation = Math.ceil(maxElevation * 10) / 10;
const output = `// Generated by tools/build-graciosa-elevation.mjs; do not edit.\n// Elevation data: AWS Terrain Tiles, derived from SRTM; see README.md for source details.\nexport const ELEVATION = ${JSON.stringify(elevationGrid)};\n`;
await fs.writeFile(OUTPUT, output);
console.log(`[graciosa] generated ${width} x ${height} elevation grid at ${STEP} m spacing`);
console.log(`[graciosa] sampled elevation range ${elevationGrid.minElevation} to ${elevationGrid.maxElevation} m`);
console.log(`[graciosa] wrote ${path.relative(path.join(ROOT, '..'), OUTPUT)} (${Buffer.byteLength(output)} bytes)`);
