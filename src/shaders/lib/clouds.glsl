// ---------------------------------------------------------------------------
// Cloud deck helpers shared by the surface (shadow lookup) and cloud shell
// (density) shaders, so ground shadows always line up with the cloud above.
// ---------------------------------------------------------------------------

// Banded zonal circulation: easterly trades at the equator, westerly jets near
// ±45°, polar easterlies above ±65°. Returns a signed u-velocity in [-1, 1].
float zonalWind(float latRad) {
  float absLat = abs(latRad);
  float trades = -0.55 * exp(-pow(latRad / 0.55, 2.0));
  float jet = 0.85 * exp(-pow((absLat - 0.72) / 0.32, 2.0));
  float polar = -0.42 * smoothstep(1.0, 1.5, absLat);
  return trades + jet + polar;
}

/**
 * Cloud-deck texture coordinate after advection.
 * `drift` is in radians/second (Earth rotation units); `time` in seconds.
 */
vec2 cloudAdvect(vec2 uv, float time, float drift) {
  float lat = (uv.y - 0.5) * 3.14159265;
  float wind = zonalWind(lat);
  float revolution = time * drift / 6.2831853;
  float u = uv.x + revolution * wind;
  // Very slow meridional churn so the deck is never a rigid stencil.
  float v = uv.y + revolution * 0.018 * sin(uv.x * 6.2831853 + 1.7);
  return vec2(u, clamp(v, 0.0015, 0.9985));
}

/**
 * Coverage map -> optical depth.
 *
 * The map stores *fractional cloud cover*: its value is the fraction of a
 * 4 km-wide cell that is cloudy. The correct opacity for a cell viewed from
 * above is therefore the value itself, not a contrast-shaped version of it.
 *
 * Two earlier versions of this function were wrong in opposite directions, and
 * both mistakes are worth recording because they are easy to repeat:
 *
 *   • `smoothstep(0.09, 0.62, raw)` — a "make it punchy" contrast curve. It
 *     pushed 76 % of the planet's sky to exactly zero coverage, so the globe
 *     rendered almost cloudless and the remaining clouds were hard-edged.
 *   • `pow(raw, 0.6) * 0.3 + core` — a gamma lift to "bring back the thin
 *     cloud". That did restore the thin cloud, but as an opaque enough layer
 *     that it turned the oceans grey: a 20 % white veil over navy is not
 *     subtle, it is the difference between sea and dishwater.
 *
 * Passing coverage straight through reproduces the reference photograph's
 * cloud/clear split (22 % cloud, 34 % thin, 45 % clear) almost exactly, which
 * is the strongest argument for it being right: it is what the data says.
 */
float cloudDensity(sampler2D tex, vec2 uv) {
  return min(texture(tex, uv).r, 0.985);
}

/**
 * Optical depth that actually casts a shadow on the ground.
 *
 * Deliberately *not* `cloudDensity`. Coverage and extinction are different
 * quantities: a cell that is 15 % covered still sends nearly all the sunlight
 * straight through, so keying shadows off coverage paints a broad grey stain
 * under every thin cloud — which is exactly what made the oceans look muddy.
 * Shadowing keys off the dense cores only, and the surface integrates the
 * result as an exponential rather than a linear multiply.
 */
float cloudShadowDepth(sampler2D tex, vec2 uv) {
  float raw = texture(tex, uv).r;
  return smoothstep(0.20, 0.66, raw);
}
