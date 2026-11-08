const WORLD_RADIUS = 6378137;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const DEFAULT_IMAGE_SIZE = 3072;
const WORLD_IMAGERY_EXPORT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';

export function createSatelliteImageUrl(bounds, frame, maxImageSize = DEFAULT_IMAGE_SIZE) {
  const values = [bounds?.minX, bounds?.maxX, bounds?.minZ, bounds?.maxZ, frame?.latitude, frame?.longitude];
  if (!values.every(Number.isFinite)
    || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ
    || Math.abs(frame.latitude) >= MAX_MERCATOR_LATITUDE
    || Math.abs(frame.longitude) > 180) {
    throw new TypeError('Invalid geographic bounds for the La Graciosa satellite image.');
  }
  if (!Number.isInteger(maxImageSize) || maxImageSize < 256 || maxImageSize > 4096) {
    throw new RangeError('Satellite image size must be an integer between 256 and 4096 pixels.');
  }

  const latitudeOrigin = frame.latitude * Math.PI / 180;
  const longitudeOrigin = frame.longitude * Math.PI / 180;
  const project = (x, z) => {
    const latitude = latitudeOrigin - z / WORLD_RADIUS;
    const longitude = longitudeOrigin + x / (WORLD_RADIUS * Math.cos(latitudeOrigin));
    if (Math.abs(latitude * 180 / Math.PI) >= MAX_MERCATOR_LATITUDE) {
      throw new RangeError('Satellite image bounds exceed the Web Mercator latitude range.');
    }
    return {
      x: WORLD_RADIUS * longitude,
      y: WORLD_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude / 2))
    };
  };

  const southwest = project(bounds.minX, bounds.maxZ);
  const northeast = project(bounds.maxX, bounds.minZ);
  const bbox = [southwest.x, southwest.y, northeast.x, northeast.y];
  const aspect = (bbox[2] - bbox[0]) / (bbox[3] - bbox[1]);
  const width = aspect >= 1 ? maxImageSize : Math.max(1, Math.round(maxImageSize * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(maxImageSize / aspect)) : maxImageSize;
  const parameters = new URLSearchParams({
    bbox: bbox.join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${width},${height}`,
    format: 'jpg',
    f: 'image'
  });

  return `${WORLD_IMAGERY_EXPORT}?${parameters}`;
}

export function loadSatelliteTexture(THREE, bounds, frame) {
  if (!THREE?.TextureLoader || !THREE.SRGBColorSpace) {
    throw new TypeError('Three.js texture loading and sRGB color space are required.');
  }

  const url = createSatelliteImageUrl(bounds, frame);
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      resolve(texture);
    }, undefined, (error) => {
      reject(error instanceof Error ? error : new Error('The satellite imagery request failed.'));
    });
  });
}
