import * as THREE from 'three';

import starVert from './shaders/starfield.vert?raw';
import starFrag from './shaders/starfield.frag?raw';
import milkyWayVert from './shaders/milkyway.vert?raw';
import milkyWayFrag from './shaders/milkyway.frag?raw';

/**
 * Realistic stellar colour ladder (linear RGB), sampled by spectral class.
 * Blue-white O/B stars are rare and hot; M dwarfs are numerous and red.
 */
const SPECTRAL = [
  { weight: 0.02, color: [0.62, 0.72, 1.0] },  // O/B
  { weight: 0.08, color: [0.80, 0.86, 1.0] },  // A
  { weight: 0.16, color: [0.96, 0.96, 1.0] },  // F
  { weight: 0.24, color: [1.0, 0.96, 0.87] },  // G (Sun-like)
  { weight: 0.28, color: [1.0, 0.86, 0.66] },  // K
  { weight: 0.22, color: [1.0, 0.72, 0.55] },  // M
];

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickColor(rand) {
  const r = rand();
  let acc = 0;
  for (const entry of SPECTRAL) {
    acc += entry.weight;
    if (r <= acc) return entry.color;
  }
  return SPECTRAL[SPECTRAL.length - 1].color;
}

/**
 * Procedural deep-sky backdrop: Milky Way band plus ~9k stars with realistic
 * magnitude and colour distributions, concentrated toward the galactic plane.
 *
 * @param {number} pixelRatio
 * @param {{ count?: number, radius?: number }} [options]
 */
export function createStarfield(pixelRatio, options = {}) {
  const count = options.count ?? 9000;
  const radius = options.radius ?? 420;
  const rand = mulberry32(0x9e3779b9);

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const magnitudes = new Float32Array(count);

  // Galactic north pole matches the Milky Way shader.
  const galacticNorth = new THREE.Vector3(0.36, 0.84, -0.41).normalize();

  const dir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    // Uniform sphere, then rejection-sample toward the galactic plane so the
    // star density follows the real Milky Way.
    let accepted = false;
    for (let attempt = 0; attempt < 8 && !accepted; attempt += 1) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      dir.set(r * Math.cos(a), z, r * Math.sin(a));
      const sinLat = dir.dot(galacticNorth);
      const weight = 0.35 + 0.65 * Math.exp(-Math.pow(sinLat / 0.30, 2));
      accepted = rand() < weight;
      if (!accepted) continue;

      positions[i * 3] = dir.x * radius;
      positions[i * 3 + 1] = dir.y * radius;
      positions[i * 3 + 2] = dir.z * radius;
    }
    if (!accepted) {
      tmp.copy(dir);
      positions[i * 3] = tmp.x * radius;
      positions[i * 3 + 1] = tmp.y * radius;
      positions[i * 3 + 2] = tmp.z * radius;
    }

    // Magnitude: most stars are faint. pow() pushes the distribution hard.
    const m = Math.pow(rand(), 3.6);
    magnitudes[i] = m;
    sizes[i] = 1.15 + m * 2.6;
    const color = pickColor(rand);
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aMagnitude', new THREE.BufferAttribute(magnitudes, 1));

  const starMaterial = new THREE.ShaderMaterial({
    name: 'Starfield',
    glslVersion: THREE.GLSL3,
    vertexShader: starVert,
    fragmentShader: starFrag,
    uniforms: {
      uOpacity: { value: 1.0 },
      uPixelRatio: { value: pixelRatio },
      uSizeScale: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    // Depth *testing* stays on so the planet occludes the sky behind it; the
    // stars never write depth, so they can never occlude each other either.
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  const stars = new THREE.Points(geometry, starMaterial);
  stars.name = 'starfield';
  stars.renderOrder = -1;
  stars.frustumCulled = false;

  const milkyWayMaterial = new THREE.ShaderMaterial({
    name: 'MilkyWay',
    glslVersion: THREE.GLSL3,
    vertexShader: milkyWayVert,
    fragmentShader: milkyWayFrag,
    uniforms: {
      uIntensity: { value: 1.0 },
      uTime: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });

  const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.85, 48, 32), milkyWayMaterial);
  milkyWay.name = 'milkyWay';
  milkyWay.renderOrder = -2;
  milkyWay.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'deepSpace';
  group.add(milkyWay, stars);

  return {
    group,
    stars,
    milkyWay,
    starMaterial,
    milkyWayMaterial,
    setPixelRatio(pr) {
      starMaterial.uniforms.uPixelRatio.value = pr;
    },
  };
}
