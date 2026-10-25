#include <common>
#include <logdepthbuf_pars_fragment>
// Deep-space background: the Milky Way.
//
// Procedural galactic band with clumpy star clouds, a bright bulge toward
// Sagittarius and dark dust lanes cut through the plane. Rendered on the inside
// of a huge sphere behind the star sprites. Very low luminance on purpose: it
// should be *just* visible the way the Milky Way is from orbit.

uniform float uIntensity;

in vec3 vDir;

out vec4 fragColor;

// Galactic north pole (roughly RA 12h49m, Dec +27.1°) in scene coordinates.
const vec3 GALACTIC_NORTH = vec3(0.36, 0.84, -0.41);

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

  float lon = atan(dir.z, dir.x);
  vec2 gp = vec2(lon * 2.6, sinLat * 11.0);

  float clouds = fbm4(gp * 2.4 + 3.7);
  float dust = fbm4(gp * 3.4 + 19.3);

  // Dust lanes: dark filaments hugging the plane.
  float lane = smoothstep(0.42, 0.78, dust) * exp(-pow(sinLat / 0.055, 2.0));
  float extinction = 1.0 - lane * 0.85;

  // Central bulge: brightest toward the galactic core direction.
  vec3 coreDir = normalize(vec3(-0.42, -0.16, 0.89));
  float toCore = max(dot(dir, coreDir), 0.0);
  float bulge = pow(toCore, 24.0) * 1.5 + pow(toCore, 5.0) * 0.22;

  float density = band * (0.30 + 0.70 * clouds) * extinction;
  float speckle = pow(valueNoise(gp * 130.0), 10.0) * band * 0.5;

  vec3 warm = vec3(1.00, 0.83, 0.62);
  vec3 cool = vec3(0.62, 0.70, 0.92);
  vec3 tint = mix(cool, warm, clamp(clouds * 0.8 + toCore * 0.5, 0.0, 1.0));

  vec3 color = tint * (density * 0.060 + bulge * extinction * 0.085);
  color += vec3(0.82, 0.88, 1.0) * speckle * 0.045;
  color *= uIntensity;

  // Fade the band into the black of space with no visible seam.
  float vignette = smoothstep(0.0, 0.30, band);
  fragColor = vec4(color * vignette, 1.0);
}
