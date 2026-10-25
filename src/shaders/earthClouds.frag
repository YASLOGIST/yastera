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
uniform float uLayerMode;   // 0 = low/mid deck from texture, 1 = high cirrus (procedural)

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
const vec3 AMBIENT_SKY  = vec3(0.42, 0.52, 0.72);

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(uSunDirection);
  vec3 p = normalize(vLocalPos);

  float cosLat = max(cos((vUv.y - 0.5) * 3.14159265), 0.08);
  float zoom = 1.0 - smoothstep(1.010, 1.50, uCameraDistance);
  float sunUp = dot(N, L);
  float day = smoothstep(-0.055, 0.10, sunUp);

  float density;
  float relief = uCloudRelief;
  // Advected coverage-map coordinate, kept for the relief pass below. It is the
  // same coordinate the density came from, and cloudAdvect is not free.
  vec2 troposphereUv = vec2(0.0);

  if (uLayerMode > 0.5) {
    // --- High cirrus deck ---------------------------------------------------
    // Cirrus is not a separate weather system, it is the anvil of the systems
    // already in the coverage map, seen from above: same shapes, advected
    // faster (upper winds are stronger) and thresholded hard so only the tops
    // of the deep systems reach this altitude.
    //
    // Generating it procedurally instead — as an earlier version did — cannot
    // work: noise has no large-scale structure, so the deck came out as either
    // uniform grey sheets or long parallel scratches. Reusing the map costs a
    // single texture fetch and guarantees the deck is organised the same way
    // the troposphere is, which is the whole visual point of a second layer.
    vec2 cirrusUv = cloudAdvect(vUv * uCloudScale + uCloudOffset, uCloudTime, uCloudDrift * uDriftScale);
    float raw = texture(uCloudsTexture, cirrusUv).r;

    // Fine structure, but at a frequency the map can actually resolve. An
    // earlier 110x55 tap aliased into scratch marks across the whole disc,
    // because at orbital scale one pixel already spans several cells of it.
    float fibre = valueNoise(cirrusUv * vec2(26.0, 14.0) + vec2(uTime * 0.004, 0.0));
    float body = smoothstep(0.46, 0.86, raw);
    density = body * (0.55 + 0.45 * fibre);
    relief = 0.0;
  } else {
    // --- Tropospheric deck from the coverage map ----------------------------
    vec2 baseUv = vUv * uCloudScale + uCloudOffset;
    vec2 cuv = cloudAdvect(baseUv, uCloudTime, uCloudDrift * uDriftScale);
    troposphereUv = cuv;
    density = cloudDensity(uCloudsTexture, cuv);

    // --- Sub-texel filament detail -----------------------------------------
    // Evaluated on the sphere direction, so it is seamless in longitude and
    // free of polar pinching. Crucially it is weighted by how much cloud is
    // already there: unweighted, the erosion term is a +-0.3 additive field and
    // it paints noise over the half of the planet that has clear sky.
    // Clear sky costs a single texture fetch: the erosion below is weighted by
    // `presence`, so it can only ever modify a pixel that already has cloud,
    // and skipping it cannot change the result.
    float detailFade = 1.0 - smoothstep(0.0004, 0.0045, fwidth(vUv.x) * cosLat);
    if (detailFade > 0.01 && density > 0.002) {
      vec3 w = vEastW * (uTime * 0.0016) + vNorthW * (uTime * 0.0009);
      float macro = fbmSphere(normalize(p + w * 0.03), 46.0, 3.0);
      float micro = fbmSphere(normalize(p - w * 0.05), 190.0, 2.0);
      // Multiplicative, not additive. Adding noise to coverage is what makes a
      // deck look like TV static; modulating it keeps the map's large-scale
      // structure while letting billows and filaments appear inside it.
      float erosion = (macro - 0.5) * 0.34 + (micro - 0.5) * 0.12;
      float presence = smoothstep(0.02, 0.30, density);
      density = clamp(density * (1.0 + erosion * detailFade * presence * 1.6), 0.0, 1.0);
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
      vec2 sunUv = vec2(dot(L, vEastW), dot(L, vNorthW));
      float sunUvLen = length(sunUv);
      sunUv = sunUvLen > 1e-4 ? sunUv / sunUvLen : vec2(1.0, 0.0);
      float stepLen = 0.0016 + 0.0018 * zoom;
      float pack = 0.0;
      for (int i = 1; i <= 2; i += 1) {
        pack += cloudDensity(uCloudsTexture, cuv + sunUv * (stepLen * float(i)));
      }
      float burial = smoothstep(0.95, 2.10, pack);
      sunVisibility = mix(1.0, 0.62, burial);
    }
    // Thick cores read solid, thin edges read translucent and bright.
    float thickness = clamp(density * 1.25, 0.0, 1.0);
    float edgeGlow = pow(1.0 - thickness, 2.0);

    vec3 sunTint = atmosphereTransmittanceFrom(0.0022, sunUp);
    vec3 light = vec3(1.0, 0.985, 0.962) * uSunIntensity * sunTint;

    // Forward Mie scattering: the silver lining when the sun is behind a tower.
    // The cosine is between the arriving ray (-L) and the departing ray toward
    // the camera (V), so it is -dot(V, L). Passing dot(V, L) peaks the lobe on
    // the back-scattered face instead, which brightens every front-lit flank and
    // makes the real silver lining impossible to render.
    float phase = hgPhase(-dot(V, L), 0.62);

    vec3 scattered = CLOUD_ALBEDO * light * (
        wrapped * sunVisibility * 1.32
      + AMBIENT_SKY * 0.30 * (1.0 - 0.35 * thickness)
      + phase * 0.75 * edgeGlow
    );

    // Warm bounce from the sunlit air below the deck.
    scattered += CLOUD_ALBEDO * light * vec3(1.0, 0.74, 0.54) * 0.05 * thickness;
    fragColor = vec4(scattered, alpha);
  } else {
    // --- Cirrus ------------------------------------------------------------
    // Thin ice cloud barely shadows itself and scatters strongly forward, so it
    // is bright and almost unshaded, and simply fades out toward the limb.
    vec3 sunTint = atmosphereTransmittanceFrom(0.0041, sunUp);
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

  float cosV = clamp(dot(N, V), 1e-4, 1.0);
  vec3 viewT = atmosphereTransmittanceFrom(0.0022, cosV);
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
