import * as THREE from 'three';

import { latLngToVector3 } from './geo.js';
import { CITIES } from './cities.js';
import { SHADERS } from './shaderSources.js';

const beaconVert = SHADERS.beaconVertex;
const beaconFrag = SHADERS.beacon;

export const HUBS = CITIES;

/** Altitude just above the terrain, below the cloud deck. */
const BEACON_RADIUS = 1.0010;

/**
 * HDR emissive beacons on key global hubs, rendered as additive point
 * sprites after the cloud shell so they shine through it.
 * @param {number} pixelRatio
 * @param {object} [uSunDirection]
 */
export function createBeacons(pixelRatio, uSunDirection = null) {
  const positions = new Float32Array(HUBS.length * 3);
  const phases = new Float32Array(HUBS.length);
  const v = new THREE.Vector3();
  HUBS.forEach((hub, i) => {
    latLngToVector3(hub.lat, hub.lng, BEACON_RADIUS, v).toArray(positions, i * 3);
    phases[i] = (i * 2.399963) % (Math.PI * 2); // golden-angle phase spread
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    name: 'OrbitalBeacons',
    glslVersion: THREE.GLSL3,
    vertexShader: beaconVert,
    fragmentShader: beaconFrag,
    uniforms: {
      uColor: { value: new THREE.Color(4.5, 0.75, 0.18) },
      uIntensity: { value: 1.0 },
      uSize: { value: 8.5 },
      uPixelRatio: { value: pixelRatio },
      uTime: { value: 0 },
      uSunDirection: uSunDirection || { value: new THREE.Vector3(1, 0, 0) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'orbitalBeacons';
  points.renderOrder = 4;
  points.frustumCulled = false;
  return points;
}
