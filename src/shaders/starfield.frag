#include <common>
#include <logdepthbuf_pars_fragment>
// Star field — fragment stage.
//
// A real star seen by a camera is a tight photometric core with a faint
// diffraction cross on the brightest few. No twinkling: in vacuum there is no
// atmosphere to scintillate through.

uniform float uOpacity;

in vec3  vColor;
in float vMagnitude;

out vec4 fragColor;

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;

  // Airy-like core: hot centre, rapid falloff, no hard disc edge.
  float core = exp(-r2 * 5.5) * 0.85 + exp(-r2 * 1.6) * 0.22;

  // Diffraction spikes only on the brightest stars.
  float bright = smoothstep(0.62, 1.0, vMagnitude);
  float spikes = (exp(-abs(p.x) * 30.0) * exp(-abs(p.y) * 2.2)
                + exp(-abs(p.y) * 30.0) * exp(-abs(p.x) * 2.2)) * 0.22 * bright;

  float energy = (core + spikes) * (0.25 + 0.75 * vMagnitude);
  if (energy < 0.002) discard;

  fragColor = vec4(vColor * energy * uOpacity, 1.0);
}
