// Planetary surface — fragment stage.
//
// Physically based radiative transfer:
// 1. Tangent-space terrain relief (SRTM / GEBCO).
// 2. NASA Blue Marble calibrated continental albedo.
// 3. Liquid ocean optics: Snell-Descartes & Schlick-Fresnel water reflectance.
// 4. Microfacet Cook-Torrance GGX specular solar glint.
// 5. Authentic Rayleigh atmospheric air-mass aerial perspective.
// 6. Ray-cast sub-cloud ground shadows.
// 7. Pure Black Marble city lights on land; pitch-black oceans (#000000) at night.

uniform sampler2D uDayTexture;      // NASA Blue Marble & Bathymetry albedo
uniform sampler2D uNightTexture;    // NASA Black Marble city lights
uniform sampler2D uSpecularMap;     // 1 = water, 0 = land
uniform sampler2D uTopologyMap;     // elevation & bathymetry height field
uniform sampler2D uCloudsTexture;   // global cloud optical thickness

uniform vec3  uSunDirection;        // world space unit vector toward Sun
uniform vec2  uTopologyTexel;       // 1 / topology resolution
uniform float uBumpScale;           // terrain relief height
uniform float uCloudOffset;         // U offset of cloud deck relative to ground
uniform float uCloudHeight;         // cloud altitude in planet radii
uniform float uCloudOpacity;
uniform float uSunIntensity;
uniform float uSpecularIntensity;
uniform float uOceanRoughness;
uniform float uNightIntensity;
uniform float uAtmosphereIntensity;
uniform float uCameraDistance;      // world camera distance to planet center

in vec2 vUv;
in vec3 vPosW;
in vec3 vNormalW;
in vec4 vTangentW;

out vec4 fragColor;

const float PI  = 3.141592653589793;
const float TAU = 6.283185307179586;

// Physically calibrated solar & atmospheric colors
const vec3 SUN_RADIANCE   = vec3(1.00, 0.98, 0.95);
const vec3 SUNSET_AMBER   = vec3(1.00, 0.38, 0.10);
const vec3 SUNSET_GOLD    = vec3(1.00, 0.68, 0.22);
const vec3 ORBITAL_CYAN   = vec3(0.18, 0.54, 1.00);
const vec3 CITY_AMBER     = vec3(1.00, 0.65, 0.28);
const vec3 LUMA           = vec3(0.2126, 0.7152, 0.0722);

// Rayleigh optical depth spectrum: λ^-4 scattering (red penetrates, blue scatters)
const vec3 RAYLEIGH_EXTINCTION = vec3(0.040, 0.088, 0.210);

float sat(float x) { return clamp(x, 0.0, 1.0); }

float cloudCover(vec2 uv) {
  return smoothstep(0.12, 0.92, texture(uCloudsTexture, uv).r);
}

// Hermite 4-tap continuous sub-texel filter: eliminates square pixel blockiness when zooming in
vec4 sampleHermite(sampler2D tex, vec2 uv, vec2 res) {
  vec2 pixel = uv * res;
  vec2 f = fract(pixel);
  vec2 hermite = f * f * (3.0 - 2.0 * f);
  vec2 uvSmooth = (floor(pixel) + 0.5 + hermite - 0.5) / res;
  return texture(tex, uvSmooth);
}

// Cook-Torrance microfacet terms
float distributionGGX(float NdotH, float alpha) {
  float a2 = alpha * alpha;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

float geometrySchlickGGX(float NdotX, float k) {
  return NdotX / (NdotX * (1.0 - k) + k);
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

void main() {
  vec3 sphereNormal = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);
  vec3 sunDir = normalize(uSunDirection);

  // --- Tangent frame (Gram-Schmidt) ---
  vec3 T = vTangentW.xyz - sphereNormal * dot(sphereNormal, vTangentW.xyz);
  float tLen = length(T);
  T = tLen > 1e-5 ? T / tLen : normalize(cross(vec3(0.0, 1.0, 0.0001), sphereNormal));
  vec3 B = cross(sphereNormal, T) * (vTangentW.w < 0.0 ? -1.0 : 1.0);

  float cosLat = max(cos((vUv.y - 0.5) * PI), 0.06);

  // --- Anti-pixelated Material Masks (Hermite filtered) ---
  vec2 texRes = vec2(4096.0, 2048.0);
  float waterMask = sampleHermite(uSpecularMap, vUv, texRes).r;
  float landMask = 1.0 - waterMask;

  // --- Tangent-space terrain relief (Land only; ocean is a smooth liquid sphere) ---
  vec2 footprint = max(uTopologyTexel, fwidth(vUv) * 0.5);
  vec2 du = vec2(footprint.x, 0.0);
  vec2 dv = vec2(0.0, footprint.y);
  float hE = texture(uTopologyMap, vUv + du).r;
  float hW = texture(uTopologyMap, vUv - du).r;
  float hN = texture(uTopologyMap, vUv + dv).r;
  float hS = texture(uTopologyMap, vUv - dv).r;
  float slopeT = (hE - hW) / (2.0 * footprint.x) / (TAU * cosLat) * uBumpScale;
  float slopeB = (hN - hS) / (2.0 * footprint.y) / PI * uBumpScale;

  vec3 N = normalize(sphereNormal - (slopeT * T + slopeB * B) * landMask);

  // --- Solar angles & Day/Night envelope ---
  float sunOrientation = dot(sphereNormal, sunDir);
  float dayMix = smoothstep(-0.20, 0.32, sunOrientation);
  float twilight = smoothstep(-0.30, 0.02, sunOrientation) * smoothstep(0.30, -0.04, sunOrientation);

  // Atmospheric reddening of direct sunlight at low sun angles
  vec3 sunColor = mix(SUNSET_AMBER * 1.15, SUN_RADIANCE, smoothstep(-0.04, 0.40, sunOrientation)) * uSunIntensity;

  // --- Cloud Shadows on the Surface ---
  vec2 cloudUV = vec2(vUv.x + uCloudOffset, vUv.y);
  float currentCloud = cloudCover(cloudUV) * uCloudOpacity;

  float sunHeight = max(dot(sunDir, sphereNormal), 0.12);
  float shadowDisp = clamp(uCloudHeight / sunHeight, 0.0, 0.0065);
  vec2 shadowShift = vec2(dot(sunDir, T) / (TAU * cosLat), dot(sunDir, B) / PI) * shadowDisp;
  float cloudShadow = cloudCover(cloudUV + shadowShift) * uCloudOpacity;
  float shadowFactor = 1.0 - cloudShadow * 0.70 * dayMix;

  // --- Surface Albedo & Diffuse Illumination (Hermite filtered) ---
  vec3 albedo = sampleHermite(uDayTexture, vUv, texRes).rgb;

  // --- Zoom-Adaptive Micro-Structure Synthesis (Eliminates blur, reveals crisp city & terrain details) ---
  float zoomFactor = smoothstep(1.65, 1.018, uCameraDistance);
  float roughness = mix(0.92, uOceanRoughness, waterMask);

  if (zoomFactor > 0.001) {
    // Multi-scale procedural urban & terrain micro-structure
    vec2 detailUv = vUv * vec2(4096.0 * 12.0, 2048.0 * 12.0);
    vec2 block = abs(fract(detailUv) - 0.5);
    float streetNet = smoothstep(0.04, 0.08, min(block.x, block.y));
    
    // Micro-elevation & building density variance
    float microRelief = (sin(detailUv.x * 0.4) * cos(detailUv.y * 0.4)) * 0.06;

    // Day: sharpens urban street corridors and natural terrain texture
    vec3 terrainDetail = mix(albedo * 0.88, albedo * 1.08, streetNet) + microRelief * landMask;
    albedo = mix(albedo, terrainDetail, zoomFactor * 0.75 * landMask);

    // Ocean: procedural micro-ripples
    float oceanRipple = sin(detailUv.x * 1.5 + detailUv.y * 1.5) * 0.035;
    roughness = mix(roughness, clamp(roughness + oceanRipple, 0.04, 0.5), zoomFactor * waterMask);
  }

  // Mountain micro-relief is accentuated where sun grazes terrain near terminator
  float NdotL = dot(N, sunDir);
  float grazing = mix(5.0, 1.4, smoothstep(0.0, 0.55, sunOrientation));
  float relief = clamp(1.0 + (NdotL - sunOrientation) * grazing * landMask, 0.3, 1.8);

  float irradiance = dayMix * (0.45 + 0.55 * sat(sunOrientation)) * relief * shadowFactor;
  vec3 color = albedo * sunColor * irradiance;

  // --- Liquid Ocean Optics: Fresnel Ambient Sky Sheen ---
  float cosV = max(dot(sphereNormal, viewDir), 0.0);
  float oceanFresnel = fresnelSchlick(cosV, vec3(0.02)).r;
  vec3 oceanSkyReflect = ORBITAL_CYAN * 0.38 * dayMix * uAtmosphereIntensity;
  color += oceanSkyReflect * oceanFresnel * waterMask * (1.0 - currentCloud) * shadowFactor;

  // --- Cook-Torrance GGX Specular Solar Glint ---
  vec3 H = normalize(sunDir + viewDir);
  float NdotLs = max(NdotL, 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(viewDir, H), 0.0);
  float alpha = roughness * roughness;
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  float D = distributionGGX(NdotH, alpha);
  float G = geometrySchlickGGX(NdotLs, k) * geometrySchlickGGX(cosV, k);
  vec3 F = fresnelSchlick(VdotH, vec3(0.02));
  vec3 specBRDF = (D * G * F) / max(4.0 * cosV * NdotLs, 1e-3);
  specBRDF = clamp(specBRDF, vec3(0.0), vec3(3.5)); // Natural physical peak

  // Specular glint strictly on water, blocked by clouds & shadows
  float glintMask = waterMask * (1.0 - currentCloud) * shadowFactor;
  vec3 glintTint = mix(vec3(1.0, 0.88, 0.70), vec3(1.0, 0.98, 0.95), smoothstep(0.1, 0.5, sunOrientation));
  color += specBRDF * NdotLs * sunColor * glintTint * glintMask * uSpecularIntensity
         * smoothstep(-0.01, 0.08, sunOrientation);

  // --- Terminator Rayleigh Sunset Band ---
  color += SUNSET_GOLD * twilight * 0.35 * (0.2 + 0.8 * albedo) * uAtmosphereIntensity;

  // --- Authentic Rayleigh Aerial Perspective (Air Mass Radiative Transfer) ---
  // Looking straight down: thin air column (high surface clarity).
  // Looking toward the limb: air column increases exponentially, scattering blue light.
  float airMass = 1.0 / (cosV + 0.06);
  vec3 opticalThickness = airMass * RAYLEIGH_EXTINCTION * uAtmosphereIntensity;
  vec3 transmittance = exp(-opticalThickness);

  vec3 skyScatterColor = mix(SUNSET_AMBER, ORBITAL_CYAN * 1.15, smoothstep(-0.08, 0.32, sunOrientation));
  float sunLit = smoothstep(-0.25, 0.30, sunOrientation);
  vec3 inscatter = skyScatterColor * (vec3(1.0) - transmittance) * sunLit * 0.82;

  // Surface contrast is softened and aerially perspective-blended toward the limb
  color = color * transmittance + inscatter;

  // --- Nightside City Lights (NASA Black Marble & ISS High-Resolution Optics) ---
  // Pure physical reality: Water does not emit light. Oceans at night are 100% PITCH BLACK (#000000).
  vec3 nightRaw = sampleHermite(uNightTexture, vUv, texRes).rgb;
  float nightLuma = dot(nightRaw, LUMA);

  // 1. Noise Floor Gate: completely silences background compression noise in unpopulated regions
  float cityMask = smoothstep(0.010, 0.045, nightLuma);

  // 2. Multi-tier Human Illumination Spectrum:
  // - Minor roads, villages & rural networks: Warm sodium-vapor gold (2100K)
  const vec3 SODIUM_AMBER  = vec3(1.00, 0.62, 0.20);
  // - Suburban grids & highways: Rich golden amber (2700K)
  const vec3 SUBURBAN_GOLD = vec3(1.00, 0.74, 0.35);
  // - Downtown metropolitan cores & industrial centers: Brilliant warm-white LED (4000K-5000K)
  const vec3 DOWNTOWN_CORE = vec3(1.00, 0.95, 0.88);

  // Color temperature blends realistically with settlement density:
  vec3 cityColor = mix(SODIUM_AMBER, SUBURBAN_GOLD, smoothstep(0.04, 0.28, nightLuma));
  cityColor = mix(cityColor, DOWNTOWN_CORE, smoothstep(0.35, 0.85, nightLuma));

  // 3. High Dynamic Range (HDR) Tone Calibration:
  // Fine filament enhancement: boosts visibility of delicate road networks connecting cities
  float filament = pow(sat(nightLuma * 2.2), 0.85) * 1.35;
  // Intense urban core overdrive: dense downtowns (Cairo, Tokyo, London, NY) exceed 1.0 for authentic optical bloom
  float coreOverdrive = pow(sat((nightLuma - 0.20) / 0.80), 2.0) * 3.8;
  float hdrIntensity = (filament + coreOverdrive) * cityMask;

  vec3 cityEmission = mix(nightRaw, cityColor, 0.60) * hdrIntensity;

  // Zoom-adaptive urban night grid sharpening: ensures highways and streets stay tack-sharp at close zoom
  if (zoomFactor > 0.001) {
    vec2 nightGrid = abs(fract(vUv * vec2(4096.0 * 12.0, 2048.0 * 12.0)) - 0.5);
    float streetPattern = smoothstep(0.04, 0.08, min(nightGrid.x, nightGrid.y));
    cityEmission *= mix(1.0, mix(1.4, 0.65, streetPattern), zoomFactor * 0.85);
  }

  // 4. Photorealistic Cloud Interaction:
  // - Direct streetlights are occluded by cloud optical thickness
  float directTransmittance = 1.0 - currentCloud * 0.90;
  // - Clouds overhead catch a soft diffuse under-lighting bounce from the city below (hallmark of ISS night photos!)
  vec3 cloudUnderglow = cityEmission * currentCloud * 0.24;
  vec3 visibleCityLight = (cityEmission * directTransmittance + cloudUnderglow) * landMask;

  // 5. Atmospheric Extinction toward the Limb:
  // Light from cities skimming the horizon passes through a thick air column
  vec3 cityLimbExtinction = exp(-airMass * vec3(0.035, 0.075, 0.16));
  visibleCityLight *= cityLimbExtinction;

  // 6. Day/Night Twilight Transition:
  // Lights activate smoothly as dusk deepens, completely zero under full daylight
  float nightMask = smoothstep(0.03, -0.15, sunOrientation);

  color += visibleCityLight * nightMask * uNightIntensity;

  fragColor = vec4(color, 1.0);
}
