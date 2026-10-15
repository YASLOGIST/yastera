import * as THREE from 'three';

import surfaceVert from './shaders/earthSurface.vert?raw';
import surfaceFrag from './shaders/earthSurface.frag?raw';
import shellVert from './shaders/shell.vert?raw';
import cloudsFrag from './shaders/earthClouds.frag?raw';
import haloFrag from './shaders/atmosphereHalo.frag?raw';

export const EARTH_RADIUS = 1.0;
export const CLOUD_RADIUS = 1.0022;       // ~14 km: tropospheric cloud deck
export const ATMOSPHERE_RADIUS = 1.016;    // ~102 km: Kármán line atmospheric limb
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
 * Builds the three-sphere Earth: PBR surface, cloud shell and limb halo.
 *
 * Hierarchy:
 *   group (axial tilt about Z)
 *   └─ spin (rotation about the tilted polar axis)
 *      ├─ surface   r = 1.000
 *      ├─ clouds    r = 1.006  (extra rotation relative to ground)
 *      └─ beacons are attached here by the caller
 *   └─ halo        r = 1.036  (rotation-invariant, BackSide additive)
 *
 * @param {EarthTextures} textures
 */
export function createEarth(textures) {
  // Uniform objects shared by reference across materials.
  const shared = {
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uSunIntensity: { value: 1.0 },
    uAtmosphereIntensity: { value: 1.0 },
    uCloudOpacity: { value: 1.0 },
    uCameraDistance: { value: 3.1 },
  };

  const group = new THREE.Group();
  group.name = 'earthGroup';
  group.rotation.z = THREE.MathUtils.degToRad(AXIAL_TILT_DEG);

  const spin = new THREE.Group();
  spin.name = 'earthSpin';
  group.add(spin);

  // --- Surface ---------------------------------------------------------------
  const surfaceGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 256, 256);
  surfaceGeometry.computeTangents();

  const topoImage = /** @type {{ width: number, height: number }} */ (textures.topology.image);
  const surfaceUniforms = {
    ...shared,
    uDayTexture: { value: textures.day },
    uNightTexture: { value: textures.night },
    uSpecularMap: { value: textures.specular },
    uTopologyMap: { value: textures.topology },
    uCloudsTexture: { value: textures.clouds },
    uTopologyTexel: { value: new THREE.Vector2(1 / topoImage.width, 1 / topoImage.height) },
    uBumpScale: { value: 0.0035 },
    uCloudOffset: { value: 0 },
    uCloudHeight: { value: CLOUD_RADIUS - EARTH_RADIUS },
    uSpecularIntensity: { value: 1.0 },
    uOceanRoughness: { value: 0.14 },
    uNightIntensity: { value: 1.0 },
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

  // --- Clouds ---------------------------------------------------------------
  const cloudMaterial = new THREE.ShaderMaterial({
    name: 'EarthClouds',
    glslVersion: THREE.GLSL3,
    vertexShader: shellVert,
    fragmentShader: cloudsFrag,
    uniforms: {
      uSunDirection: shared.uSunDirection,
      uSunIntensity: shared.uSunIntensity,
      uAtmosphereIntensity: shared.uAtmosphereIntensity,
      uCloudOpacity: shared.uCloudOpacity,
      uCloudsTexture: { value: textures.clouds },
      uCloudRelief: { value: 0.0035 },
      uCameraDistance: shared.uCameraDistance,
    },
    transparent: true,
    depthWrite: false,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_RADIUS, 192, 192), cloudMaterial);
  clouds.name = 'earthClouds';
  clouds.renderOrder = 1;
  spin.add(clouds);

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
      uPlanetRadius: { value: EARTH_RADIUS },
      uAtmosphereRadius: { value: ATMOSPHERE_RADIUS },
      uCameraDistance: shared.uCameraDistance,
    },
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 128, 128), haloMaterial);
  halo.name = 'atmosphereHalo';
  halo.renderOrder = 3;
  group.add(halo);

  /**
   * Sets the cloud shell's rotation relative to the ground and keeps the
   * surface shader's shadow/occlusion lookups registered to it.
   * @param {number} angle radians about the polar axis
   */
  function setCloudRotation(angle) {
    clouds.rotation.y = angle;
    // A shell rotated by +φ shows cloud texel u − φ/2π above ground texel u.
    const offset = -angle / (Math.PI * 2);
    surfaceUniforms.uCloudOffset.value = offset - Math.floor(offset);
  }

  return {
    group,
    spin,
    surface,
    clouds,
    halo,
    uniforms: { shared, surface: surfaceUniforms, clouds: cloudMaterial.uniforms, halo: haloMaterial.uniforms },
    setCloudRotation,
  };
}
