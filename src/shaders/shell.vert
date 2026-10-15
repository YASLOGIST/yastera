// Shared vertex stage for the cloud shell and the atmosphere halo.

out vec2 vUv;
out vec3 vPosW;
out vec3 vNormalW;
out vec3 vCenterW;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vPosW = worldPos.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vCenterW = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
