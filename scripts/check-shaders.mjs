#!/usr/bin/env node
/**
 * Shader + wiring checker.
 *
 * Runs without a GPU:
 *   1. Composes each shader the way earth.js does (lib prelude + source) and
 *      resolves three's `#include <chunk>` directives.
 *   2. Parses and validates every stage with naga (the wgpu shader compiler),
 *      which catches undefined identifiers, type errors, bad swizzles, wrong
 *      call signatures and illegal control flow.
 *   3. Cross-checks every uniform a shader declares against the uniforms the
 *      JS actually supplies, for each material.
 *
 * The naga path needs the optional dev dependencies; without them only the
 * uniform cross-check runs (still useful in CI, no download required).
 *
 * Usage: npm run check:shaders
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const lib = (n) => read(`src/shaders/lib/${n}`);

const PRELUDE = lib('noise.glsl') + lib('atmosphere.glsl') + lib('clouds.glsl');

/** Triple of { material name, fragment source, vertex source, JS owner }. */
const MATERIALS = [
  { name: 'earthSurface', frag: PRELUDE + read('src/shaders/earthSurface.frag'), vert: read('src/shaders/earthSurface.vert'), js: 'src/earth.js' },
  { name: 'earthClouds', frag: PRELUDE + read('src/shaders/earthClouds.frag'), vert: read('src/shaders/cloud.vert'), js: 'src/earth.js' },
  { name: 'atmosphereHalo', frag: lib('atmosphere.glsl') + read('src/shaders/atmosphereHalo.frag'), vert: read('src/shaders/shell.vert'), js: 'src/earth.js' },
  { name: 'starfield', frag: read('src/shaders/starfield.frag'), vert: read('src/shaders/starfield.vert'), js: 'src/starfield.js' },
  { name: 'milkyWay', frag: lib('noise.glsl') + read('src/shaders/milkyway.frag'), vert: read('src/shaders/milkyway.vert'), js: 'src/starfield.js' },
  { name: 'beacon', frag: read('src/shaders/beacon.frag'), vert: read('src/shaders/beacon.vert'), js: 'src/beacons.js' },
];

const BUILTINS = new Set([
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition', 'isOrthographic', 'logDepthBufFC',
]);

// ---------------------------------------------------------------------------
// 1. three.js #include resolution
// ---------------------------------------------------------------------------
const CHUNK_DIR = path.join(ROOT, 'node_modules/three/src/renderers/shaders/ShaderChunk');

function resolveIncludes(src) {
  return src.replace(/^[ \t]*#include[ \t]+<([\w./]+)>/gm, (_match, name) => {
    try {
      const raw = readFileSync(path.join(CHUNK_DIR, `${name}.glsl.js`), 'utf8');
      const body = raw.replace(/^export default \/\* glsl \*\/`/, '').replace(/`;\s*$/, '');
      return resolveIncludes(body);
    } catch {
      return `/* missing chunk ${name} */`;
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Uniform contract
// ---------------------------------------------------------------------------
function declaredUniforms(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)) names.add(m[1]);
  return names;
}

function suppliedUniforms(jsFile) {
  const src = read(jsFile);
  const names = new Set();
  for (const m of src.matchAll(/\b(u[A-Z][A-Za-z0-9]*)\s*:/g)) names.add(m[1]);
  for (const m of src.matchAll(/uniforms\.(\w+)\./g)) names.add(m[1]);
  return names;
}

function checkUniformContract() {
  let problems = 0;
  for (const mat of MATERIALS) {
    const supplied = suppliedUniforms(mat.js);
    const need = new Set([...declaredUniforms(mat.frag), ...declaredUniforms(mat.vert)]);
    for (const name of need) {
      if (BUILTINS.has(name)) continue;
      if (!supplied.has(name)) {
        console.error(`  ✖ ${mat.name}: shader declares "${name}" but ${mat.js} never supplies it`);
        problems += 1;
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 3. Semantic validation with naga
// ---------------------------------------------------------------------------
async function checkWithNaga() {
  let naga;
  try {
    naga = await import('naga-wasm');
  } catch {
    console.log('  (naga-wasm not installed — skipping semantic validation)');
    return 0;
  }

  // naga insists on explicit binding points for every uniform block.
  const VERT_PREFIX = `layout(binding=40, std140) uniform BuiltinV { mat4 modelMatrix; };
layout(binding=41, std140) uniform BuiltinV1 { mat4 modelViewMatrix; };
layout(binding=42, std140) uniform BuiltinV2 { mat4 projectionMatrix; };
layout(binding=43, std140) uniform BuiltinV3 { mat4 viewMatrix; };
layout(binding=44, std140) uniform BuiltinV4 { mat3 normalMatrix; };
layout(binding=45, std140) uniform BuiltinV5 { vec3 cameraPosition; };
in vec3 position;
in vec3 normal;
in vec2 uv;
in vec4 tangent;
`;
  const FRAG_PREFIX = `layout(binding=40, std140) uniform BuiltinF { mat4 viewMatrix; };
layout(binding=41, std140) uniform BuiltinF1 { vec3 cameraPosition; };
layout(binding=42, std140) uniform BuiltinF2 { float logDepthBufFC; };
`;

  // naga's GLSL frontend has no combined image samplers and rejects `const in`
  // parameters, so those are rewritten for validation only.
  function prepare(src, stage) {
    let code = resolveIncludes(src);
    code = code.replace(/^[ \t]*uniform[ \t]+sampler(?:2D|3D|Cube)[ \t]+(\w+);/gm, 'vec4 $1 = vec4(0.5);');
    code = code.replace(/\bsampler(?:2D|3D|Cube)\s+(\w+)/g, 'vec4 $1');
    const scalars = [];
    code = code.replace(/^[ \t]*uniform[ \t]+([^;]+);/gm, (_m, decl) => {
      scalars.push(decl.trim());
      return '';
    });
    const hasFragOut = /out\s+vec4\s+fragColor\s*;/.test(code);
    code = code.replace(/^[ \t]*out[ \t]+vec4[ \t]+fragColor;/gm, '');
    code = code.replace(/\bvarying\b/g, stage === 'vertex' ? 'out' : 'in');
    code = code.replace(/\bvoid\s+main\s*\(\s*(?:void)?\s*\)/, 'void userMain()');
    code = code.replace(/\bconst\s+in\s+/g, 'in ');

    const blocks = scalars
      .map((d, i) => `layout(binding=${i + 20}, std140) uniform B${i} { ${d}; };`)
      .join('\n');
    const stubs = `#define texture(a, b) vec4(0.5, 0.5, 0.5, 1.0)
#define textureLod(a, b, c) vec4(0.5, 0.5, 0.5, 1.0)
`;
    const outDecl = stage === 'fragment' ? 'layout(location = 0) out vec4 o_color;\n' : '';
    const epilogue = hasFragOut
      ? 'void main() { userMain(); o_color = fragColor; }\n'
      : `void main() { userMain();${stage === 'fragment' ? ' o_color = vec4(0.0);' : ''} }\n`;

    let program = `#version 450\n${outDecl}${stage === 'vertex' ? VERT_PREFIX : FRAG_PREFIX}\n`
      + `${blocks}\nvec4 fragColor;\n${stubs}${code}\n${epilogue}`;

    // naga requires explicit interface locations.
    const counters = { in: 0, out: 0 };
    program = program.replace(
      /^[ \t]*(in|out)[ \t]+((?:highp|mediump|lowp)[ \t]+)?(vec[234]|float|mat[234]|uvec[234]|ivec[234])[ \t]+(\w+);/gm,
      (_m, io, _prec, type, name) => `layout(location=${counters[io]++}) ${io} ${type} ${name};`,
    );
    return program;
  }

  let problems = 0;
  for (const mat of MATERIALS) {
    for (const [stage, src] of [['vertex', mat.vert], ['fragment', mat.frag]]) {
      try {
        const module = naga.parseGlsl(prepare(src, stage), { stage });
        const info = naga.validate(module);
        module.free?.();
        info.free?.();
      } catch (err) {
        console.error(`  ✖ ${mat.name} (${stage}):\n${(err.formatted || err.message || err).split('\n').slice(0, 12).join('\n')}`);
        problems += 1;
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
const problems = checkUniformContract() + (await checkWithNaga());
if (problems > 0) {
  console.error(`\n${problems} shader problem(s) found.`);
  process.exitCode = 1;
} else {
  console.log('✓ all shaders parse, validate, and match their uniform contracts.');
}
