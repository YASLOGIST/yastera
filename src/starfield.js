import * as THREE from 'three';

import starVert from './shaders/starfield.vert?raw';
import starFrag from './shaders/starfield.frag?raw';

/**
 * Sparse, dim background starfield on a distant sphere. Uses a seeded PRNG so
 * the sky is identical on every load.
 * @param {number} pixelRatio
 * @param {number} [count]
 */
export function createStarfield(pixelRatio, count = 4200) {
  let seed = 0x9e3779b9;
  const rand = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const brightness = new Float32Array(count);
  const phases = new Float32Array(count);
  const radius = 420;

  for (let i = 0; i < count; i += 1) {
    // Uniform direction on the sphere.
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    positions[i * 3] = radius * r * Math.cos(a);
    positions[i * 3 + 1] = radius * z;
    positions[i * 3 + 2] = radius * r * Math.sin(a);
    // Power-law magnitude distribution: many faint, few brighter stars.
    const m = Math.pow(rand(), 5.0);
    sizes[i] = 1.0 + m * 2.2;
    brightness[i] = 0.08 + m * 0.5;
    phases[i] = rand() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    name: 'Starfield',
    glslVersion: THREE.GLSL3,
    vertexShader: starVert,
    fragmentShader: starFrag,
    uniforms: {
      uOpacity: { value: 0.55 },
      uPixelRatio: { value: pixelRatio },
      uTime: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const stars = new THREE.Points(geometry, material);
  stars.name = 'starfield';
  stars.renderOrder = -1;
  stars.frustumCulled = false;
  return stars;
}
