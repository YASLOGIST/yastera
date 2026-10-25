#include <common>
#include <logdepthbuf_pars_fragment>
// HDR orbital beacons — fragment stage. Additive; colour exceeds 1.0 so the
// cores cross the bloom threshold while the soft skirt stays sub-threshold.

uniform vec3  uColor;
uniform float uIntensity;

in float vFacing;
in float vPulse;
in float vDayNight;

out vec4 fragColor;

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;

  float core = exp(-r2 * 34.0);
  float skirt = exp(-r2 * 6.0) * 0.16 * vPulse;
  float edge = 1.0 - smoothstep(0.7, 1.0, r2);
  float horizon = smoothstep(-0.02, 0.24, vFacing);

  float energy = (core + skirt) * edge * horizon * uIntensity * vDayNight;
  if (energy < 0.001) discard;

  fragColor = vec4(uColor * energy, 1.0);
}
