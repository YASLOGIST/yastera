#include <common>
#include <logdepthbuf_pars_vertex>
// HDR orbital beacons — vertex stage (GL_POINTS).

uniform float uSize;        // sprite size in world-ish units (scaled by 1/depth)
uniform float uPixelRatio;
uniform float uTime;
uniform vec3  uSunDirection;

in float aPhase;

out float vFacing;
out float vPulse;
out float vDayNight;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec3 center = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 surfaceNormal = normalize(worldPos.xyz - center);
  vec3 viewDir = normalize(cameraPosition - worldPos.xyz);

  // How squarely the beacon faces the camera: fades it out at the horizon
  // before the planet's depth test clips the sprite.
  vFacing = dot(surfaceNormal, viewDir);
  vPulse = 0.78 + 0.22 * sin(uTime * 2.1 + aPhase);

  // Day/night factor: beacons should only glow on the night/twilight side!
  // In bright daylight, city beacons are not visible like nuclear explosions.
  float sunDot = dot(surfaceNormal, normalize(uSunDirection));
  vDayNight = 1.0 - smoothstep(-0.08, 0.12, sunDot);

  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  gl_PointSize = uSize * uPixelRatio / max(-mvPosition.z, 0.1);
}
