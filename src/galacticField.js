import * as THREE from 'three';

/**
 * The galaxy, as the rest of the app sees it.
 *
 * This is a JS port of `valueNoise3` / `fbmGalactic` from shaders/lib/noise.glsl
 * and shaders/milkyway.frag. Living here rather than inside starfield.js keeps
 * it importable without Vite, so the star distribution can be measured in Node
 * (see the density assertions in the test script) instead of eyeballed.
 */
// The star sprites are clustered by the same field that draws the unresolved
// glow, so the resolved stars sit inside the luminous band instead of being
// sprinkled over it independently. That agreement is most of what makes a
// synthetic sky read as a real one.
//
// Kept to two octaves: the rejection sampler only needs the large-scale shape,
// and it runs a few times per star at load.
export const GALACTIC_NORTH = new THREE.Vector3(0.36, 0.84, -0.41).normalize();
const INTENDED_CORE = new THREE.Vector3(-0.42, -0.16, 0.89);
// Project the intended bulge direction onto the galactic plane. The galactic
// centre is at galactic latitude 0 by definition, so this projection is what
// keeps the bright bulge inside the band (it was 40 degrees off-plane before).
export const GALACTIC_CORE = INTENDED_CORE.clone()
  .addScaledVector(GALACTIC_NORTH, -INTENDED_CORE.dot(GALACTIC_NORTH))
  .normalize();
export const GALACTIC_SIDE = new THREE.Vector3().crossVectors(GALACTIC_NORTH, GALACTIC_CORE).normalize();
const GALACTIC_SCALE_X = 3.1;
const GALACTIC_SCALE_Y = 3.1;
const GALACTIC_SCALE_Z = 12.5;

// Overdensity of stars in the galactic plane relative to the rest of the sky.
export const GALACTIC_STAR_CONTRAST = 6.0;
// Upper bound of galacticDensity(). Rejection sampling must divide by this:
// comparing `rand() < density` against a density that is always >= 1 accepts
// every draw, which silently turns the whole field into a uniform sky.
export const GALACTIC_DENSITY_MAX = 1 + GALACTIC_STAR_CONTRAST;

const fract = (x) => x - Math.floor(x);

function hash13a(x, y, z) {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(z * 0.1031);
  const d = px * (pz + 31.32) + py * (py + 31.32) + pz * (px + 31.32);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
}

function valueNoise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const n000 = hash13a(ix, iy, iz);
  const n100 = hash13a(ix + 1, iy, iz);
  const n010 = hash13a(ix, iy + 1, iz);
  const n110 = hash13a(ix + 1, iy + 1, iz);
  const n001 = hash13a(ix, iy, iz + 1);
  const n101 = hash13a(ix + 1, iy, iz + 1);
  const n011 = hash13a(ix, iy + 1, iz + 1);
  const n111 = hash13a(ix + 1, iy + 1, iz + 1);
  const a = n000 + (n100 - n000) * fx;
  const b = n010 + (n110 - n010) * fx;
  const c = n001 + (n101 - n001) * fx;
  const d = n011 + (n111 - n011) * fx;
  const e = a + (b - a) * fy;
  const f = c + (d - c) * fy;
  return e + (f - e) * fz;
}

/**
 * Two-octave galactic fBm at the given direction. The shader uses three
 * octaves and a domain warp; the extra detail does not move the large-scale
 * clouds, which is all the rejection sampler needs.
 */
export function galacticClouds(dir) {
  const gx = dir.dot(GALACTIC_SIDE) * GALACTIC_SCALE_X + 3.7;
  const gy = dir.dot(GALACTIC_CORE) * GALACTIC_SCALE_Y + 3.7;
  const gz = dir.dot(GALACTIC_NORTH) * GALACTIC_SCALE_Z + 3.7;
  let sum = 0.5 * valueNoise3(gx, gy, gz);
  sum += 0.275 * valueNoise3(gx * 2.07 + 1.7, gy * 2.07 + 1.7, gz * 2.07 + 1.7);
  return sum / 0.775;
}

/**
 * Relative star density in a direction.
 *
 * `1 + contrast * band` rather than `band` alone, and this is the difference
 * between a sky and a spotlight. A pure band function makes the poles have
 * essentially zero density, so rejection sampling packs half the stars into ten
 * degrees of the plane (measured: 32.8x the uniform share) and leaves the rest
 * of the sky conspicuously bare. Real skies are not that extreme; measured
 * counts run about 5-8x denser in the plane than at the poles. The additive
 * floor also keeps the rejection sampler cheap, because no direction can have
 * a low acceptance probability.
 */
export function galacticDensity(dir, sinLat) {
  const band =
    Math.exp(-Math.pow(sinLat / 0.115, 2)) * 0.85 +
    Math.exp(-Math.pow(sinLat / 0.34, 2)) * 0.25;
  const clouds = galacticClouds(dir);
  return 1.0 + GALACTIC_STAR_CONTRAST * band * (0.30 + 0.70 * clouds);
}

/**
 * How strongly the plane is favoured, normalised to 0..1. Used to draw stars in
 * the band slightly dimmer: crowding is what makes a band read as unresolved
 * light rather than as a scatter of individual points.
 */
export function galacticCrowding(density) {
  return Math.min(1, (density - 1) / GALACTIC_STAR_CONTRAST);
}
