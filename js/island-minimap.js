function mapPoint(x, z, frame) {
  return {
    x: frame.left + (x - frame.minX) * frame.scale,
    y: frame.top + (z - frame.minZ) * frame.scale
  };
}

function traceLine(context, points, frame) {
  if (points.length < 2) return;
  const start = mapPoint(points[0][0], points[0][1], frame);
  context.moveTo(start.x, start.y);
  for (let i = 1; i < points.length; i++) {
    const point = mapPoint(points[i][0], points[i][1], frame);
    context.lineTo(point.x, point.y);
  }
}

function containsPoint(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function createIslandMinimap(canvas, geodata, onTeleport, pois = [], onWaypoint) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('El navegador no pudo crear el contexto del minimapa.');
  const baseCanvas = document.createElement('canvas');
  const baseContext = baseCanvas.getContext('2d');
  if (!baseContext) throw new Error('El navegador no pudo crear la capa base del minimapa.');

  const landRings = geodata.land.filter((ring) => ring.length >= 3);
  const featurePoints = landRings.flat();
  if (!featurePoints.length) throw new Error('No hay líneas de costa cerradas para dibujar el minimapa.');
  const bounds = {
    minX: Math.min(...featurePoints.map(([x]) => x)),
    maxX: Math.max(...featurePoints.map(([x]) => x)),
    minZ: Math.min(...featurePoints.map(([, z]) => z)),
    maxZ: Math.max(...featurePoints.map(([, z]) => z))
  };
  const islandBounds = landRings.map((ring) => ({
    ring,
    minX: Math.min(...ring.map(([x]) => x)),
    maxX: Math.max(...ring.map(([x]) => x)),
    minZ: Math.min(...ring.map(([, z]) => z)),
    maxZ: Math.max(...ring.map(([, z]) => z))
  }));
  const onIsland = (x, z) => islandBounds.some((island) =>
    x >= island.minX && x <= island.maxX && z >= island.minZ && z <= island.maxZ
      && containsPoint(island.ring, x, z));

  let frame;
  let pixelRatio = 1;
  let width = 0;
  let height = 0;
  let marker = { x: 0, z: 0, yaw: 0 };
  let center = { x: 0, z: 0 };
  let zoom = 1.55;
  let dragStart = null;
  let dragged = false;

  function setFrame() {
    const padding = 12;
    const worldWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const worldDepth = Math.max(bounds.maxZ - bounds.minZ, 1);
    const fitScale = Math.min((width - padding * 2) / worldWidth, (height - padding * 2) / worldDepth);
    frame = {
      minX: center.x - width / (2 * fitScale * 1.55),
      minZ: center.z - height / (2 * fitScale * 1.55),
      scale: fitScale * zoom,
      left: 0,
      top: 0
    };
  }

  function drawBase() {
    baseContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    baseContext.clearRect(0, 0, width, height);
    baseContext.fillStyle = '#123c45';
    baseContext.fillRect(0, 0, width, height);

    baseContext.save();
    baseContext.beginPath();
    baseContext.rect(0, 0, width, height);
    baseContext.clip();

    baseContext.fillStyle = '#b7a67d';
    for (const ring of geodata.land) {
      if (ring.length < 3) continue;
      baseContext.beginPath();
      traceLine(baseContext, ring, frame);
      baseContext.closePath();
      baseContext.fill();
    }

    baseContext.lineCap = 'round';
    baseContext.lineJoin = 'round';
    for (const road of geodata.roads) {
      if (road.points.length < 2) continue;
      baseContext.beginPath();
      let segmentCount = 0;
      for (let i = 1; i < road.points.length; i++) {
        const from = road.points[i - 1];
        const to = road.points[i];
        if (!onIsland((from[0] + to[0]) * 0.5, (from[1] + to[1]) * 0.5)) continue;
        const start = mapPoint(from[0], from[1], frame);
        const end = mapPoint(to[0], to[1], frame);
        baseContext.moveTo(start.x, start.y);
        baseContext.lineTo(end.x, end.y);
        segmentCount++;
      }
      if (!segmentCount) continue;
      baseContext.strokeStyle = road.type === 'track' ? '#ead3a0'
        : road.type === 'path' || road.type === 'footway' ? '#d0b886' : '#9a8b6e';
      baseContext.lineWidth = road.type === 'track' ? 1.3 : road.type === 'path' || road.type === 'footway' ? 0.8 : 1;
      baseContext.stroke();
    }

    baseContext.beginPath();
    for (const ring of geodata.land) {
      if (ring.length < 3) continue;
      traceLine(baseContext, ring, frame);
      baseContext.closePath();
    }
    baseContext.strokeStyle = '#e6d9bb';
    baseContext.lineWidth = 1.3;
    baseContext.stroke();
    for (const poi of pois) {
      const point = mapPoint(poi.x, poi.z, frame);
      if (point.x < -40 || point.x > width + 40 || point.y < -15 || point.y > height + 15) continue;
      baseContext.fillStyle = '#17383d';
      baseContext.beginPath();
      baseContext.arc(point.x, point.y, 4, 0, Math.PI * 2);
      baseContext.fill();
      baseContext.strokeStyle = '#fff4df';
      baseContext.lineWidth = 1.5;
      baseContext.stroke();
      baseContext.font = '600 10px Inter, sans-serif';
      baseContext.textAlign = point.x > width * 0.68 ? 'right' : 'left';
      baseContext.textBaseline = 'middle';
      baseContext.lineWidth = 3;
      baseContext.strokeStyle = 'rgba(17, 43, 48, 0.88)';
      const labelX = point.x + (baseContext.textAlign === 'right' ? -7 : 7);
      baseContext.strokeText(poi.name, labelX, point.y - 7);
      baseContext.fillStyle = '#fff4df';
      baseContext.fillText(poi.name, labelX, point.y - 7);
    }
    baseContext.restore();

    const north = { x: 20, y: 20 };
    baseContext.fillStyle = 'rgba(11, 29, 34, 0.78)';
    baseContext.beginPath();
    baseContext.arc(north.x, north.y, 9, 0, Math.PI * 2);
    baseContext.fill();
    baseContext.fillStyle = '#f6f1e7';
    baseContext.font = '700 10px Inter, sans-serif';
    baseContext.textAlign = 'center';
    baseContext.textBaseline = 'middle';
    baseContext.fillText('N', north.x, north.y + 0.5);
  }

  function drawMarker() {
    const point = mapPoint(marker.x, marker.z, frame);
    const directionX = Math.sin(marker.yaw);
    const directionY = -Math.cos(marker.yaw);
    const sideX = -directionY;
    const sideY = directionX;
    const tip = { x: point.x + directionX * 8, y: point.y + directionY * 8 };
    const left = { x: point.x - directionX * 5 + sideX * 4.5, y: point.y - directionY * 5 + sideY * 4.5 };
    const right = { x: point.x - directionX * 5 - sideX * 4.5, y: point.y - directionY * 5 - sideY * 4.5 };

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.drawImage(baseCanvas, 0, 0, baseCanvas.width, baseCanvas.height, 0, 0, width, height);
    context.beginPath();
    context.moveTo(tip.x, tip.y);
    context.lineTo(left.x, left.y);
    context.lineTo(right.x, right.y);
    context.closePath();
    context.fillStyle = '#ff795e';
    context.strokeStyle = '#fff8ec';
    context.lineWidth = 1.5;
    context.fill();
    context.stroke();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    baseCanvas.width = canvas.width;
    baseCanvas.height = canvas.height;
    center = { x: marker.x, z: marker.z };
    setFrame();
    drawBase();
    drawMarker();
  }

  function updatePlayer(x, z, yaw) {
    if (![x, z, yaw].every(Number.isFinite)) return;
    marker = { x, z, yaw };
    if (!frame) return;
    const recenterThreshold = Math.min(width, height) / frame.scale * 0.18;
    if (Math.hypot(x - center.x, z - center.z) > recenterThreshold) {
      center = { x, z };
      setFrame();
      drawBase();
    }
    drawMarker();
  }

  const zoomBy = (factor) => {
    if (!frame) return;
    zoom = Math.max(0.75, Math.min(5, zoom * factor));
    setFrame();
    drawBase();
    drawMarker();
  };
  const recenter = () => {
    center = { x: marker.x, z: marker.z };
    if (frame) {
      setFrame();
      drawBase();
      drawMarker();
    }
  };
  const controls = canvas.closest('#minimap-panel');
  controls?.querySelector('[data-map-zoom="in"]')?.addEventListener('click', () => zoomBy(1.35));
  controls?.querySelector('[data-map-zoom="out"]')?.addEventListener('click', () => zoomBy(1 / 1.35));
  controls?.querySelector('[data-map-center]')?.addEventListener('click', recenter);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragStart = { x: event.clientX, y: event.clientY, center: { ...center } };
    dragged = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragStart || !frame) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    if (Math.hypot(dx, dy) > 4) dragged = true;
    if (!dragged) return;
    center = { x: dragStart.center.x - dx / frame.scale, z: dragStart.center.z - dy / frame.scale };
    setFrame();
    drawBase();
    drawMarker();
  });
  const finishDrag = () => { dragStart = null; };
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  canvas.title = 'Pulsa sobre tierra para teletransportar al jugador';
  canvas.addEventListener('click', (event) => {
    if (dragged) {
      dragged = false;
      return;
    }
    if (!frame) return;
    const rect = canvas.getBoundingClientRect();
    const mapX = event.clientX - rect.left;
    const mapY = event.clientY - rect.top;
    const poi = pois.find((item) => {
      const point = mapPoint(item.x, item.z, frame);
      return Math.hypot(point.x - mapX, point.y - mapY) <= 12;
    });
    if (poi) {
      if (event.shiftKey) onWaypoint?.(poi.x, poi.z, poi);
      else onTeleport?.(poi.x, poi.z);
      return;
    }
    const x = frame.minX + mapX / frame.scale;
    const z = frame.minZ + mapY / frame.scale;
    if (!onIsland(x, z)) return;
    if (event.shiftKey) onWaypoint?.(x, z, null);
    else onTeleport?.(x, z);
  });
  canvas.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') zoomBy(1.35);
    else if (event.key === '-') zoomBy(1 / 1.35);
    else if (event.key === '0') recenter();
    else return;
    event.preventDefault();
  });

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  return {
    updatePlayer,
    recenter,
    zoomBy,
    dispose() {
      observer.disconnect();
    }
  };
}
