// Cloud shell — fragment stage (radius 1.0022: ~14 km troposphere).
//
// Multi-scattering optical model: high single-scattering albedo for pure water
// droplets, forward-peaked Mie scattering (silver lining corona), micro-relief
// self-shadowing, and high-altitude twilight illumination along the terminator.

uniform sampler2D uCloudsTexture;
uniform vec3  uSunDirection;
uniform float uCloudOpacity;
uniform float uSunIntensity;
uniform float uAtmosphereIntensity;
uniform float uCloudRelief;
uniform float uCameraDistance;

in vec2 vUv;
in vec3 vPosW;
in vec3 vNormalW;
in vec3 vCenterW;

out vec4 fragColor;

const float PI = 3.141592653589793;

const vec3 CLOUD_ALBEDO   = vec3(0.98, 0.99, 1.00);
const vec3 SUNSET_GOLD    = vec3(1.00, 0.62, 0.22);
const vec3 SUNSET_CRIMSON = vec3(0.96, 0.35, 0.10);
const vec3 ORBITAL_CYAN   = vec3(0.18, 0.54, 1.00);

float sat(float x) { return clamp(x, 0.0, 1.0); }

// Henyey-Greenstein phase function for forward cloud droplet scattering
float phaseHG(float cosAngle, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

// Screen-space normal perturbation for cumulus cloud relief
vec3 perturbNormal(vec3 pos, vec3 N, float height) {
  vec3 dpdx = dFdx(pos);
  vec3 dpdy = dFdy(pos);
  float dhdx = dFdx(height);
  float dhdy = dFdy(height);
  vec3 r1 = cross(dpdy, N);
  vec3 r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * N - grad);
}

void main() {
  float raw = texture(uCloudsTexture, vUv).r;
  // Natural non-linear cloud optical depth curve
  float density = smoothstep(0.05, 0.76, raw);

  if (density * uCloudOpacity < 0.002) discard;

  vec3 sphereNormal = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);
  vec3 sunDir = normalize(uSunDirection);

  // Micro-relief: cumulus clouds catch sunlight on sunward tops
  vec3 N = perturbNormal(vPosW, sphereNormal, density * uCloudRelief);

  float sunOrientation = dot(sphereNormal, sunDir);
  float dayMix = smoothstep(-0.20, 0.32, sunOrientation);
  float twilight = smoothstep(-0.28, 0.04, sunOrientation) * smoothstep(0.28, -0.02, sunOrientation);

  // Normal dot sun for relief lighting and self-shadowing
  float NdotL = dot(N, sunDir);
  float grazing = mix(3.5, 1.0, smoothstep(0.0, 0.5, sunOrientation));
  float relief = clamp(1.0 + (NdotL - sunOrientation) * grazing, 0.60, 1.35);

  // Direct sun irradiance
  float sunIllum = dayMix * (0.60 + 0.40 * sat(sunOrientation)) * relief;

  // Forward Mie scattering (silver lining effect when viewing backlit clouds)
  float cosTheta = dot(viewDir, sunDir);
  float mieForward = phaseHG(cosTheta, 0.70) * smoothstep(-0.15, 0.35, sunOrientation) * 0.42;

  // Day illumination with high albedo
  vec3 dayColor = CLOUD_ALBEDO * (sunIllum + mieForward) * uSunIntensity;

  // High-altitude sunset illumination along the terminator (clouds catch setting sun longer than ground)
  vec3 sunsetColor = mix(SUNSET_CRIMSON, SUNSET_GOLD, smoothstep(-0.10, 0.15, sunOrientation));
  vec3 litClouds = mix(dayColor, sunsetColor * 1.25, twilight * 0.70);

  // Atmospheric limb aerial perspective: clouds near the limb pass through air column
  float cosV = max(dot(viewDir, sphereNormal), 0.0);
  float limbAirmass = 1.0 - pow(cosV, 2.5);
  vec3 finalColor = mix(litClouds, ORBITAL_CYAN * 0.45 * dayMix, limbAirmass * 0.35 * uAtmosphereIntensity);

  // Night side: dark silhouettes over cities and oceans, zero ambient glow in deep space
  finalColor = mix(vec3(0.0), finalColor, smoothstep(-0.22, 0.08, sunOrientation));

  // Physical optical opacity: thick storm centers are opaque; thin cirrus edges are translucent
  // When descending to inspect a city (low altitude), clouds gently thin to allow clear inspection
  float zoomCloudFade = mix(0.40, 1.0, smoothstep(1.015, 1.18, uCameraDistance));
  float alpha = density * uCloudOpacity * mix(0.30, 1.0, dayMix) * zoomCloudFade;

  fragColor = vec4(finalColor, alpha);
}
