// Background starfield — vertex stage. Fixed pixel size (no attenuation).

uniform float uPixelRatio;
uniform float uTime;

in float aSize;
in float aBrightness;
in float aPhase;

out float vBrightness;

void main() {
  vBrightness = aBrightness * (0.85 + 0.15 * sin(uTime * 0.9 + aPhase));
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uPixelRatio;
}
