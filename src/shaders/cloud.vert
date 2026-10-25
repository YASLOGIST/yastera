#include <common>
#include <logdepthbuf_pars_vertex>
// Cloud shell vertex stage. Adds an analytic tangent frame so the fragment
// shader can perturb the normal from the density gradient without a normal map.

out vec2 vUv;
out vec3 vPosW;
out vec3 vNormalW;
out vec3 vCenterW;
out vec3 vEastW;
out vec3 vNorthW;
out vec3 vLocalPos;

void main() {
  vUv = uv;
  vec3 p = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;

  mat3 rot = mat3(modelMatrix);
  vNormalW = normalize(rot * normal);

  vec3 eastObj = cross(vec3(0.0, 1.0, 0.0), p);
  float eLen = length(eastObj);
  // At the poles the east vector degenerates; fall back to any tangent.
  eastObj = eLen > 1e-5 ? eastObj / eLen : normalize(cross(vec3(1.0, 0.0, 0.0), p));
  vec3 northObj = normalize(cross(p, eastObj));

  vEastW = normalize(rot * eastObj);
  vNorthW = normalize(rot * northObj);
  vLocalPos = p;
  vCenterW = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
