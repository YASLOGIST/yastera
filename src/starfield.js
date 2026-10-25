import * as THREE from 'three';

import { SHADERS } from './shaderSources.js';
import {
  GALACTIC_DENSITY_MAX,
  GALACTIC_NORTH,
  galacticCrowding,
  galacticDensity,
} from './galacticField.js';

// NOTE: the Milky Way fragment needs the procedural noise prelude from
// lib/noise.glsl (fbm4 / valueNoise). Composition lives in shaderManifest.js so
// that requirement cannot be forgotten here.
const starVert = SHADERS.starfieldVertex;
const starFrag = SHADERS.starfield;
const milkyWayVert = SHADERS.milkyWayVertex;
const milkyWayFrag = SHADERS.milkyWay;

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
  const count = options.count ?? 16000;
  const radius = options.radius ?? 420;
  const rand = mulberry32(0x9e3779b9);

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const magnitudes = new Float32Array(count);

  const dir = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    // Draw a direction, then accept it with probability proportional to the
    // galactic density field. Rejection sampling is the right tool here: it
    // reproduces the density exactly instead of approximating it with a
    // gaussian, and the cost is trivial at load time.
    //
    // The attempt cap matters. Without one, a star that lands in a very empty
    // patch of sky would loop forever. With one, that star is simply placed at
    // the last direction drawn, which biases a negligible number of stars
    // toward the background — the correct trade. 32 attempts puts the binding
    // probability at well under 1% for the contrast this field uses.
    let sinLat = 0;
    let density = 0;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      dir.set(r * Math.cos(a), z, r * Math.sin(a));
      sinLat = dir.dot(GALACTIC_NORTH);
      density = galacticDensity(dir, sinLat);
      // Normalised by the field's maximum: the density itself is >= 1, so an
      // un-normalised comparison would accept every draw and the clustering
      // would not happen at all.
      if (rand() * GALACTIC_DENSITY_MAX < density) break;
    }

    positions[i * 3] = dir.x * radius;
    positions[i * 3 + 1] = dir.y * radius;
    positions[i * 3 + 2] = dir.z * radius;

    // Magnitude: most stars are faint. pow() pushes the distribution hard.
    // Stars inside the star clouds are drawn slightly dimmer, because
    // crowding is what makes the band look like unresolved light rather than
    // a scatter of individual points.
    const m = Math.pow(rand(), 3.6) * (1 - 0.25 * galacticCrowding(density));
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

  // 96x64 rather than 48x32: vDir is interpolated per-vertex, so each quad of a
  // 48-segment sphere spans 7.5 degrees and puts a C0 kink in the galactic noise
  // coordinates at every triangle edge. 96x64 is 12k triangles of a background
  // mesh that is drawn once, which costs nothing measurable.
  const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.85, 96, 64), milkyWayMaterial);
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
