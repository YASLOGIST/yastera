// Outer atmospheric scattering halo — fragment stage (radius 1.016, BackSide,
// additive). Evaluates radial optical depth along the tangent chord through
// the thin planetary atmosphere (0 to 102 km altitude).

uniform vec3  uSunDirection;
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform float uAtmosphereIntensity;
uniform float uSunIntensity;
uniform float uCameraDistance;

in vec2 vUv;
in vec3 vPosW;
in vec3 vNormalW;
in vec3 vCenterW;

out vec4 fragColor;

const float PI = 3.141592653589793;

// Rayleigh scattering coefficients for Earth's atmosphere (λ_R = 700nm, λ_G = 530nm, λ_B = 440nm)
const vec3 RAYLEIGH_SCATTER  = vec3(0.16, 0.52, 1.00);
const vec3 OZONE_STRATO      = vec3(0.20, 0.42, 0.95); // Stratospheric ozone tint
const vec3 SUNSET_CRIMSON    = vec3(1.00, 0.32, 0.06);
const vec3 SUNSET_GOLD       = vec3(1.00, 0.68, 0.20);
const vec3 MIE_AEROSOL       = vec3(1.00, 0.94, 0.86);

// Cornette-Shanks / Henyey-Greenstein phase for aerosol forward scattering
float phaseHG(float cosAngle, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

void main() {
  vec3 rayDir = normalize(vPosW - cameraPosition);
  vec3 toCenter = vCenterW - cameraPosition;
  float tClosest = dot(toCenter, rayDir);
  vec3 closest = cameraPosition + rayDir * tClosest;
  float d = length(closest - vCenterW);

  float R = uPlanetRadius;
  float Ra = uAtmosphereRadius;
  float h = clamp((d - R) / (Ra - R), 0.0, 1.0);

  // Optical depth: barometric exponential density profile × tangent chord length
  float chord = sqrt(max(Ra * Ra - d * d, 0.0)) / sqrt(Ra * Ra - R * R);
  float opticalDepth = exp(-h * 4.6) * chord;

  // Smooth feathering into the vacuum of space (no hard shell edge)
  opticalDepth *= 1.0 - smoothstep(0.78, 1.0, h);

  vec3 sunDir = normalize(uSunDirection);
  vec3 tangentNormal = normalize(closest - vCenterW);
  float sunDot = dot(tangentNormal, sunDir);

  // Day vs night transition across the atmospheric limb
  float dayLit = smoothstep(-0.25, 0.28, sunDot);

  // Rayleigh wavelength spectrum: brilliant electric cyan in troposphere,
  // deepening into ozone indigo at higher altitudes
  vec3 dayRayleigh = mix(RAYLEIGH_SCATTER * 1.3, OZONE_STRATO, smoothstep(0.2, 0.8, h));

  // Sunset/twilight reddening along the terminator
  vec3 twilightBand = mix(SUNSET_CRIMSON, SUNSET_GOLD, smoothstep(-0.15, 0.10, sunDot));
  vec3 limbColor = mix(twilightBand, dayRayleigh, smoothstep(-0.06, 0.28, sunDot));

  // Forward Mie scattering (aerosols / solar corona when looking toward the sun)
  float forwardScatter = dot(rayDir, sunDir);
  float miePhase = phaseHG(forwardScatter, 0.80) * smoothstep(-0.35, 0.15, sunDot);
  vec3 mie = MIE_AEROSOL * miePhase * 0.45;

  float zoomHaloFade = smoothstep(1.018, 1.06, uCameraDistance);
  vec3 radiance = (limbColor * 1.25 + mie) * opticalDepth * dayLit * uAtmosphereIntensity * uSunIntensity * zoomHaloFade;

  fragColor = vec4(radiance, 1.0);
}
