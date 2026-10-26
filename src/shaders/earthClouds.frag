#include <common>
#include <logdepthbuf_pars_fragment>
// ---------------------------------------------------------------------------
// Cloud deck — fragment stage.
//
// A cloud top seen from orbit is one of the brightest surfaces in the scene:
// a thick cumulus deck reflects ~85 % of the light that hits it. The failure
// mode of cheap cloud shaders is the opposite — grey, translucent smoke —
// because every term gets multiplied together and nothing ever reaches white.
// The lighting below is therefore built from the physics of a thick scattering
// slab, in this order:
//
//  • Radiance comes from the slab's reflectance (1 - e^-tau), not from a
//    wrapped N·L. A cloud top in full sun goes to white; only the terminator
//    and genuine shadowing are allowed to darken it.
//  • Shape comes from the density gradient: the normal is tilted across each
//    cloud so its sunward flank lights up and its far flank rolls off. This is
//    what makes a flat texture read as a field of towers.
//  • Shadows come from a short march toward the sun. Only a *buried* pixel is
//    dimmed — an isolated cumulus is the highest thing around, so it stays in
//    full sun. Marching straight into every neighbour greys the whole deck.
//  • The terminator reddens the deck through the same transmittance curve the
//    surface uses, so ground and cloud agree about where dusk is.
// ---------------------------------------------------------------------------

uniform sampler2D uCloudsTexture;
uniform vec3  uSunDirection;
uniform float uSunIntensity;
uniform float uCloudOpacity;
uniform float uCloudRelief;
uniform float uAtmosphereIntensity;
uniform float uCameraDistance;
uniform float uCloudTime;
uniform float uCloudDrift;
uniform float uDriftScale;
uniform float uTime;
uniform vec2  uCloudScale;
uniform vec2  uCloudOffset;
uniform float uLayerAlpha;
uniform float uLayerMode;   // 0 = shaped cloud deck, 1 = high ice veil
uniform float uCloudDetail;
uniform float uLightningIntensity;

in vec2 vUv;
in vec3 vPosW;
in vec3 vNormalW;
in vec3 vCenterW;
in vec3 vEastW;
in vec3 vNorthW;
in vec3 vLocalPos;

out vec4 fragColor;

// Droplet reflectance: fresh cloud is very nearly white, a touch cool.
const vec3 CLOUD_ALBEDO = vec3(1.0, 1.0, 1.0);
// Skylight filling the shadowed flanks. Real cumulus shade is blue-grey, not
// black, and never falls much below 60 % of the sunlit value.
const vec3 AMBIENT_SKY  = vec3(0.48, 0.58, 0.76);

// Geographic east in the globe's local frame. Keeping procedural detail in
// this frame prevents it from sliding as the entire Earth rotates in world space.
vec3 eastTangent(vec3 dir) {
  vec3 east = cross(vec3(0.0, 1.0, 0.0), dir);
  float len = length(east);
  return len > 1e-5 ? east / len : normalize(cross(vec3(1.0, 0.0, 0.0), dir));
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(uSunDirection);
  vec3 p = normalize(vLocalPos);

  float zoom = 1.0 - smoothstep(1.010, 1.50, uCameraDistance);
  float sunUp = dot(N, L);
  float day = smoothstep(-0.055, 0.10, sunUp);
  float altitude = max(length(vPosW - vCenterW) - 1.0, 0.0);

  float density;
  float relief = uCloudRelief;
  // Advected coverage-map coordinate, kept for the relief pass below. It is the
  // same coordinate the density came from, and cloudAdvect is not free.
  vec2 troposphereUv = vec2(0.0);

  if (uLayerMode > 0.5) {
    // --- Upper ice veil -----------------------------------------------------
    // The upper layer is constrained to denser systems in the same coverage
    // map as the main deck. A different longitude phase invents unrelated
    // weather and makes the two layers visibly slide across one another.
    vec2 cirrusUv = cloudAdvect(vUv * uCloudScale + uCloudOffset, uCloudTime, uCloudDrift * uDriftScale);
    float raw = cloudDensity(uCloudsTexture, cirrusUv);

    // Dense convective cores seed the high veil; a weaker shoulder represents
    // thin outflow around anvils instead of a second, opaque copy of the deck.
    float core = smoothstep(0.48, 0.86, raw);
    float anvil = smoothstep(0.30, 0.62, raw) * (1.0 - core * 0.42);
    density = clamp(core * 0.62 + anvil * 0.30, 0.0, 1.0);

    // Spherical ice filaments are high-frequency and only appear when their
    // footprint is resolved. At orbital scale the weather map carries the form.
    float fibreFootprint = length(fwidth(p)) * 240.0;
    float detailAmount = clamp(uCloudDetail, 0.0, 1.5);
    float fibreFade = (1.0 - smoothstep(0.55, 1.15, fibreFootprint)) * zoom * detailAmount;
    if (fibreFade > 0.01 && density > 0.002) {
      vec3 eastLocal = eastTangent(p);
      vec3 northLocal = normalize(cross(p, eastLocal));
      vec3 windOffset = eastLocal * (uTime * 0.0006) + northLocal * (uTime * 0.0002);
      float structure = fbmSphere(normalize(p + windOffset * 0.025), 240.0, 3.0);
      density *= mix(1.0, 0.72 + 0.56 * structure, fibreFade);
    }
    relief = 0.0;
  } else {
    // --- Tropospheric cloud tops from the coverage map ----------------------
    vec2 baseUv = vUv * uCloudScale + uCloudOffset;
    vec2 cuv = cloudAdvect(baseUv, uCloudTime, uCloudDrift * uDriftScale);
    troposphereUv = cuv;
    density = cloudDensity(uCloudsTexture, cuv);

    // --- Screen-space cloud structure --------------------------------------
    // fBm lives on the unit sphere, not the UV map, so it has no longitude seam
    // or polar pinch. Its frequencies are independently filtered by pixel
    // footprint to avoid shimmer as the camera moves through the orbital view.
    float pixelFootprint = length(fwidth(p));
    float macroFootprint = pixelFootprint * 120.0;
    float microFootprint = pixelFootprint * 360.0;
    float detailScale = clamp(uCloudDetail, 0.0, 1.5);
    float macroFade = (1.0 - smoothstep(0.55, 1.20, macroFootprint)) * detailScale;
    float microFade = (1.0 - smoothstep(0.55, 1.20, microFootprint)) * detailScale;

    // The weather map stores fractional cover. Keep that average in orbit, but
    // resolve it into opaque cloud puffs and clear gaps on descent, where a
    // translucent grey sheet would look like smoke instead of a cloud body.
    if ((macroFade > 0.01 || microFade > 0.01) && density > 0.002) {
      vec3 eastLocal = eastTangent(p);
      vec3 northLocal = normalize(cross(p, eastLocal));
      vec3 w = eastLocal * (uTime * 0.0016) + northLocal * (uTime * 0.0009);
      float macro = fbmSphere(normalize(p + w * 0.03), 120.0, 3.0);
      float micro = fbmSphere(normalize(p - w * 0.05), 360.0, 2.0);

      float meanCoverage = density;
      float presence = smoothstep(0.02, 0.25, meanCoverage);
      float erosion = (macro - 0.5) * 0.30 * macroFade
                    + (micro - 0.5) * 0.11 * microFade;
      float detailedCoverage = clamp(meanCoverage * (1.0 + erosion * presence * 1.35), 0.0, 1.0);

      // Approximate a coverage-preserving realization of fractional cells. The
      // mapping is disabled in orbit and fades in smoothly as individual cloud
      // forms become resolvable from the camera.
      float cloudNoise = smoothstep(0.28, 0.72, mix(macro, micro, 0.32));
      float threshold = 1.0 - meanCoverage;
      float resolvedCoverage = smoothstep(threshold - 0.12, threshold + 0.12, cloudNoise);
      float resolveAmount = clamp(zoom * 0.62 * smoothstep(0.02, 0.15, meanCoverage) * detailScale, 0.0, 1.0);
      density = mix(detailedCoverage, resolvedCoverage, resolveAmount);
    }

  }

  float alpha = density * uCloudOpacity * uLayerAlpha;
  if (alpha < 0.004) discard;

  float sunVisibility = 1.0;

  if (relief > 0.0) {
    // --- Shape from coverage gradients --------------------------------------
    // The slope of the cloud top, in the east/north tangent plane, recovered
    // from screen-space derivatives. Five texture taps would give the same
    // answer and cost every fragment on the deck, so the rasteriser's
    // derivatives are used instead — but they have to be converted, not just
    // used directly.
    //
    // dFdx(density) is the change per *screen* pixel. Treating it as
    // "change toward east" is only correct for a camera looking straight down
    // with north up; at the limb, screen-y is radial and the normal ends up
    // pointing in a direction that has nothing to do with the cloud's slope,
    // and the shading of a given cloud shifts as the camera orbits. The
    // screen-to-tangent Jacobian fixes it exactly:
    //
    //   dot(grad, dPdx) = dDdx      with grad = a * East + b * North
    //   dot(grad, dPdy) = dDdy
    //
    // Two equations, two unknowns, no extra fetches.
    vec3 dPdx = dFdx(vPosW);
    vec3 dPdy = dFdy(vPosW);
    float dDdx = dFdx(density);
    float dDdy = dFdy(density);
    float a11 = dot(vEastW, dPdx);
    float a12 = dot(vNorthW, dPdx);
    float a21 = dot(vEastW, dPdy);
    float a22 = dot(vNorthW, dPdy);
    float det = a11 * a22 - a12 * a21;

    // One coverage texel in world units. Used to express the gradient as a
    // rise-per-texel, which is scale-free: a cliff and a gentle swell are then
    // told apart by their slope, not by the zoom level.
    const float TAU = 6.2831853;
    float texelWorld = TAU / (4096.0 * max(uCloudScale.x, 1e-3));

    vec2 tilt = vec2(0.0);
    if (abs(det) > 1e-14) {
      float invDet = 1.0 / det;
      float gEast = (dDdx * a22 - a12 * dDdy) * invDet;
      float gNorth = (a11 * dDdy - dDdx * a21) * invDet;
      tilt = clamp(vec2(gEast, gNorth) * texelWorld * relief, -1.5, 1.5);
    }
    // The normal leans away from the rising edge: where coverage climbs toward
    // the east, the cloud top faces west.
    vec3 Np = normalize(N - tilt.x * vEastW - tilt.y * vNorthW);

    float NdotL = dot(Np, L);
    // Light wraps a little around the puffs; a harsh Lambert term makes a
    // cloud field look like a cauliflower of black holes.
    float wrapped = clamp((NdotL + 0.42) / 1.42, 0.0, 1.0);

    // --- Burial shadow: is this pixel inside a dense field? -----------------
    // Only dense cores march, which keeps clear sky and the thin veil free.
    sunVisibility = 1.0;
    if (density > 0.35) {
      vec2 cuv = troposphereUv;
      float latitude = (vUv.y - 0.5) * PI;
      float cosLatitude = max(cos(latitude), 0.06);
      vec2 sunTangent = vec2(dot(L, vEastW), dot(L, vNorthW));
      float sunTangentLength = max(length(sunTangent), 1e-4);
      // Convert a physical angular march into equirectangular UV units. One
      // unit of longitude is 2π cos(latitude) times wider than one unit of
      // latitude; treating both UV axes equally skews shadowing by up to 2×.
      vec2 sunUvPerRadian = vec2(
        sunTangent.x / (sunTangentLength * PI2 * cosLatitude),
        sunTangent.y / (sunTangentLength * PI)
      );
      float stepAngle = 0.0013 + 0.0015 * zoom;
      float pack = 0.0;
      for (int i = 1; i <= 3; i += 1) {
        pack += cloudDensity(uCloudsTexture, cuv + sunUvPerRadian * (stepAngle * float(i)));
      }
      float burial = smoothstep(1.15, 2.45, pack);
      sunVisibility = mix(1.0, 0.56, burial);
    }
    // Thick cores read solid, thin edges read translucent and bright.
    float thickness = clamp(density * 1.25, 0.0, 1.0);
    float edgeGlow = pow(1.0 - thickness, 2.0);

    vec3 sunTint = atmosphereTransmittanceFrom(altitude, sunUp);
    vec3 light = vec3(1.0, 0.985, 0.962) * uSunIntensity * sunTint;

    // Forward Mie scattering: the silver lining when the sun is behind a tower.
    // The cosine is between the arriving ray (-L) and the departing ray toward
    // the camera (V), so it is -dot(V, L). Passing dot(V, L) peaks the lobe on
    // the back-scattered face instead, which brightens every front-lit flank and
    // makes the real silver lining impossible to render.
    float phase = hgPhase(-dot(V, L), 0.62);

    vec3 scattered = CLOUD_ALBEDO * light * (
        wrapped * sunVisibility * 1.32
      // Multiple scattering brightens thick interiors instead of turning them
      // into flat grey discs; blue skylight still colours the shadowed flanks.
      + AMBIENT_SKY * (0.30 + 0.22 * thickness)
      + phase * 0.75 * edgeGlow
    );

    // Warm bounce from the sunlit air below the deck.
    scattered += CLOUD_ALBEDO * light * vec3(1.0, 0.74, 0.54) * 0.05 * thickness;
    fragColor = vec4(scattered, alpha);
  } else {
    // --- Cirrus ------------------------------------------------------------
    // Thin ice cloud barely shadows itself and scatters strongly forward, so it
    // is bright and almost unshaded, and simply fades out toward the limb.
    vec3 sunTint = atmosphereTransmittanceFrom(altitude, sunUp);
    vec3 light = vec3(1.0, 0.985, 0.965) * uSunIntensity * sunTint;
    float phase = hgPhase(-dot(V, L), 0.55);
    float edge = pow(1.0 - clamp(density, 0.0, 1.0), 1.6);
    vec3 scattered = CLOUD_ALBEDO * light * (0.86 + phase * 1.1 * edge);
    fragColor = vec4(scattered, alpha);
  }

  // --- Night side and aerial perspective (shared) ---------------------------
  vec3 color = fragColor.rgb;
  float nightMask = 1.0 - smoothstep(-0.13, 0.015, sunUp);
  // City underglow lighting the cloud bases from below: the pink-orange haze
  // that makes ISS night passes recognisable.
  vec3 nightGlow = vec3(1.0, 0.46, 0.16) * 0.035 * (1.0 - density * 0.5);
  color = mix(nightGlow, color, day);
  color *= mix(1.0, 0.70, nightMask);

  // Rare, localized intra-cloud flashes: deterministic per advected weather
  // cell, gated to dense storm cores and the night side. The soft spatial falloff
  // avoids square cell edges; this is a diffuse cloud flash, not a fake surface bolt.
  if (uLayerMode < 0.5 && uLightningIntensity > 0.001 && nightMask > 0.01 && density > 0.60) {
    vec2 stormUv = vec2(fract(troposphereUv.x), clamp(troposphereUv.y, 0.001, 0.999));
    vec2 stormGrid = vec2(256.0, 128.0);
    vec2 cell = floor(stormUv * stormGrid);
    vec2 local = fract(stormUv * stormGrid);
    float seed = hash12(cell + vec2(23.7, 61.9));
    float offset = hash12(cell + vec2(11.3, 47.1));
    float eventClock = uTime * 0.2 + offset;
    float eventCycle = floor(eventClock);
    float eventPhase = fract(eventClock);
    float eventChance = hash12(cell + vec2(eventCycle * 17.1 + 3.7, eventCycle * 29.7 + 11.3));
    float event = step(0.98, eventChance);
    float pulse = exp(-eventPhase * 80.0)
                + 0.45 * exp(-abs(eventPhase - 0.035) * 100.0);
    vec2 flashCenter = vec2(seed, hash12(cell + vec2(71.3, 19.7)));
    float flashArea = 1.0 - smoothstep(0.18, 0.48, length(local - flashCenter));
    float stormCore = smoothstep(0.62, 0.88, density);
    float flash = event * pulse * flashArea * stormCore * uLightningIntensity;
    color += vec3(0.54, 0.72, 1.0) * flash * 0.72;
  }

  float cosV = clamp(dot(N, V), 1e-4, 1.0);
  vec3 viewT = atmosphereTransmittanceFrom(altitude, cosV);
  vec3 hazeColor = vec3(0.30, 0.52, 0.92) * uSunIntensity * 0.30 * uAtmosphereIntensity;
  color = color * viewT + hazeColor * (vec3(1.0) - viewT) * smoothstep(-0.06, 0.2, sunUp);

  // At night the deck still occludes city light, so the alpha floor is higher
  // than by day.
  float nightAlpha = mix(0.72, 1.0, day);
  float zoomThin = mix(0.62, 1.0, smoothstep(1.015, 1.16, uCameraDistance));
  // A cell that is 70 % covered is 70 % covered on average, but the cloud in it
  // is solid: the remaining 30 % is open sky *beside* the cloud, not darkness
  // *through* it. So the top of the range is pushed to fully opaque while the
  // thin tail is left alone. A power curve over the whole range would do the
  // first and ruin the second, which is how the deck ended up as grey film.
  alpha = clamp(alpha + smoothstep(0.45, 0.95, alpha) * 0.45, 0.0, 1.0) * nightAlpha * zoomThin;

  fragColor = vec4(color, alpha);
}
