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

// Split the quadrature around closest approach. Altitude grows quadratically
// away from that point, so squared-distance bins resolve the dense lower air
// without increasing the 20-sample budget.
const int MARCH_HALF_STEPS = 10;
const int MARCH_STEPS = 2 * MARCH_HALF_STEPS;

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
    if (tPlanet > 0.0 && tPlanet < tExit) discard;
  }

  if (tExit <= 0.0) discard;
  float tEnter = max(-b - sqrtAtm, 0.0);
  float tClose = clamp(-b, tEnter, tExit);
  float leftSpan = max(tClose - tEnter, 0.0);
  float rightSpan = max(tExit - tClose, 0.0);
  if (leftSpan + rightSpan <= 1e-5) discard;

  vec3 L = normalize(uSunDirection);
  // Scattering cosine: the angle between where the light came from and where it
  // is going. Light arrives at the sample travelling along -L and leaves along
  // -rd (`rd` runs camera -> scene), so the cosine is dot(-L, -rd) = dot(rd, L).
  //
  // The signs cancel, which is exactly why this is worth stating twice: it is
  // tempting to "fix" it to -dot(rd, L) on the grounds that rd points into the
  // scene. That inverts the phase function and puts the forward-scattering lobe
  // on the anti-solar limb. Checked numerically against the definition
  // dot(normalize(sun - p), normalize(camera - p)) for a sun on +X: the sunward
  // limb reads +0.322 and the anti-solar limb -0.322, matching dot(rd, L).
  float mu = dot(rd, L);
  float phaseR = rayleighPhase(mu);
  float phaseM = hgPhase(mu, PL_MIE_G);

  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 closestPoint = ro + rd * tClose - center;
  float hMin = max(length(closestPoint) - R, 0.0);

  for (int i = 0; i < MARCH_STEPS; i += 1) {
    bool beforeClosest = i < MARCH_HALF_STEPS;
    int sampleIndex = beforeClosest ? i : i - MARCH_HALF_STEPS;
    float binStart = float(sampleIndex) / float(MARCH_HALF_STEPS);
    float binEnd = float(sampleIndex + 1) / float(MARCH_HALF_STEPS);
    // Deterministic midpoint quadrature avoids a visible grain pattern on the
    // narrow limb while the squared-distance mapping still resolves its density.
    float u = (float(sampleIndex) + 0.5) / float(MARCH_HALF_STEPS);
    float span = beforeClosest ? leftSpan : rightSpan;
    float binWeight = span * (binEnd * binEnd - binStart * binStart);
    float t = tClose + (beforeClosest ? -1.0 : 1.0) * span * u * u;

    vec3 p = ro + rd * t - center;
    float radius = length(p);
    float altitude = max(radius - R, 0.0);
    float densityR = exp(-altitude / PL_H_RAYLEIGH);
    float densityM = exp(-altitude / PL_H_MIE);

    vec3 up = p / max(radius, 1e-5);
    float cosSun = dot(up, L);
    float cosView = dot(up, -rd);
    // A single-scattered photon is attenuated on both legs: Sun -> sample and
    // sample -> camera. The shared helper keeps aerosol and molecular falloff
    // separate at each point in the shell.
    vec3 sunT = atmosphereTransmittanceFrom(altitude, cosSun);
    vec3 viewT = atmosphereTransmittanceFrom(altitude, cosView);
    float lit = smoothstep(-0.02, 0.12, cosSun);
    vec3 pathT = sunT * viewT;

    sumR += densityR * pathT * lit * binWeight;
    sumM += densityM * pathT * lit * binWeight;
  }

  // The march accumulates optical depth along the chord, but a thin shell is
  // also optically thin *across* it: the light crossing the limb has to be
  // scaled by the actual extinction, not just by the density integral, or the
  // band saturates into a flat blue vinyl stripe.
  vec3 radiance = (PL_BETA_R * phaseR * sumR + PL_BETA_M * phaseM * sumM)
                * uSunIntensity * uAtmosphereIntensity;

  // The green O I 557.7 nm nightglow peaks around 95 km, not at the surface.
  // It is a faint, narrow emission layer and is independent of direct sunlight.
  float nightSide = 1.0 - smoothstep(-0.03, 0.18, dot(normalize(closestPoint), L));
  float airglow = exp(-pow((hMin - 0.0150) / 0.0035, 2.0));
  radiance += vec3(0.18, 0.85, 0.45) * airglow * nightSide * 0.030 * uAtmosphereIntensity;

  radiance = min(radiance, vec3(20.0));

  // Fade the effect out as the camera dives into the atmosphere: from inside
  // the shell the limb is no longer a thin band, and the constant would have to
  // become a full sky model. The surface shader owns that regime.
  float zoomFade = smoothstep(1.012, 1.20, uCameraDistance);
  fragColor = vec4(radiance * zoomFade, 1.0);
}
