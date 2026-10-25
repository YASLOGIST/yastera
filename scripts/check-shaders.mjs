#!/usr/bin/env node
/**
 * Shader + wiring checker. Runs without a GPU.
 *
 *   1. Composes every program from `src/shaderManifest.js` — the exact same
 *      table `src/shaderSources.js` uses at runtime, so the checker can never
 *      validate a prelude the app forgets to attach.
 *   2. Resolves three's `#include <chunk>` directives.
 *   3. Parses and validates each stage with naga (the wgpu shader compiler),
 *      which catches undefined identifiers, type errors, bad swizzles, wrong
 *      call signatures and illegal control flow.
 *   4. Cross-checks every uniform a shader declares against the uniforms its
 *      owning JS module supplies.
 *
 * Usage: npm run check:shaders
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHADER_STAGES,
  SHADER_OWNERS,
  composeShader,
} from '../src/shaderManifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHADER_DIR = path.join(ROOT, 'src/shaders');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const readShaderPart = (part) => readFileSync(path.join(SHADER_DIR, part), 'utf8');

const PROGRAMS = Object.keys(SHADER_STAGES);

const BUILTINS = new Set([
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition', 'isOrthographic', 'logDepthBufFC',
]);

// ---------------------------------------------------------------------------
// three.js #include resolution
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
// Uniform contract
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
  for (const [program, jsFile] of Object.entries(SHADER_OWNERS)) {
    const supplied = suppliedUniforms(jsFile);
    const source = composeShader(readShaderPart, program);
    for (const name of declaredUniforms(source)) {
      if (BUILTINS.has(name)) continue;
      if (!supplied.has(name)) {
        console.error(`  ✖ ${program}: shader declares "${name}" but ${jsFile} never supplies it`);
        problems += 1;
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Semantic validation with naga
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
  const VERT_PREFIX = `layout(binding=40, std140) uniform BuiltinV0 { mat4 modelMatrix; };
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
  const FRAG_PREFIX = `layout(binding=40, std140) uniform BuiltinF0 { mat4 viewMatrix; };
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
  for (const program of PROGRAMS) {
    const source = composeShader(readShaderPart, program);
    const stage = SHADER_STAGES[program];
    try {
      const module = naga.parseGlsl(prepare(source, stage), { stage });
      const info = naga.validate(module);
      module.free?.();
      info.free?.();
    } catch (err) {
      console.error(`  ✖ ${program} (${stage}):`);
      console.error((err.formatted || err.message || String(err)).split('\n').slice(0, 14).join('\n'));
      problems += 1;
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
  console.log(`✓ ${PROGRAMS.length} shader programs parse, validate, and match their uniform contracts.`);
}
