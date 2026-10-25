/**
 * Runtime shader sources.
 *
 * Every GLSL file under `src/shaders/` is pulled in as a raw string and
 * composed according to `shaderManifest.js` — the same manifest the offline
 * checker uses, so what gets validated is exactly what gets compiled.
 */

import { composeShader, SHADER_PARTS } from './shaderManifest.js';

const RAW = import.meta.glob('./shaders/**/*.{glsl,frag,vert}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** @param {string} part path relative to src/shaders/ */
function readShaderPart(part) {
  const source = RAW[`./shaders/${part}`];
  if (source === undefined) {
    // Fail loudly at startup with the offending filename instead of letting the
    // GLSL compiler report a baffling "no matching overloaded function".
    throw new Error(`Missing shader source "${part}" (check shaderManifest.js)`);
  }
  return source;
}

/** @type {Record<keyof typeof SHADER_PARTS, string>} */
export const SHADERS = Object.freeze(
  Object.fromEntries(
    Object.keys(SHADER_PARTS).map((key) => [key, composeShader(readShaderPart, key)]),
  ),
);
