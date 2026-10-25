#include <common>
#include <logdepthbuf_pars_fragment>
// ---------------------------------------------------------------------------
// Atmospheric limb — physically based single scattering.
//
// Rendered as the back faces of a shell at 1.028 R and composited additively,
// but ONLY for rays that miss the planet: a ray that reaches the ground gets its
// airlight from the surface shader, otherwise the scattering would be counted
// twice and the disc would turn milky blue.
//
// Key detail: Earth's atmosphere is 0.5% of the planet radius. Uniform sampling
// across a 300 km chord steps straight over the entire scattering layer, so the
// march is instead concentrated around the ray's closest approach to the surface,
// where the density actually lives (the classic Chapman-function geometry:
// altitude rises quadratically, h(s) ≈ h0 + s²/2R).
// ---------------------------------------------------------------------------

uniform vec3  uSunDirection;
uniform float uSunIntensity;
uniform float uAtmosphereIntensity;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform float uCameraDistance;

in vec2 vUv;
in vec3 vPosW;
in vec3 vNormalW;
in vec3 vCenterW;

out vec4 fragColor;

const int   MARCH_STEPS = 20;
const float MARCH_HALF_WIDTH = 0.16;   // planet radii either side of closest approach

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 center = vCenterW;
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vPosW - cameraPosition);
  vec3 oc = ro - center;

  float R = uPlanetRadius;
  float Ra = uAtmosphereRadius;

  float b = dot(oc, rd);
  float cAtm = dot(oc, oc) - Ra * Ra;
  float hAtm = b * b - cAtm;
  if (hAtm < 0.0) discard;
  float sqrtAtm = sqrt(hAtm);
  float tExit = -b + sqrtAtm;

  // Planet occlusion: those pixels are shaded by the surface shader already.
  float cPl = dot(oc, oc) - R * R;
  float hPl = b * b - cPl;
  if (hPl > 0.0) {
    float tPlanet = -b - sqrt(hPl);
    if (tPlanet < tExit) discard;
  }

  float tEnter = max(-b - sqrtAtm, 0.0);
  float tClose = clamp(-b, tEnter, tExit);

  float lo = max(tEnter, tClose - MARCH_HALF_WIDTH);
  float hi = min(tExit, tClose + MARCH_HALF_WIDTH);
  float stepLen = (hi - lo) / float(MARCH_STEPS);
  if (stepLen <= 0.0) discard;

  vec3 L = normalize(uSunDirection);
  float mu = dot(rd, L);
  float phaseR = rayleighPhase(mu);
  float phaseM = hgPhase(mu, PL_MIE_G);
  float jitter = hash21(gl_FragCoord.xy);

  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float hMin = 1e9;

  for (int i = 0; i < MARCH_STEPS; i += 1) {
    float t = lo + (float(i) + 0.5 + jitter) * stepLen;
    vec3 p = ro + rd * t - center;
    float radius = length(p);
    float altitude = max(radius - R, 0.0);
    hMin = min(hMin, altitude);

    float densityR = exp(-altitude / PL_H_RAYLEIGH);
    float densityM = exp(-altitude / PL_H_MIE);

    vec3 up = p / max(radius, 1e-5);
    float cosSun = dot(up, L);
    // Sunlight reaching this sample, reddened by the air it crosses.
    float sunMass = relativeAirMass(cosSun) * densityR;
    vec3 sunT = exp(-(PL_BETA_R * PL_H_RAYLEIGH + PL_BETA_M * PL_H_MIE) * sunMass);
    float lit = smoothstep(-0.02, 0.12, cosSun);

    sumR += densityR * sunT * lit * stepLen;
    sumM += densityM * sunT * lit * stepLen;
  }

  vec3 radiance = (PL_BETA_R * phaseR * sumR + PL_BETA_M * phaseM * sumM)
                * uSunIntensity * uAtmosphereIntensity;

  // Satellites photograph a faint green oxygen airglow band at ~95 km on the
  // night limb (O I 557.7 nm). It is sun-independent emission.
  float nightSide = 1.0 - smoothstep(-0.03, 0.18, dot(normalize(vPosW - center), L));
  float airglow = exp(-pow((hMin - 0.0075) / 0.0045, 2.0));
  radiance += vec3(0.18, 0.85, 0.45) * airglow * nightSide * 0.030 * uAtmosphereIntensity;

  radiance = min(radiance, vec3(20.0));

  // Fade the effect out as the camera dives into the atmosphere.
  float zoomFade = mix(0.35, 1.0, smoothstep(1.018, 1.35, uCameraDistance));
  fragColor = vec4(radiance * zoomFade, 1.0);
}
