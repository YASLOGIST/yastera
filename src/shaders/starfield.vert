#include <common>
#include <logdepthbuf_pars_vertex>
// Star field — vertex stage. Positions live on a huge sphere so the sky is
// fixed in world space while the camera orbits.

uniform float uPixelRatio;
uniform float uSizeScale;

in float aSize;
in float aMagnitude;
in vec3  aColor;

out vec3  vColor;
out float vMagnitude;

void main() {
  vColor = aColor;
  vMagnitude = aMagnitude;

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  gl_PointSize = aSize * uSizeScale * uPixelRatio;
}
