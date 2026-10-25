#include <common>
#include <logdepthbuf_pars_vertex>
// Deep-space background sphere vertex stage: hands the view direction to the
// fragment shader so the Milky Way is evaluated in galactic coordinates.

out vec3 vDir;

void main() {
  vDir = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
