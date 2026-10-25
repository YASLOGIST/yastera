#include <common>
#include <logdepthbuf_pars_fragment>
// Deep-space background: the Milky Way.
//
// Procedural galactic band with clumpy star clouds, a bright bulge toward
// Sagittarius and dark dust lanes cut through the plane. Rendered on the inside
// of a huge sphere behind the star sprites. Very low luminance on purpose: it
// should be *just* visible the way the Milky Way is from orbit.
//
// Two things here are easy to get wrong, and both were:
//
//  1. The noise must be sampled in three dimensions. Sampling a 2D field at
//     `atan(z, x)` gives the band a hard vertical seam at longitude ±180°, which
//     sweeps across the view as the camera orbits. The sphere direction has no
//     such seam, so valueNoise3 is used throughout.
//  2. The galactic centre is *by definition* at galactic latitude 0. If the
//     bulge direction is not perpendicular to the galactic pole, the brightest
//     part of the galaxy is drawn floating in empty sky. GALACTIC_CORE below is
//     the projection of the intended view direction onto the galactic plane, so
//     it is exactly in-plane.

uniform float uIntensity;

in vec3 vDir;

out vec4 fragColor;

// Galactic north pole in scene coordinates. Every other direction is derived
// from it, so this is the only constant that has to be self-consistent.
const vec3 GALACTIC_NORTH = normalize(vec3(0.36, 0.84, -0.41));

// Anisotropic galactic-frame fBm with 3 octaves, domain-warped on the first
// octave so the star clouds break into filaments instead of blobs.
float fbmGalactic(vec3 g, float warpAmount) {
  vec3 p = g;
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 3; i++) {
    vec3 q = p;
    if (i == 0) {
      q += vec3(
        valueNoise3(p * 0.9 + 11.3),
        valueNoise3(p * 0.8 + 41.7),
        valueNoise3(p * 1.6 + 71.1)) * warpAmount;
    }
    sum += amp * valueNoise3(q);
    norm += amp;
    p = p * 2.07 + 1.7;
    amp *= 0.55;
  }
  return sum / max(norm, 1e-4);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  float sinLat = dot(dir, GALACTIC_NORTH);

  // Band falloff: dense plane plus a diffuse halo.
  float band = exp(-pow(sinLat / 0.115, 2.0)) * 0.85
             + exp(-pow(sinLat / 0.34, 2.0)) * 0.25;
  if (band < 0.0035) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Galactic frame: x runs along the plane, y along the plane toward the core,
  // z out of the plane. Scaling z far harder than x/y stretches the noise along
  // the band, which is what turns isotropic fBm into star clouds and dust
  // filaments that follow the plane.
  //
  // CORE is the intended view direction projected onto the galactic plane, so
  // it is perpendicular to GALACTIC_NORTH by construction and the bulge can
  // never be drawn off the band.
  const vec3 INTENDED_CORE = vec3(-0.42, -0.16, 0.89);
  vec3 CORE = normalize(INTENDED_CORE - dot(INTENDED_CORE, GALACTIC_NORTH) * GALACTIC_NORTH);
  vec3 SIDE = normalize(cross(GALACTIC_NORTH, CORE));
  vec3 g = vec3(dot(dir, SIDE), dot(dir, CORE), sinLat) * vec3(3.1, 3.1, 12.5);

  float clouds = fbmGalactic(g + 3.7, 0.35);
  float dustField = fbmGalactic(g * 1.31 + 19.3, 0.0);

  // Dust lanes: dark filaments hugging the plane.
  float lane = smoothstep(0.44, 0.78, dustField) * exp(-pow(sinLat / 0.055, 2.0));
  float extinction = 1.0 - lane * 0.85;

  // Central bulge: brightest toward the galactic core direction, in the plane.
  float toCore = max(dot(dir, CORE), 0.0);
  float bulge = pow(toCore, 24.0) * 1.5 + pow(toCore, 5.0) * 0.22;

  float density = band * (0.30 + 0.70 * clouds) * extinction;

  vec3 warm = vec3(1.00, 0.83, 0.62);
  vec3 cool = vec3(0.62, 0.70, 0.92);
  // Near the core the stellar population is older and redder; the outer arms
  // read blue-white. Tint follows both the cloud structure and the core angle.
  vec3 tint = mix(cool, warm, clamp(clouds * 0.8 + toCore * 0.5, 0.0, 1.0));

  // No procedural star grain here. At 190 cells per unit of direction the grain
  // was finer than a pixel and crawled visibly whenever the camera rotated:
  // procedural noise has no mip chain. The resolved starlight comes from the
  // sprite field instead, which is clustered by the same galactic density field
  // (see starfield.js), so the two layers agree by construction.
  vec3 color = tint * (density * 0.060 + bulge * extinction * 0.085);
  color *= uIntensity;

  // Fade the band into the black of space with no visible seam.
  float vignette = smoothstep(0.0, 0.30, band);
  fragColor = vec4(color * vignette, 1.0);
}
