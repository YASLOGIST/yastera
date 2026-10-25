/**
 * Shader composition manifest — the single source of truth.
 *
 * Both the runtime (`src/shaderSources.js`) and the offline checker
 * (`scripts/check-shaders.mjs`) build their shader sources from this table, so a
 * shader can never be validated with a prelude the app does not actually attach.
 *
 * That exact bug happened once: `milkyway.frag` calls `fbm4()` and
 * `valueNoise()` from `lib/noise.glsl`, but the runtime never prepended it, so the
 * driver failed with "'fbm4' : no matching overloaded function found" while the
 * checker happily validated a composed string that only existed inside itself.
 *
 * Paths are relative to `src/shaders/`.
 */

export const SHADER_PARTS = Object.freeze({
  // --- surface -------------------------------------------------------------
  earthSurfaceVertex: ['earthSurface.vert'],
  earthSurface: ['lib/noise.glsl', 'lib/atmosphere.glsl', 'lib/clouds.glsl', 'earthSurface.frag'],

  // --- cloud decks ---------------------------------------------------------
  cloudShellVertex: ['cloud.vert'],
  cloudShell: ['lib/noise.glsl', 'lib/atmosphere.glsl', 'lib/clouds.glsl', 'earthClouds.frag'],

  // --- atmosphere ----------------------------------------------------------
  shellVertex: ['shell.vert'],
  atmosphereHalo: ['lib/atmosphere.glsl', 'atmosphereHalo.frag'],

  // --- deep space ----------------------------------------------------------
  starfieldVertex: ['starfield.vert'],
  starfield: ['starfield.frag'],
  milkyWayVertex: ['milkyway.vert'],
  milkyWay: ['lib/noise.glsl', 'milkyway.frag'],

  // --- city beacons --------------------------------------------------------
  beaconVertex: ['beacon.vert'],
  beacon: ['beacon.frag'],
});

/** Stage of each program, used by the offline validator. */
export const SHADER_STAGES = Object.freeze({
  earthSurfaceVertex: 'vertex',
  earthSurface: 'fragment',
  cloudShellVertex: 'vertex',
  cloudShell: 'fragment',
  shellVertex: 'vertex',
  atmosphereHalo: 'fragment',
  starfieldVertex: 'vertex',
  starfield: 'fragment',
  milkyWayVertex: 'vertex',
  milkyWay: 'fragment',
  beaconVertex: 'vertex',
  beacon: 'fragment',
});

/** Which JS module owns the uniform values for each program. */
export const SHADER_OWNERS = Object.freeze({
  earthSurface: 'src/earth.js',
  cloudShell: 'src/earth.js',
  atmosphereHalo: 'src/earth.js',
  starfield: 'src/starfield.js',
  milkyWay: 'src/starfield.js',
  beacon: 'src/beacons.js',
});

/**
 * Concatenates a program's parts in dependency order.
 *
 * @param {(part: string) => string} read Reads one file relative to `src/shaders/`.
 * @param {keyof typeof SHADER_PARTS} key
 * @returns {string}
 */
export function composeShader(read, key) {
  const parts = SHADER_PARTS[key];
  if (!parts) throw new Error(`Unknown shader "${key}"`);
  // The header is compiled as a comment but survives into the driver's log, so
  // a compile failure can name the program that failed instead of dumping a
  // line number into a 20 000 character source.
  const header = `// program: ${key}\n// parts: ${parts.join(', ')}\n`;
  return header + parts.map((part) => read(part)).join('\n');
}
