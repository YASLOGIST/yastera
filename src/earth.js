import * as THREE from 'three';

import { SHADERS } from './shaderSources.js';

// Sources are composed in `shaderManifest.js` so the offline checker validates
// byte-for-byte what this module compiles.
const surfaceVert = SHADERS.earthSurfaceVertex;
const surfaceFrag = SHADERS.earthSurface;
const cloudVert = SHADERS.cloudShellVertex;
const cloudsFrag = SHADERS.cloudShell;
const shellVert = SHADERS.shellVertex;
const haloFrag = SHADERS.atmosphereHalo;

export const EARTH_RADIUS = 1.0;
export const CLOUD_RADIUS = 1.0022;        // ~14 km: main tropospheric deck
export const CLOUD_HIGH_RADIUS = 1.0041;   // ~26 km: thin upper deck / cirrus
export const ATMOSPHERE_RADIUS = 1.028;    // ~178 km: scattering shell
export const AXIAL_TILT_DEG = 23.44;

/**
 * @typedef {object} EarthTextures
 * @property {THREE.Texture} day
 * @property {THREE.Texture} night
 * @property {THREE.Texture} specular
 * @property {THREE.Texture} topology
 * @property {THREE.Texture} clouds
 */

/**
 * Builds the four-layer Earth: PBR ocean/land surface, two cloud decks and the
 * scattering atmosphere shell.
 *
 * Hierarchy:
 *   group (axial tilt about Z)
 *   └─ spin (rotation about the tilted polar axis)
 *      ├─ surface    r = 1.000
 *      ├─ clouds     r = 1.0022  (UV-advected, differential zonal winds)
 *      ├─ cirrus     r = 1.0041
 *      └─ beacons    attached by the caller
 *   └─ halo         r = 1.028  (BackSide additive ray marched)
 *
 * @param {EarthTextures} textures
 */
export function createEarth(textures) {
  // Uniform objects shared by reference across materials. `uTime`,
  // `uCloudTime` and `uCloudDrift` MUST stay shared: the surface reads the
  // same advected cloud coordinate to project its shadows.
  const shared = {
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uSunIntensity: { value: 1.0 },
    uAtmosphereIntensity: { value: 1.0 },
    uCloudOpacity: { value: 1.0 },
    uCameraDistance: { value: 3.1 },
    uCloudTime: { value: 0 },
    uCloudDrift: { value: 0.055 },
    uTime: { value: 0 },
  };

  const group = new THREE.Group();
  group.name = 'earthGroup';
  group.rotation.z = THREE.MathUtils.degToRad(AXIAL_TILT_DEG);

  const spin = new THREE.Group();
  spin.name = 'earthSpin';
  group.add(spin);

  const topoImage = /** @type {{ width: number, height: number }} */ (textures.topology.image);

  // --- Surface ---------------------------------------------------------------
  const surfaceGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 320, 240);
  surfaceGeometry.computeTangents();

  const surfaceUniforms = {
    ...shared,
    uDayTexture: { value: textures.day },
    uNightTexture: { value: textures.night },
    uSpecularMap: { value: textures.specular },
    uTopologyMap: { value: textures.topology },
    uCloudsTexture: { value: textures.clouds },
    uTopologyTexel: { value: new THREE.Vector2(1 / topoImage.width, 1 / topoImage.height) },
    uBumpScale: { value: 1.0 },
    uCloudHeight: { value: CLOUD_RADIUS - EARTH_RADIUS },
    uSpecularIntensity: { value: 1.0 },
    uOceanRoughness: { value: 0.09 },
    uNightIntensity: { value: 1.0 },
    uWaveStrength: { value: 1.0 },
    uDetailStrength: { value: 1.0 },
  };

  const surfaceMaterial = new THREE.ShaderMaterial({
    name: 'EarthSurface',
    glslVersion: THREE.GLSL3,
    vertexShader: surfaceVert,
    fragmentShader: surfaceFrag,
    uniforms: surfaceUniforms,
  });
  const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
  surface.name = 'earthSurface';
  spin.add(surface);

  // --- Cloud decks -----------------------------------------------------------
  const makeCloudLayer = ({ radius, segments, scale, offset, alpha, driftScale, relief, order, mode = 0 }) => {
    const uniforms = {
      uSunDirection: shared.uSunDirection,
      uSunIntensity: shared.uSunIntensity,
      uAtmosphereIntensity: shared.uAtmosphereIntensity,
      uCloudOpacity: shared.uCloudOpacity,
      uCameraDistance: shared.uCameraDistance,
      uCloudTime: shared.uCloudTime,
      uCloudDrift: shared.uCloudDrift,
      uTime: shared.uTime,
      uCloudsTexture: { value: textures.clouds },
      uCloudScale: { value: new THREE.Vector2(scale[0], scale[1]) },
      uCloudOffset: { value: new THREE.Vector2(offset[0], offset[1]) },
      uLayerAlpha: { value: alpha },
      uLayerMode: { value: mode },
      uDriftScale: { value: driftScale },
      uCloudRelief: { value: relief },
    };

    const material = new THREE.ShaderMaterial({
      name: `EarthClouds_${order}`,
      glslVersion: THREE.GLSL3,
      vertexShader: cloudVert,
      fragmentShader: cloudsFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, segments), material);
    mesh.name = order === 1 ? 'earthClouds' : 'earthCirrus';
    mesh.renderOrder = order;
    return { mesh, material, uniforms };
  };

  const lowDeck = makeCloudLayer({
    radius: CLOUD_RADIUS,
    segments: 192,
    scale: [1, 1],
    offset: [0, 0],
    alpha: 1.0,
    driftScale: 1.0,
    relief: 1.0,
    order: 1,
  });
  spin.add(lowDeck.mesh);

  const highDeck = makeCloudLayer({
    radius: CLOUD_HIGH_RADIUS,
    segments: 160,
    scale: [1.73, 1.21],
    offset: [0.37, 0.11],
    alpha: 0.62,
    driftScale: 1.9,
    relief: 0.55,
    order: 2,
    mode: 1,
  });
  spin.add(highDeck.mesh);

  // --- Atmosphere halo -------------------------------------------------------
  const haloMaterial = new THREE.ShaderMaterial({
    name: 'AtmosphereHalo',
    glslVersion: THREE.GLSL3,
    vertexShader: shellVert,
    fragmentShader: haloFrag,
    uniforms: {
      uSunDirection: shared.uSunDirection,
      uSunIntensity: shared.uSunIntensity,
      uAtmosphereIntensity: shared.uAtmosphereIntensity,
      uCameraDistance: shared.uCameraDistance,
      uTime: shared.uTime,
      uPlanetRadius: { value: EARTH_RADIUS },
      uAtmosphereRadius: { value: ATMOSPHERE_RADIUS },
    },
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 96, 64), haloMaterial);
  halo.name = 'atmosphereHalo';
  halo.renderOrder = 3;
  group.add(halo);

  return {
    group,
    spin,
    surface,
    clouds: lowDeck.mesh,
    cirrus: highDeck.mesh,
    halo,
    uniforms: {
      shared,
      surface: surfaceUniforms,
      clouds: lowDeck.material.uniforms,
      cirrus: highDeck.material.uniforms,
      halo: haloMaterial.uniforms,
    },
    materials: { surface: surfaceMaterial, clouds: lowDeck.material, cirrus: highDeck.material, halo: haloMaterial },
  };
}
