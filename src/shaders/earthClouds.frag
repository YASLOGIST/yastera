#include <common>
#include <logdepthbuf_pars_fragment>
// ---------------------------------------------------------------------------
// Cloud deck — fragment stage.
//
// A single shell lit like a participating medium rather than a white sprite:
//
//  • Normal from the density gradient (analytic tangent frame), so cumulus
//    tops catch the sun and the bases fall into shadow.
//  • Sun-direction tap marching = self-shadowing; thick cores go grey-blue,
//    thin edges glow (powder / silver lining).
//  • Forward Mie phase: clouds backlit by the sun flare along their rims.
//  • Sunlight is transmitted through the atmosphere, so the deck reddens
//    correctly along the terminator and stays dark on the night side.
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

const vec3 CLOUD_ALBEDO = vec3(0.96, 0.975, 1.0);
const vec3 AMBIENT_SKY  = vec3(0.12, 0.21, 0.40);

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(uSunDirection);

  float cosLat = max(cos((vUv.y - 0.5) * 3.14159265), 0.08);
  float zoom = 1.0 - smoothstep(1.010, 1.50, uCameraDistance);

  vec2 baseUv = vUv * uCloudScale + uCloudOffset;
  vec2 cuv = cloudAdvect(baseUv, uCloudTime, uCloudDrift * uDriftScale);

  float density = cloudDensity(uCloudsTexture, cuv);

  if (uLayerMode > 0.5) {
    // --- High cirrus deck -------------------------------------------------
    // Cirrus is not a scaled copy of the tropospheric deck: it is fibrous ice
    // crystal stretched by the jet stream. Generating it on the sphere keeps it
    // seamless and free of the equirectangular stretch a second texture tap
    // would inherit, and it layers visibly on top of the cumulus deck below.
    vec3 p = normalize(vLocalPos);
    vec3 streakDir = normalize(vec3(p.x, p.y * 4.2, p.z));
    float drift = uTime * 0.0011;
    float fibre = fbmSphere(streakDir + vec3(drift, 0.0, drift * 0.6), 11.0, 4.0);
    float fibre2 = fbmSphere(streakDir * 2.1 - vec3(drift * 0.7, 0.0, 0.0), 26.0, 3.0);
    float coverage = fbmSphere(p, 2.4, 2.0);
    float mask = smoothstep(0.40, 0.74, coverage);
    float shapes = smoothstep(0.46, 0.80, fibre * 0.72 + fibre2 * 0.28);
    density = clamp(shapes * mask * 1.35, 0.0, 1.0);
  }

  // --- Sub-texel filament detail -----------------------------------------
  // Evaluated on the sphere direction, so the detail is seamless in longitude,
  // free of polar pinching, and keeps adding structure all the way down to the
  // 50 km inspection altitude.
  // Detail must fade with the *screen* footprint of one texel. In an
  // equirectangular map a texel spans 1/4096 of a revolution, i.e.
  // fwidth(vUv.x) * cosLat in surface terms — dividing by cosLat would let the
  // noise alias into streaks near the poles.
  float detailFade = 1.0 - smoothstep(0.0004, 0.0045, fwidth(vUv.x) * cosLat);
  if (detailFade > 0.01) {
    vec3 p = normalize(vLocalPos);
    vec3 w = vEastW * (uTime * 0.0016) + vNorthW * (uTime * 0.0009);
    // Two scales: broad billows plus fine fibre. Both live on the sphere, so
    // the deck gains believable structure without inheriting the texture's
    // latitude stretch.
    float macro = fbmSphere(normalize(p + w * 0.03), 34.0, 4.0) * 0.55
                + fbmSphere(normalize(p + w * 0.02), 120.0, 2.0) * 0.45;
    float micro = fbmSphere(normalize(p - w * 0.05), 260.0, 2.0);
    float erosion = (macro - 0.5) * 0.44 + (micro - 0.5) * 0.18;
    density = clamp(density + erosion * detailFade * (0.25 + 0.75 * (1.0 - density)), 0.0, 1.0);
  }

  float alpha = density * uCloudOpacity * uLayerAlpha;
  if (alpha < 0.004) discard;

  // --- Density gradient -> shading normal ---------------------------------
  float tx = 1.5 / 4096.0;
  float ty = 1.5 / 2048.0;
  float dE = cloudDensity(uCloudsTexture, cuv + vec2(tx, 0.0));
  float dW = cloudDensity(uCloudsTexture, cuv - vec2(tx, 0.0));
  float dN = cloudDensity(uCloudsTexture, cuv + vec2(0.0, ty));
  float dS = cloudDensity(uCloudsTexture, cuv - vec2(0.0, ty));
  vec2 grad = vec2(dE - dW, dN - dS);

  vec2 slope = grad * (0.55 + 0.45 * zoom) * uCloudRelief;
  vec3 Np = normalize(N - (slope.x * vEastW + slope.y * vNorthW));

  vec3 T = normalize(vEastW);
  vec3 Bn = normalize(vNorthW);

  // --- Self-shadowing: march a few texels toward the sun -------------------
  vec2 sunUv = vec2(dot(L, T), dot(L, Bn));
  float sunUvLen = length(sunUv);
  sunUv = sunUvLen > 1e-4 ? sunUv / sunUvLen : vec2(1.0, 0.0);
  float tau = 0.0;
  float stepLen = 0.0018 + 0.0016 * zoom;
  for (int i = 1; i <= 3; i += 1) {
    tau += cloudDensity(uCloudsTexture, cuv + sunUv * (stepLen * float(i)));
  }
  float sunVisibility = 0.45 + 0.55 * exp(-tau * 1.15);

  // --- Lighting ------------------------------------------------------------
  float sunUp = dot(N, L);
  float day = smoothstep(-0.055, 0.10, sunUp);
  float nightMask = 1.0 - smoothstep(-0.13, 0.015, sunUp);

  vec3 sunTint = atmosphereTransmittanceFrom(0.0022, sunUp);
  vec3 light = vec3(1.0, 0.978, 0.952) * uSunIntensity * sunTint;

  float NdotL = dot(Np, L);
  float wrapped = clamp((NdotL + 0.32) / 1.32, 0.0, 1.0);

  // Multiple-scattering approximation: interiors stay grey-blue instead of
  // collapsing to black, edges stay bright and translucent.
  float opticalThickness = density * 2.6;
  float interior = exp(-opticalThickness);
  // Ambient occlusion between cloud masses stays shallow: real cumulus are
  // almost as bright in shadow as in sun, they just lose specular punch.
  float occlusion = 0.84 + 0.16 * interior;

  // Forward Mie scattering (silver lining when the sun is behind the deck).
  float mu = dot(V, L);
  float phase = hgPhase(mu, 0.62);
  float rim = pow(1.0 - clamp(density, 0.0, 1.0), 2.0);

  vec3 scattered = CLOUD_ALBEDO * light * (
      wrapped * sunVisibility * occlusion * 1.08
    + AMBIENT_SKY * 0.20 * (1.0 - 0.5 * density)
    + phase * 0.55 * rim
  );

  // Warm bounce from the sunlit atmosphere below the deck.
  scattered += CLOUD_ALBEDO * light * vec3(1.0, 0.72, 0.52) * 0.05 * (1.0 - interior);

  // --- Night side: city underglow, otherwise dark -------------------------
  vec3 nightGlow = vec3(1.0, 0.52, 0.20) * 0.020 * (1.0 - density * 0.6);
  scattered = mix(nightGlow, scattered, day);
  scattered *= mix(1.0, 0.72, nightMask);

  // --- Aerial perspective between the camera and the deck ----------------
  float cosV = clamp(dot(N, V), 1e-4, 1.0);
  vec3 viewT = atmosphereTransmittanceFrom(0.0022, cosV);
  float airMass = relativeAirMass(cosV);
  vec3 hazeColor = vec3(0.30, 0.52, 0.92) * uSunIntensity * 0.30 * uAtmosphereIntensity;
  vec3 finalColor = scattered * viewT + hazeColor * (vec3(1.0) - viewT) * smoothstep(-0.06, 0.2, sunUp);

  // --- Opacity ------------------------------------------------------------
  // Thin cirrus stays translucent; dense cumulus goes opaque. At night the deck
  // still occludes city light, so the alpha floor is higher than by day.
  float nightAlpha = mix(0.72, 1.0, day);
  float zoomThin = mix(0.55, 1.0, smoothstep(1.015, 1.16, uCameraDistance));
  alpha = clamp(pow(alpha, 0.82) * 1.02, 0.0, 1.0) * nightAlpha * zoomThin;

  fragColor = vec4(finalColor, alpha);
}
