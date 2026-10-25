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

/** Contrast-shaped optical depth sampled from the cloud map. */
float cloudDensity(sampler2D tex, vec2 uv) {
  float raw = texture(tex, uv).r;
  // The map is already gamma-lifted in the pipeline; this adds just enough
  // contrast for dense cores to read as opaque and cirrus edges as translucent.
  return smoothstep(0.045, 0.86, raw);
}
