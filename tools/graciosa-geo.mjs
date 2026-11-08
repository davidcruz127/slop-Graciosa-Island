export const FRAME = Object.freeze({
  latitude: 29.2315,
  longitude: -13.5030,
  radius: 6378137,
  bounds: Object.freeze({ south: 29.215, west: -13.565, north: 29.285, east: -13.480 })
});

const DEG = Math.PI / 180;
const X_SCALE = FRAME.radius * DEG * Math.cos(FRAME.latitude * DEG);
const Z_SCALE = FRAME.radius * DEG;

export function project(longitude, latitude) {
  const x = Math.round((longitude - FRAME.longitude) * X_SCALE * 10) / 10;
  const z = Math.round(-(latitude - FRAME.latitude) * Z_SCALE * 10) / 10;
  return [x || 0, z || 0];
}

function isValidRing(points) {
  return points.length >= 4
    && points[0][0] === points.at(-1)[0]
    && points[0][1] === points.at(-1)[1];
}

function joinRelationRings(members) {
  const remaining = members
    .filter((member) => member.type === 'way' && Array.isArray(member.geometry) && member.geometry.length > 1)
    .map((member) => ({ role: member.role || 'outer', points: member.geometry.map(({ lon, lat }) => project(lon, lat)) }));
  const rings = [];

  while (remaining.length) {
    const first = remaining.shift();
    const points = first.points.slice();
    for (let guard = 0; guard < 1000 && !isValidRing(points); guard++) {
      const end = points.at(-1);
      const index = remaining.findIndex(({ points: line, role }) =>
        role === first.role && (line[0][0] === end[0] && line[0][1] === end[1]
          || line.at(-1)[0] === end[0] && line.at(-1)[1] === end[1]));
      if (index < 0) break;
      const next = remaining.splice(index, 1)[0].points;
      if (next.at(-1)[0] === end[0] && next.at(-1)[1] === end[1]) next.reverse();
      points.push(...next.slice(1));
    }
    if (isValidRing(points)) rings.push({ role: first.role, points: points.slice(0, -1) });
  }
  return rings;
}

function boundsOf(points) {
  return {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minZ: Math.min(...points.map(([, z]) => z)),
    maxZ: Math.max(...points.map(([, z]) => z))
  };
}

function polygonsFor(element) {
  const rings = element.type === 'way'
    ? [{ role: 'outer', points: (element.geometry || []).map(({ lon, lat }) => project(lon, lat)) }]
    : joinRelationRings(element.members || []);
  const outer = rings.filter((ring) => ring.role !== 'inner' && ring.points.length >= 3);
  const inner = rings.filter((ring) => ring.role === 'inner' && ring.points.length >= 3);
  return outer.map((ring) => ({
    outer: ring.points,
    holes: inner
      .filter((hole) => pointInRing(hole.points[0], ring.points))
      .map((hole) => hole.points)
  }));
}

function pointInRing([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function numericHeight(tags) {
  const height = Number.parseFloat(String(tags.height || '').replace(',', '.'));
  if (Number.isFinite(height) && height > 0) return Math.max(2, Math.min(height, 40));
  const levels = Number.parseFloat(tags['building:levels'] || '');
  if (Number.isFinite(levels) && levels > 0) return Math.max(2, Math.min(levels * 3, 40));
  return null;
}

function roadWidth(tags) {
  const explicit = Number.parseFloat(String(tags.width || '').replace(',', '.'));
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1.5, Math.min(explicit, 12));
  const lanes = Number.parseFloat(tags.lanes || '');
  if (Number.isFinite(lanes) && lanes > 0) return Math.max(2, Math.min(lanes * 2.7, 9));
  if (tags.highway === 'track') return 3.2;
  if (tags.highway === 'path' || tags.highway === 'footway' || tags.highway === 'cycleway') return 1.8;
  if (tags.highway === 'residential' || tags.highway === 'unclassified' || tags.highway === 'tertiary') return 4.2;
  return 3;
}

function harborWidth(tags) {
  const explicit = Number.parseFloat(String(tags.width || '').replace(',', '.'));
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1.5, Math.min(explicit, 20));
  if (tags.man_made === 'pier') return 4;
  if (tags.man_made === 'breakwater') return 6;
  return 3;
}

function chainCoastline(elements) {
  const lines = elements
    .filter((element) => element.type === 'way' && element.tags?.natural === 'coastline' && element.geometry?.length > 1)
    .map((element) => ({
      id: element.id,
      start: element.nodes?.[0] ?? `${element.geometry[0].lon},${element.geometry[0].lat}`,
      end: element.nodes?.at(-1) ?? `${element.geometry.at(-1).lon},${element.geometry.at(-1).lat}`,
      points: element.geometry.map(({ lon, lat }) => project(lon, lat))
    }));
  const byStart = new Map();
  const byEnd = new Map();
  for (const line of lines) {
    if (!byStart.has(line.start)) byStart.set(line.start, []);
    if (!byEnd.has(line.end)) byEnd.set(line.end, []);
    byStart.get(line.start).push(line);
    byEnd.get(line.end).push(line);
  }
  const used = new Set();
  const chains = [];

  for (const line of lines) {
    if (used.has(line.id)) continue;
    const chain = line.points.slice();
    used.add(line.id);
    let end = line.end;
    for (let guard = 0; end !== line.start && guard < lines.length; guard++) {
      const next = (byStart.get(end) || []).find((candidate) => !used.has(candidate.id));
      const reverse = !next;
      const candidate = next || (byEnd.get(end) || []).find((item) => !used.has(item.id));
      if (!candidate) break;
      const points = reverse ? candidate.points.slice().reverse() : candidate.points;
      chain.push(...points.slice(1));
      end = reverse ? candidate.start : candidate.end;
      used.add(candidate.id);
    }
    if (chain.length > 2) chains.push(chain);
  }
  return chains;
}

export function compileOverpass(data) {
  if (!Array.isArray(data?.elements)) throw new TypeError('Overpass response must contain an elements array.');
  const buildings = [];
  const roads = [];
  const harborStructures = [];
  const coastElements = [];

  for (const element of data.elements) {
    const tags = element.tags || {};
    if (element.type === 'way' && tags.natural === 'coastline') coastElements.push(element);
    if ((element.type === 'way' || element.type === 'relation') && tags.building) {
      const polygons = polygonsFor(element).filter(({ outer }) => outer.length >= 3);
      if (polygons.length) buildings.push({
        id: element.id,
        polygons,
        height: numericHeight(tags),
        name: tags.name || ''
      });
    } else if (element.type === 'way' && tags.highway && element.geometry?.length > 1) {
      roads.push({
        id: element.id,
        type: tags.highway,
        name: tags.name || '',
        width: roadWidth(tags),
        surface: tags.surface || '',
        points: element.geometry.map(({ lon, lat }) => project(lon, lat))
      });
    }
    if (element.type === 'way'
      && ['pier', 'breakwater', 'groyne'].includes(tags.man_made)
      && element.geometry?.length > 1) {
      harborStructures.push({
        id: element.id,
        type: tags.man_made,
        name: tags.name || '',
        width: harborWidth(tags),
        points: element.geometry.map(({ lon, lat }) => project(lon, lat))
      });
    }
  }

  const coast = chainCoastline(coastElements);
  const allPoints = [
    ...buildings.flatMap((building) => building.polygons.flatMap(({ outer, holes }) => [...outer, ...holes.flat()])),
    ...roads.flatMap((road) => road.points),
    ...harborStructures.flatMap((structure) => structure.points),
    ...coast.flat()
  ];
  const bounds = allPoints.length
    ? boundsOf(allPoints)
    : { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 };

  return {
    version: 1,
    frame: { origin: 'Caleta de Sebo', latitude: FRAME.latitude, longitude: FRAME.longitude, units: 'm', axes: 'x east, z south' },
    bounds,
    land: coast.filter((chain) => chain.length > 3 && chain[0][0] === chain.at(-1)[0] && chain[0][1] === chain.at(-1)[1]),
    coast,
    buildings,
    roads,
    harborStructures
  };
}
