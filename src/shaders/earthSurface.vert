// Planetary surface — vertex stage.
// Emits world-space position, geometric sphere normal and the MikkTSpace-style
// tangent (from BufferGeometry.computeTangents) for tangent-space relief.

in vec4 tangent;

out vec2 vUv;
out vec3 vPosW;
out vec3 vNormalW;
out vec4 vTangentW;

void main() {
  vUv = uv;

  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vPosW = worldPos.xyz;

  // modelMatrix holds only rotations (axial tilt + spin), so mat3 is orthonormal.
  mat3 rot = mat3(modelMatrix);
  vNormalW = normalize(rot * normal);
  vTangentW = vec4(normalize(rot * tangent.xyz), tangent.w);

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
