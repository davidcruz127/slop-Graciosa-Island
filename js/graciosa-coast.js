export const COAST_LAYERS = Object.freeze([
  Object.freeze({ offset: -16, color: 0xc3aa7a }),
  Object.freeze({ offset: -8, color: 0xcbb88c }),
  Object.freeze({ offset: -3, color: 0xd5c49b }),
  Object.freeze({ offset: -1, color: 0xd1c7a8 }),
  Object.freeze({ offset: 0, color: 0xc9c5a6 }),
  Object.freeze({ offset: 1.5, color: 0xb3cbbd }),
  Object.freeze({ offset: 3.5, color: 0x92bfb3 }),
  Object.freeze({ offset: 6, color: 0x70b0aa }),
  Object.freeze({ offset: 9, color: 0x559fa0 }),
  Object.freeze({ offset: 13, color: 0x3c8d95 }),
  Object.freeze({ offset: 17, color: 0x287a86 }),
  Object.freeze({ offset: 20, color: 0x176c7c })
]);

const FOAM_OFFSETS = Object.freeze([1.2, 5.8]);
const MAX_COAST_SEGMENT = 14;
const MIN_POINT_DISTANCE = 0.05;

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearColor(hex) {
  return [
    linearChannel((hex >> 16) & 0xff),
    linearChannel((hex >> 8) & 0xff),
    linearChannel(hex & 0xff)
  ];
}

function cleanRing(sourceRing) {
  const points = [];
  for (const point of sourceRing) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const previous = points.at(-1);
    if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= MIN_POINT_DISTANCE) {
      points.push([point[0], point[1]]);
    }
  }
  if (points.length > 1 && Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]) < MIN_POINT_DISTANCE) {
    points.pop();
  }
  return points.length >= 3 ? points : [];
}

export function prepareCoastRing(sourceRing) {
  let points = cleanRing(sourceRing);
  if (points.length < 3) return [];

  for (let pass = 0; pass < 2; pass++) {
    points = points.map((point, index) => {
      const previous = points[(index - 1 + points.length) % points.length];
      const next = points[(index + 1) % points.length];
      return [
        point[0] * 0.76 + (previous[0] + next[0]) * 0.12,
        point[1] * 0.76 + (previous[1] + next[1]) * 0.12
      ];
    });
  }

  const sampled = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const segments = Math.max(1, Math.ceil(length / MAX_COAST_SEGMENT));
    for (let segment = 0; segment < segments; segment++) {
      const amount = segment / segments;
      sampled.push([
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount
      ]);
    }
  }
  return sampled;
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area * 0.5;
}

function outwardMiter(ring, index, orientation) {
  const previous = ring[(index - 1 + ring.length) % ring.length];
  const current = ring[index];
  const next = ring[(index + 1) % ring.length];
  const edgeNormal = (start, end) => {
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const length = Math.hypot(dx, dz) || 1;
    return orientation > 0 ? [dz / length, -dx / length] : [-dz / length, dx / length];
  };
  const before = edgeNormal(previous, current);
  const after = edgeNormal(current, next);
  let nx = before[0] + after[0];
  let nz = before[1] + after[1];
  const length = Math.hypot(nx, nz);
  if (length < 1e-5) return after;
  nx /= length;
  nz /= length;
  const projection = nx * after[0] + nz * after[1];
  const scale = Math.min(1.6, 1 / Math.max(0.625, projection));
  return [nx * scale, nz * scale];
}

function appendLayer(positions, colors, waveMix, ring, heights, offset, colorHex, offsetScale, orientation, indices) {
  const baseIndex = positions.length / 3;
  const color = linearColor(colorHex);
  const lastOffset = COAST_LAYERS.at(-1).offset;
  for (let index = 0; index < ring.length; index++) {
    const [x, z] = ring[index];
    const [nx, nz] = outwardMiter(ring, index, orientation);
    const actualOffset = offset * offsetScale;
    const seaBlend = Math.max(0, Math.min(1, actualOffset / lastOffset));
    const y = actualOffset < 0
      ? heights[index] + 0.14
      : heights[index] * (1 - seaBlend) + 0.06;
    positions.push(x + nx * actualOffset, y, z + nz * actualOffset);
    colors.push(...color);
    waveMix.push(seaBlend);
  }
  if (indices) {
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length;
      const a = baseIndex - ring.length + index;
      const b = baseIndex - ring.length + next;
      const c = baseIndex + index;
      const d = baseIndex + next;
      indices.push(a, b, c, b, d, c);
    }
  }
}

export function createCoastGeometry(land, sampleElevation) {
  if (!Array.isArray(land) || typeof sampleElevation !== 'function') {
    throw new TypeError('Coast geometry requires land rings and an elevation sampler.');
  }

  const shorePositions = [];
  const shoreColors = [];
  const shoreWaveMix = [];
  const shoreIndices = [];
  const foamPositions = [];
  const foamIndices = [];

  for (const sourceRing of land) {
    const ring = prepareCoastRing(sourceRing);
    if (ring.length < 3) continue;

    const signedArea = ringArea(ring);
    const area = Math.abs(signedArea);
    const orientation = signedArea >= 0 ? 1 : -1;
    const offsetScale = Math.min(1, Math.max(0.06, Math.sqrt(area) / 250));
    const heights = ring.map((point) => sampleElevation(...point));
    for (let layerIndex = 0; layerIndex < COAST_LAYERS.length; layerIndex++) {
      const layer = COAST_LAYERS[layerIndex];
      appendLayer(
        shorePositions,
        shoreColors,
        shoreWaveMix,
        ring,
        heights,
        layer.offset,
        layer.color,
        offsetScale,
        orientation,
        layerIndex === 0 ? null : shoreIndices
      );
    }

    const foamBase = foamPositions.length / 3;
    for (const offset of FOAM_OFFSETS) {
      for (let index = 0; index < ring.length; index++) {
        const [x, z] = ring[index];
        const [nx, nz] = outwardMiter(ring, index, orientation);
        foamPositions.push(x + nx * offset * offsetScale, 0.12, z + nz * offset * offsetScale);
      }
    }
    for (let index = 0; index < ring.length; index++) {
      const next = (index + 1) % ring.length;
      const a = foamBase + index;
      const b = foamBase + next;
      const c = foamBase + ring.length + index;
      const d = foamBase + ring.length + next;
      foamIndices.push(a, b, c, b, d, c);
    }
  }

  return {
    shorePositions: new Float32Array(shorePositions),
    shoreColors: new Float32Array(shoreColors),
    shoreWaveMix: new Float32Array(shoreWaveMix),
    shoreIndices: new Uint32Array(shoreIndices),
    foamPositions: new Float32Array(foamPositions),
    foamIndices: new Uint32Array(foamIndices)
  };
}
