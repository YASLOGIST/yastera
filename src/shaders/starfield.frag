// Background starfield — fragment stage. Deliberately dim (well below the
// bloom threshold) so the planet remains the sole focal point.

uniform float uOpacity;

in float vBrightness;

out vec4 fragColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float falloff = exp(-r2 * 4.0);
  fragColor = vec4(vec3(0.82, 0.88, 1.0) * vBrightness * falloff * uOpacity, 1.0);
}
