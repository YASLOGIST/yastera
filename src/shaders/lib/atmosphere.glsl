// ---------------------------------------------------------------------------
// Atmosphere / scattering constants shared by the surface, cloud and halo
// shaders. All distances are in planet radii (1.0 = 6371 km).
//
// Coefficients are NASA/ESA standard-atmosphere values converted to per-radius
// units so the maths stays in float32's comfortable range:
//   Rayleigh (680/550/440 nm):  36.9 / 86.0 / 211.0   (per R)
//   Mie (aerosol, 550 nm):      133.8                 (per R)
//   Scale heights: 8.0 km (R) and 1.2 km (M)
// ---------------------------------------------------------------------------
const float PL_H_RAYLEIGH = 0.001256;   // 8 km
const float PL_H_MIE      = 0.00019;    // 1.2 km
const vec3  PL_BETA_R     = vec3(36.9, 86.0, 211.0);
const vec3  PL_BETA_M     = vec3(133.8);
const float PL_MIE_G      = 0.76;

// Rayleigh phase: 3/(16π) (1 + μ²)
float rayleighPhase(float mu) {
  return 0.0596831 * (1.0 + mu * mu);
}

// Henyey-Greenstein aerosol/cloud droplet phase.
float hgPhase(float mu, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * mu, 1e-4);
  return (1.0 - g2) / (12.566371 * denom * sqrt(denom));
}

// Kasten & Young (1989) relative optical air mass, clamped to the horizon.
float relativeAirMass(float cosZenith) {
  float c = clamp(cosZenith, -1.0, 1.0);
  float zenithDeg = degrees(acos(c));
  float cosZ = max(c, 0.0);
  float denom = cosZ + 0.50572 * pow(max(96.07995 - zenithDeg, 0.001), -1.6364);
  return min(38.0, 1.0 / max(denom, 0.0015));
}

// Optical depth from a point at `altitude` (radii above the surface) along a
// relative air mass. Rayleigh and aerosol densities have different scale
// heights; applying the Rayleigh falloff to both makes high cloud and limb
// samples carry too much aerosol extinction.
vec3 atmosphereOpticalDepth(float altitude, float airMass) {
  float h = max(altitude, 0.0);
  float densityR = exp(-h / PL_H_RAYLEIGH);
  float densityM = exp(-h / PL_H_MIE);
  return (PL_BETA_R * PL_H_RAYLEIGH * densityR
        + PL_BETA_M * PL_H_MIE * densityM) * max(airMass, 0.0);
}

// Transmittance from a point at `altitude` (radii above the surface) toward a
// direction whose cosine with the local up vector is `cosZenith`.
vec3 atmosphereTransmittanceFrom(float altitude, float cosZenith) {
  float airMass = relativeAirMass(cosZenith);
  return exp(-atmosphereOpticalDepth(altitude, airMass));
}

// Sunlight reaching the top of the atmosphere, already reddened by grazing
// geometry. `up` and `sunDir` are unit world vectors.
vec3 sunlightAtSurface(vec3 up, vec3 sunDir, float altitude, float intensity) {
  float cosSun = dot(up, sunDir);
  // Below the geometric horizon direct sunlight is gone; keep a tiny amount of
  // twilight so the terminator does not snap to black.
  vec3 t = atmosphereTransmittanceFrom(altitude, cosSun);
  float aboveHorizon = smoothstep(-0.055, 0.02, cosSun);
  return t * mix(0.06, 1.0, aboveHorizon) * intensity;
}
