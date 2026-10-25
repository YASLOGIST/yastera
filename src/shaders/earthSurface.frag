#include <common>
#include <logdepthbuf_pars_fragment>
// ---------------------------------------------------------------------------
// Planetary surface — fragment stage.
//
// The albedo map carries no baked lighting: relief, ocean optics, cloud shadows
// and atmospheric scattering are all solved here, per pixel.
//
//  1. Terrain relief from the SRTM/GEBCO height field (tangent-space normal).
//  2. Ocean: depth-dependent water body colour, Fresnel sky term, GGX sun
//     glitter broken up by travelling wind-sea slopes when zoomed in.
//  3. Cloud shadows projected from the advected cloud deck.
//  4. Physically-derived sunlight transmittance: atmospheric reddening through
//     the terminator and Rayleigh aerial perspective toward the limb.
//  5. Black Marble city emission with cloud occlusion and underglow.
// ---------------------------------------------------------------------------

uniform sampler2D uDayTexture;
uniform sampler2D uNightTexture;
uniform sampler2D uSpecularMap;
uniform sampler2D uTopologyMap;
uniform sampler2D uCloudsTexture;

uniform vec3  uSunDirection;
uniform float uSunIntensity;
uniform float uAtmosphereIntensity;
uniform vec2  uTopologyTexel;
uniform float uBumpScale;
uniform float uCloudTime;
uniform float uCloudDrift;
uniform float uCloudHeight;
uniform float uCloudOpacity;
uniform float uSpecularIntensity;
uniform float uOceanRoughness;
uniform float uNightIntensity;
uniform float uCameraDistance;
uniform float uTime;
uniform float uWaveStrength;
uniform float uDetailStrength;

in vec2 vUv;
in vec3 vPosW;
in vec3 vNormalW;
in vec4 vTangentW;

out vec4 fragColor;

const vec3  LUMA = vec3(0.2126, 0.7152, 0.0722);

float distributionGGX(float NdotH, float alpha) {
  float a2 = alpha * alpha;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

float geometrySchlick(float NdotX, float k) {
  return NdotX / max(NdotX * (1.0 - k) + k, 1e-5);
}

vec3 fresnelSchlick(float cosTheta, vec3 f0) {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = vUv;
  vec3 Ng = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(uSunDirection);

  float cosLat = max(cos((uv.y - 0.5) * PI), 0.06);
  float zoom = 1.0 - smoothstep(1.015, 1.55, uCameraDistance);

  // --- Tangent frame (Gram-Schmidt, robust at the poles) -------------------
  vec3 T = vTangentW.xyz - Ng * dot(Ng, vTangentW.xyz);
  float tLen = length(T);
  T = tLen > 1e-4 ? T / tLen : normalize(cross(vec3(0.0, 1.0, 0.0001), Ng));
  vec3 B = normalize(cross(Ng, T)) * (vTangentW.w < 0.0 ? -1.0 : 1.0);

  // --- Material masks ------------------------------------------------------
  float waterRaw = texture(uSpecularMap, uv).r;
  float water = smoothstep(0.30, 0.70, waterRaw);
  float land = 1.0 - water;

  // --- Height field --------------------------------------------------------
  // Height-field convention (see scripts/fetch-assets.mjs): 15 = abyssal
  // plain, 85 = shelf break at the coastline, 250 = highest peaks.
  float hGrey = texture(uTopologyMap, uv).r * 255.0;

  // --- Terrain relief (land only) -----------------------------------------
  vec2 texel = uTopologyTexel;
  float hE = texture(uTopologyMap, uv + vec2(texel.x, 0.0)).r * 255.0;
  float hW = texture(uTopologyMap, uv - vec2(texel.x, 0.0)).r * 255.0;
  float hN = texture(uTopologyMap, uv + vec2(0.0, texel.y)).r * 255.0;
  float hS = texture(uTopologyMap, uv - vec2(0.0, texel.y)).r * 255.0;
  vec2 relief = vec2(hE - hW, hN - hS) * 0.5;

  // 1 grey level of the height field is 8 km / 165 levels ~= 48 m; one texel at
  // the equator is 40075 km / 4096 ~= 9.8 km. Longitude spacing shrinks with
  // cos(lat), hence the division.
  vec2 landSlope = relief * (0.0049 / cosLat) * uBumpScale;

  // --- Wind-sea slope (visible only as the camera descends) ----------------
  // Two things have to be true for waves to look real and stay stable.
  //
  // First, amplitude rises with zoom: from orbit a 2 m swell is far below one
  // texel and contributes nothing but aliasing.
  //
  // Second — and this is what a naive wave function gets wrong — amplitude must
  // fall again once the *wavelength* approaches the pixel footprint. Otherwise
  // the highest-frequency trains of the sum turn into crawling sparkle noise the
  // moment the camera stops, and no amount of temporal smoothing fixes it
  // because it is a sampling failure, not a motion one.
  float waveFreq = mix(14.0, 1200.0, zoom * zoom);
  float waveLod = 1.0 - smoothstep(0.10, 0.45, fwidth(uv.x) * waveFreq);
  float waveAmp = mix(0.0, 0.22, zoom) * uWaveStrength * waveLod;
  vec2 seaSlope = windSeaSlope(uv, waveFreq, waveAmp, uTime);

  vec3 N = normalize(Ng - (landSlope.x * T + landSlope.y * B) * land);
  vec3 Ns = normalize(Ng - (seaSlope.x * T + seaSlope.y * B) * water);

  // --- Sunlight, reddened through the atmosphere ---------------------------
  float sunUp = dot(Ng, L);
  float day = smoothstep(-0.075, 0.11, sunUp);
  float nightMask = 1.0 - smoothstep(-0.14, 0.02, sunUp);

  vec3 sunTint = atmosphereTransmittanceFrom(0.0, sunUp);
  vec3 light = vec3(1.0, 0.978, 0.952) * uSunIntensity * sunTint;

  // --- Cloud deck: shadow projection --------------------------------------
  vec2 cloudUv = cloudAdvect(uv, uCloudTime, uCloudDrift);
  float cloud = cloudDensity(uCloudsTexture, cloudUv) * uCloudOpacity;

  float sunHeight = max(sunUp, 0.20);
  vec2 uvSun = vec2(dot(L, T) / (PI2 * cosLat), dot(L, B) / PI);
  // Two taps at different distances give a penumbra rather than a hard stencil:
  // near the terminator the shadow lengthens and softens, exactly as a low sun
  // stretches a cloud's shadow across the water.
  vec2 shadowShift = uvSun * (uCloudHeight / sunHeight) * 0.85;
  float shadowA = cloudShadowDepth(uCloudsTexture, cloudUv + shadowShift) * uCloudOpacity;
  float shadowB = cloudShadowDepth(uCloudsTexture, cloudUv + shadowShift * 2.1) * uCloudOpacity;
  float shadowTau = (shadowA * 0.72 + shadowB * 0.28) * 2.4;
  float shadowFactor = 1.0 - (1.0 - exp(-shadowTau)) * 0.86 * day;

  // --- Land albedo + zoom-adaptive micro detail ---------------------------
  vec3 landAlbedo = texture(uDayTexture, uv).rgb;

  // Screen footprint of one texel, in surface terms. Detail is added only while
  // a texel still covers more than a few pixels, otherwise it aliases.
  float texelFootprint = fwidth(uv.x) * cosLat;
  float detailFade = 1.0 - smoothstep(0.00025, 0.0030, texelFootprint);
  float detailAmount = zoom * uDetailStrength * detailFade;

  // Urban density straight from the Black Marble map: cities get street grids,
  // farmland gets fields, mountains get rock. This correlation is what sells the
  // descent — procedural noise alone reads as "texture", not as a place.
  float urban = smoothstep(0.02, 0.30, texture(uNightTexture, uv).r);

  if (detailAmount > 0.002) {
    vec3 sphereDir = normalize(vPosW);
    // Terrain: ridged multifractal, strength follows the height field.
    float elevation = smoothstep(85.0, 190.0, hGrey);
    float ridge = 1.0 - abs(fbmSphere(sphereDir, 220.0, 4.0) * 2.0 - 1.0);
    float grit = fbmSphere(sphereDir, 900.0, 3.0);
    landAlbedo *= mix(1.0, 0.78 + 0.30 * ridge + 0.12 * grit, detailAmount * land);

    // Vegetation patchwork / farmland mosaic.
    float fields = valueNoise(uv * vec2(5200.0, 2600.0));
    landAlbedo *= mix(1.0, 0.90 + 0.20 * fields, detailAmount * land * (1.0 - elevation) * 0.8);

    // City texture. A perfect lattice reads as a circuit board, so the blocks
    // are warped by noise, the road width varies, and only dense neighbourhoods
    // (not the whole metro footprint) show structure. This is aerial-photo
    // behaviour: bright roofs, dark streets, irregular grain.
    vec3 warpDir = sphereDir + vec3(
      valueNoise3(sphereDir * 60.0),
      valueNoise3(sphereDir * 60.0 + 31.7),
      valueNoise3(sphereDir * 60.0 + 71.3)) * 0.20;
    // A city block is ~200 m; one texel at 4096 px covers ~10 km at the
    // equator, so the lattice needs ~50 cells per texel to look street-sized.
    vec2 gridUv = warpDir.xy * 9000.0 + warpDir.zx * 3600.0;
    mat2 rotA = mat2(0.94, 0.34, -0.34, 0.94);
    mat2 rotB = mat2(0.77, -0.64, 0.64, 0.77);
    vec2 gA = abs(fract(rotA * gridUv) - 0.5);
    vec2 gB = abs(fract(rotB * gridUv * 0.62) - 0.5);
    float roadA = smoothstep(0.448, 0.499, max(gA.x, gA.y));
    float roadB = smoothstep(0.460, 0.499, max(gB.x, gB.y));
    float roads = max(roadA, roadB);

    // Neighbourhood mask: cities are lumpy, not a uniform carpet.
    float district = fbmSphere(sphereDir, 380.0, 2.0);
    float builtUp = smoothstep(0.30, 0.68, district) * urban;

    float blocks = fbmSphere(sphereDir, 420.0, 2.0);
    vec3 urbanTint = landAlbedo * (0.70 + 0.55 * blocks);
    urbanTint = mix(urbanTint, vec3(0.14, 0.13, 0.125), roads * 0.38);
    landAlbedo = mix(landAlbedo, urbanTint, detailAmount * builtUp * 1.0);
  }

  // --- Ocean albedo: depth-stratified water body --------------------------
  // Seawater is opaque to visible light within tens of metres, so from orbit
  // the open ocean is one uniform deep blue and carries no bathymetry at all —
  // the mid-ocean ridges, trenches and seamounts that dominate a bathymetric
  // map are simply not visible. Only the continental shelves, where the bottom
  // is within a few tens of metres of the surface, show any colour shift.
  //
  // An earlier version ramped hue across the whole depth range, which painted
  // a turquoise band along every mid-ocean ridge and made the Atlantic look
  // like a lagoon. The ramp below is therefore keyed to the *shelf* only:
  // the height field runs 15 = abyss to 85 = shelf break, so anything below
  // about 62 stays the same deep navy no matter how the map shades it.
  vec3 deepWater  = vec3(0.0080, 0.0230, 0.0520);
  vec3 shelfWater = vec3(0.0180, 0.0620, 0.0800);
  float shelf = smoothstep(62.0, 85.0, hGrey);
  vec3 waterAlbedo = mix(deepWater, shelfWater, shelf);

  // Wet sand: the last kilometre of coast is darker and less reflective.
  float wetBand = smoothstep(0.0, 0.30, water) * (1.0 - smoothstep(0.30, 0.72, water));
  landAlbedo *= 1.0 - wetBand * 0.22;

  // --- Diffuse term -------------------------------------------------------
  float NdotL = max(dot(N, L), 0.0);
  float NdotLs = max(dot(Ns, L), 0.0);

  vec3 albedo = mix(landAlbedo, waterAlbedo, water);
  vec3 color = albedo * light * NdotL * shadowFactor;

  // Hemispheric sky light — keeps the terminator from going flat black.
  vec3 skyAmbient = light * vec3(0.10, 0.16, 0.30) * 0.20;
  color += albedo * skyAmbient * smoothstep(-0.03, 0.22, sunUp);

  // --- Ocean: reflected sky -----------------------------------------------
  // Fresnel only says how much light is reflected; it says nothing about what
  // is being reflected. A constant tint therefore makes every sea the same blue
  // no matter where the sun is, which is the single clearest giveaway of a fake
  // ocean. Here the reflected ray is actually traced into an analytic sky:
  // zenith-to-horizon gradient, plus the forward Mie glow that puts a bright
  // patch under the sun.
  float cosV = clamp(dot(Ng, V), 1e-4, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  vec3 Rf = reflect(-V, Ns);
  float skyCos = clamp(dot(Rf, Ng), 0.0, 1.0);
  // Downwelling sky is deep blue overhead and pales toward the horizon, where
  // the view path is long enough to pick up aerosol.
  vec3 zenithSky  = vec3(0.045, 0.135, 0.380);
  vec3 horizonSky = vec3(0.400, 0.560, 0.860);
  vec3 skyRadiance = mix(horizonSky, zenithSky, pow(skyCos, 0.55));
  float sunGlow = pow(max(dot(Rf, L), 0.0), 8.0);
  skyRadiance += vec3(1.0, 0.86, 0.66) * sunGlow * 1.5;
  float waterVisible = water * (1.0 - cloud * 0.75);
  // Only the sunlit hemisphere has a sky to reflect: without this gate the
  // night oceans glow blue from reflected "daylight" that is not there.
  float skyGate = smoothstep(-0.09, 0.10, sunUp);
  color += skyRadiance * light * fresnel * waterVisible * shadowFactor * skyGate;

  // --- Ocean: GGX sun glitter ---------------------------------------------
  // Roughness widens with altitude: from orbit the glitter is a long anisotropic
  // path, at 50 km it collapses into individual sparkles.
  float rough = mix(0.30, max(uOceanRoughness, 0.03), smoothstep(1.02, 1.45, uCameraDistance));
  float alphaG = max(rough * rough, 0.0035);
  vec3 H = normalize(L + V);
  float NdotH = max(dot(Ns, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);
  float kk = (rough + 1.0) * (rough + 1.0) / 8.0;
  float D = distributionGGX(NdotH, alphaG);
  float G = geometrySchlick(NdotLs, kk) * geometrySchlick(cosV, kk);
  vec3 Fw = fresnelSchlick(VdotH, vec3(0.02));
  vec3 specular = (D * G * Fw) / max(4.0 * cosV * NdotLs, 1e-3);
  specular = min(specular, vec3(90.0));

  // A cloud shadow darkens the sun glitter too: a specular highlight without
  // the direct beam is light from nowhere, and it was visible as sparkling
  // water inside cloud shadows.
  float glintMask = waterVisible * smoothstep(0.0, 0.055, sunUp) * shadowFactor;
  vec3 glintTint = mix(vec3(1.0, 0.82, 0.60), vec3(1.0, 0.98, 0.94), smoothstep(0.02, 0.35, sunUp));
  color += specular * light * glintTint * glintMask * uSpecularIntensity;

  // --- Whitecaps ----------------------------------------------------------
  // Crests of the steepest waves break and entrain air. There is no wind field
  // to drive this, but the slope already computed is a fair proxy: steep water
  // *is* breaking water. Gated to close range — a whitecap is ~10 m across and
  // is pure noise from orbit.
  //
  // Note there is deliberately no white band painted along the coastline. An
  // earlier version drew one from the water mask, and because that mask is
  // 10 km per texel the band was ten kilometres wide on every shore on Earth:
  // it read as a bright cyan rim around every continent, which is exactly what
  // a coast does not look like from space. Surf is a hundred metres wide and
  // simply does not survive this texture resolution, so leaving it out is more
  // truthful than faking it at the wrong scale.
  if (zoom > 0.45) {
    float crest = clamp(length(seaSlope) * 2.4 - 0.55, 0.0, 1.0);
    float caps = fbm4(uv * vec2(7600.0, 3800.0) + vec2(uTime * 0.018, uTime * 0.004));
    float foam = smoothstep(0.52, 0.90, crest * (0.45 + caps)) * smoothstep(0.45, 0.90, zoom);
    color = mix(color, vec3(0.90, 0.93, 0.97) * light * NdotLs, foam * water * 0.75);
  }

  // --- Night side: Black Marble city emission -----------------------------
  vec3 nightTex = texture(uNightTexture, uv).rgb;
  float lum = dot(nightTex, LUMA);
  float gate = smoothstep(0.010, 0.14, lum);
  vec3 cityColor = mix(vec3(1.0, 0.55, 0.20), vec3(1.0, 0.90, 0.74), smoothstep(0.05, 0.55, lum));
  vec3 cityEmission = cityColor * (lum * 0.85 + lum * lum * 3.2) * gate * land;
  vec3 cityVisible = cityEmission * (1.0 - cloud * 0.90)
                   + cityEmission * cloud * 0.22;   // cloud underglow (ISS photo look)
  color += cityVisible * uNightIntensity * nightMask;

  // --- Rayleigh aerial perspective ---------------------------------------
  // The atmosphere adds its own radiance on top of the surface, and that
  // addition is never zero: even looking straight down, roughly a sixth of the
  // light that leaves the ground is scattered air rather than ground. Modelling
  // only the *extra* air mass toward the limb (the obvious reading of
  // `airmass - 1`) therefore leaves the ocean at the disc centre at true
  // surface colour, which is nearly black — and no photograph of Earth from
  // space has ever looked like that.
  //
  // So the term is the full path in-scattering. The coefficient folds in
  // aerosol and multiple scattering, which is why it is larger than a naive
  // single-scatter optical depth would be.
  float airMass = relativeAirMass(cosV);
  float haze = 1.0 - exp(-airMass * 0.16);
  vec3 sunPath = atmosphereTransmittanceFrom(0.0, sunUp);

  // Twilight: the air column is still sunlit after the ground has gone dark.
  float twilight = smoothstep(-0.16, 0.005, sunUp) * (1.0 - smoothstep(0.005, 0.085, sunUp));
  vec3 hazeTint = mix(vec3(0.34, 0.55, 1.00), vec3(1.00, 0.36, 0.10), twilight * 0.8);

  // The airlight closer to the camera is not the same colour as the airlight
  // along the sun path: that is what makes a real limb warm on the sun side and
  // cool on the far side instead of a uniform blue ring. Mix toward the low-sun
  // colour as the view approaches the terminator.
  float viewTwilight = smoothstep(-0.10, 0.14, sunUp) * (1.0 - smoothstep(0.14, 0.42, sunUp));
  hazeTint = mix(hazeTint, vec3(0.86, 0.52, 0.34), viewTwilight * 0.35);

  float hazeAmount = haze * 0.62 * smoothstep(-0.09, 0.09, sunUp) * uAtmosphereIntensity;
  color = color * (1.0 - hazeAmount * 0.55) + hazeAmount * hazeTint * sunPath * 0.9;

  fragColor = vec4(color, 1.0);
}
