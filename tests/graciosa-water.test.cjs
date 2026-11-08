const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

test('the Atlantic ocean uses animated physical waves and directional sunlight reflections', () => {
  const main = read('js/graciosa-main.js');
  const ocean = main.slice(main.indexOf('function buildOcean(scene)'), main.indexOf('function buildCoast(scene'));
  assert.match(main, /import \{[^}]*modelViewMatrix[^}]*positionLocal[^}]*time[^}]*\} from 'three\/tsl'/);
  assert.match(ocean, /new THREE\.PlaneGeometry\(width, depth, Math\.ceil\(width \/ 60\), Math\.ceil\(depth \/ 60\)\)/);
  assert.match(main, /function oceanWaveNodes\(localPosition\)/);
  assert.match(ocean, /material\.positionNode = positionLocal\.add\(vec3\(0, waves\.height, 0\)\)/);
  assert.match(ocean, /material\.normalNode = normalize\(modelViewMatrix\.mul\(vec4\(waves\.slopeX\.negate\(\), float\(1\), waves\.slopeZ\.negate\(\), float\(0\)\)\)\.xyz\)/);
  assert.match(ocean, /new THREE\.DataTexture\(waveData, waveSize, waveSize, THREE\.RGBAFormat, THREE\.UnsignedByteType\)/);
  assert.match(ocean, /waveTexture\.wrapS = THREE\.RepeatWrapping/);
  assert.match(ocean, /waveTexture\.repeat\.set\(42, 42\)/);
  assert.match(ocean, /new THREE\.MeshPhysicalMaterial\(\{/);
  assert.match(ocean, /transparent: true,\s*opacity: 0\.94,\s*depthWrite: false/);
  assert.match(ocean, /bumpMap: waveTexture/);
  assert.match(ocean, /bumpScale: 4/);
  assert.match(ocean, /clearcoat: 0\.95/);
  assert.match(ocean, /const waveCrests = smoothstep/);
  assert.match(ocean, /color\(0x07576c\), color\(0x43b9b0\)/);
  assert.match(ocean, /specularIntensity: 1/);
  assert.match(main, /const sun = new THREE\.DirectionalLight\(0xffdcae, 2\.55\)/);
  assert.match(main, /foamMaterial\.opacityNode = float\(0\.24\)\.add\(foamStrength\.mul\(0\.62\)\)/);
  assert.match(main, /boats\.forEach\(\(\{ boat, phase, x, z, yaw \}\)/);
  assert.match(main, /boat\.position\.set\(/);
  assert.match(main, /boat\.rotation\.set\(/);
  assert.match(main, /waveTexture\.offset\.x = \(waveTexture\.offset\.x \+ dt \* 0\.00045\) % 1/);
  assert.match(main, /waveTexture\.offset\.y = \(waveTexture\.offset\.y - dt \* 0\.0008 \+ 1\) % 1/);
});

test('ocean waves remain part of the WebGPU scene and documented sea visuals', () => {
  const main = read('js/graciosa-main.js');
  const readme = read('README.md');
  assert.match(main, /const ocean = buildOcean\(scene\)/);
  assert.match(main, /renderer\.render\(scene, camera\)/);
  assert.doesNotMatch(main, /from ['"]three\/addons\/objects\/Water\.js['"]/);
  assert.match(readme, /normales animadas/);
  assert.match(readme, /compatible con WebGPU/);
});
