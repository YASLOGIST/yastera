// ---------------------------------------------------------------------------
// Shared procedural helpers: hash, value noise, fBm and analytic ocean waves.
// Everything here is deterministic and GPU-cheap (no loops over textures).
// ---------------------------------------------------------------------------

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 4-octave fBm, roughly 0..1.
float fbm4(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    sum += amp * valueNoise(p);
    norm += amp;
    p = rot * p * 2.03 + 17.3;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

// Gradient of value noise, used for cheap wave/terrain normals.
vec2 valueNoiseGrad(vec2 p) {
  const float e = 0.08;
  float dx = valueNoise(p + vec2(e, 0.0)) - valueNoise(p - vec2(e, 0.0));
  float dy = valueNoise(p + vec2(0.0, e)) - valueNoise(p - vec2(0.0, e));
  return vec2(dx, dy) / (2.0 * e);
}

/**
 * Directional wind-sea normal perturbation.
 *
 * Sums five travelling wave trains with different headings, wavelengths and
 * speeds. `freq` is the base wavenumber (cells across the UV tile), `amp` the
 * slope amplitude, `t` the time in seconds.
 */
vec2 windSeaSlope(vec2 uv, float freq, float amp, float t) {
  vec2 slope = vec2(0.0);
  float total = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float angle = 0.9 + fi * 1.77;
    vec2 dir = vec2(cos(angle), sin(angle));
    float w = freq * (1.0 + fi * 0.73);
    float speed = 0.35 + fi * 0.12;
    float phase = dot(uv, dir) * w + t * (0.55 + speed);
    float a = amp / (1.0 + fi * 0.85);
    slope += dir * cos(phase) * a;
    total += a;
  }
  return slope / max(total, 1e-4);
}

// Cheap 3D direction hash, used for the deep-space star colouring.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// ---------------------------------------------------------------------------
// 3D noise evaluated on the unit sphere. Because the domain is the sphere
// direction rather than the equirectangular UV, this is seamless in longitude
// and has no pinching at the poles — essential for cloud detail that survives
// a full orbit and a descent to 50 km.
// ---------------------------------------------------------------------------

float hash13a(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13a(i);
  float n100 = hash13a(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13a(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13a(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13a(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13a(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13a(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13a(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

// 5-octave spherical fBm with domain warping. `dir` must be a unit vector.
float fbmSphere(vec3 dir, float freq, float octaves) {
  vec3 p = dir * freq;
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (float(i) >= octaves) break;
    // Domain warping breaks the "cloudy Perlin" look and produces the fibrous
    // filaments real cirrus has. It only pays off at low frequencies, so it is
    // restricted to the first two octaves — worth ~40% of the shader's cost.
    vec3 samplePos = p;
    if (i < 2) {
      vec3 warp = vec3(
        valueNoise3(p * 0.37 + 11.3),
        valueNoise3(p * 0.41 + 41.7),
        valueNoise3(p * 0.33 + 71.1)) - 0.5;
      samplePos += warp * 1.4;
    }
    sum += amp * valueNoise3(samplePos);
    norm += amp;
    p *= 2.02;
    amp *= 0.52;
  }
  return sum / max(norm, 1e-4);
}
