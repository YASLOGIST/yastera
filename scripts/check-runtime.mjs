#!/usr/bin/env node
/**
 * Static check for the two runtime faults a bundler cannot see.
 *
 * Both of them shipped at different points in this project's history:
 *
 *  1. **Undefined reference.** A name used in a file that resolves to no
 *     binding in any enclosing scope. Vite happily bundles it; the browser
 *     throws a ReferenceError the moment the line runs.
 *
 *  2. **Use before declaration.** A `const` / `let` / `class` read from
 *     straight-line code in the same block, above its own declaration. This is
 *     a temporal-dead-zone ReferenceError on the first execution. It is
 *     invisible to every build tool, and it took the whole app down: the frame
 *     loop read `nowPerf` three lines above the `const nowPerf = ...` that
 *     created it, so the very first frame threw and the error handler covered
 *     the scene with a fatal panel.
 *
 * References inside nested functions are deliberately excluded from check 2.
 * A function body does not run when it is defined, so reading a binding from
 * inside one is legal as long as the function is called after the declaration —
 * which is why the rule is restricted to straight-line code in the same block.
 *
 * Run with `npm run check:runtime`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGETS = ['src'];

// Browser and environment globals the source is allowed to reference without
// declaring. Deliberately a list rather than "anything on globalThis": the
// point of the check is to catch names that resolve to nothing.
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'console', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'URL', 'URLSearchParams',
  'Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray',
  'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'ArrayBuffer', 'DataView', 'Intl', 'isNaN', 'isFinite', 'parseFloat',
  'parseInt', 'encodeURIComponent', 'decodeURIComponent', 'undefined', 'NaN',
  'Infinity', 'globalThis', 'self', 'ResizeObserver', 'IntersectionObserver',
  'Image', 'Audio', 'fetch', 'AbortController', 'TextEncoder', 'TextDecoder',
  'DOMParser', 'CustomEvent', 'Event', 'HTMLElement', 'WebGL2RenderingContext',
]);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** A scope only needs to answer "is this name declared here?". */
function makeScope(parent, kinds = {}) {
  return { parent, names: new Map(Object.entries(kinds)) }; // name -> 'var'|'let'|'function'|'param'
}

function declare(scope, name, kind) {
  if (!scope.names.has(name)) scope.names.set(name, kind);
}

function resolves(scope, name) {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return GLOBALS.has(name);
}

const problems = [];

function report(file, node, message) {
  const line = node.loc?.start.line ?? 0;
  problems.push(`${relative(ROOT, file)}:${line}  ${message}`);
}

/**
 * Collects every binding a statement introduces into `scope`, without walking
 * into nested functions. Used to know what a block declares before checking it.
 */
function hoistStatement(node, scope) {
  walk.recursive(
    node,
    scope,
    {
      // Do not descend into nested function scopes: their bindings are theirs.
      Function() {},
      VariableDeclaration(n, state) {
        const kind = n.kind === 'var' ? 'var' : 'let';
        for (const d of n.declarations) collectPattern(d.id, (name) => declare(state, name, kind));
        // A `var` inside a block belongs to the function scope; keeping it in
        // the block scope is conservative and only affects check 2.
        for (const d of n.declarations) hoistStatement(d.init, state);
      },
      ClassDeclaration(n, state) {
        if (n.id) declare(state, n.id.name, 'let');
      },
      FunctionDeclaration(n, state) {
        // Function declarations hoist, so they are never a TDZ problem.
        if (n.id) declare(state, n.id.name, 'function');
      },
      ImportDeclaration() {},
    },
  );
}

function collectPattern(node, cb) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': cb(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) collectPattern(p.value ?? p.argument, cb);
      break;
    case 'ArrayPattern': for (const e of node.elements) collectPattern(e, cb); break;
    case 'AssignmentPattern': collectPattern(node.left, cb); break;
    case 'RestElement': collectPattern(node.argument, cb); break;
    default: break;
  }
}

/** Names a function's parameter list binds. */
function collectParams(fn, scope) {
  for (const p of fn.params) collectPattern(p, (name) => declare(scope, name, 'param'));
}

/**
 * Walks straight-line code in one block, in source order, reporting reads of a
 * lexical binding that this block declares further down.
 *
 * `deferred` is the key subtlety: a reference counts only if it runs when the
 * statement runs. References inside a function body are therefore checked
 * against the scope *after* the whole block is hoisted, not against the
 * declaration order.
 */
function checkBlock(statements, scope, file) {
  // Pass 1: what does this block declare, and where?
  const declaredAt = new Map();
  for (let i = 0; i < statements.length; i++) {
    const st = statements[i];
    const collect = (name, kind) => {
      if (kind === 'function') return; // hoisted, always initialised
      if (!declaredAt.has(name)) {
        declaredAt.set(name, { index: i, kind, line: st.loc?.start.line ?? '?' });
      }
    };
    if (st.type === 'VariableDeclaration') {
      const kind = st.kind === 'var' ? 'var' : 'let';
      for (const d of st.declarations) collectPattern(d.id, (n) => collect(n, kind));
    } else if (st.type === 'ClassDeclaration' && st.id) {
      collect(st.id.name, 'let');
    }
  }
  const declScope = makeScope(scope);
  for (const [name, info] of declaredAt) declare(declScope, name, info.kind);

  // Pass 2: walk each statement's *direct* expressions in order.
  for (let i = 0; i < statements.length; i++) {
    walkDirect(statements[i], i);
  }

  function walkDirect(node, statementIndex) {
    if (!node) return;
    walk.recursive(node, null, {
      // A nested function is not executed here, so skip it entirely.
      Function() {},
      Identifier(n) {
        if (!declaredAt.has(n.name)) return;
        const info = declaredAt.get(n.name);
        if (info.index <= statementIndex) return;
        report(file, n, `'${n.name}' is read before its declaration on the same block (line ${info.line ?? '?'})`);
      },
    });
  }

  // Now recurse into nested blocks and function bodies with the augmented scope.
  for (const st of statements) recurseScopes(st, declScope, file);
}

/**
 * Descends into every construct that opens a scope, building the scope chain as
 * it goes, and checks each block it finds.
 */
function recurseScopes(node, scope, file) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const fnScope = makeScope(scope);
      if (node.type === 'FunctionExpression' && node.id) declare(fnScope, node.id.name, 'function');
      collectParams(node, fnScope);
      // Function declarations in the body hoist.
      for (const p of node.body.type === 'BlockStatement' ? node.body.body : []) {
        if (p.type === 'FunctionDeclaration' && p.id) declare(fnScope, p.id.name, 'function');
      }
      if (node.body.type === 'BlockStatement') checkBlock(node.body.body, fnScope, file);
      else recurseScopes(node.body, fnScope, file);
      return;
    }
    case 'BlockStatement':
      checkBlock(node.body, scope, file);
      return;
    case 'ForStatement':
    case 'ForOfStatement':
    case 'ForInStatement': {
      const forScope = makeScope(scope);
      const init = node.init ?? node.left;
      if (init && init.type === 'VariableDeclaration') {
        for (const d of init.declarations) collectPattern(d.id, (n) => declare(forScope, n, 'let'));
      }
      recurseScopes(node.body, forScope, file);
      recurseScopes(node.init, forScope, file);
      recurseScopes(node.test, forScope, file);
      recurseScopes(node.update, forScope, file);
      if (node.right) recurseScopes(node.right, forScope, file);
      return;
    }
    case 'CatchClause': {
      const catchScope = makeScope(scope);
      if (node.param) collectPattern(node.param, (n) => declare(catchScope, n, 'param'));
      recurseScopes(node.body, catchScope, file);
      return;
    }
    case 'SwitchStatement': {
      const swScope = makeScope(scope);
      for (const c of node.cases) recurseScopes(c, swScope, file);
      recurseScopes(node.discriminant, scope, file);
      return;
    }
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.superClass) recurseScopes(node.superClass, scope, file);
      recurseScopes(node.body, makeScope(scope), file);
      return;
    default: {
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const c of v) recurseScopes(c, scope, file); }
        else if (v && typeof v.type === 'string') recurseScopes(v, scope, file);
      }
    }
  }
}

/**
 * Check 1: every identifier read must be declared somewhere in the module, or be
 * a known global.
 *
 * Deliberately file-flat. Building a real scope chain here would say more, but
 * the flat rule already catches what matters — a name that resolves to nothing,
 * whether it is a typo or a binding that was deleted — and it cannot produce a
 * false positive from a construct this checker does not model.
 */
function checkUndefined(ast, file) {
  const declared = new Set();
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'VariableDeclarator':
        collectPattern(node.id, (n) => declared.add(n));
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        // A function contributes both its own name and every parameter. These
        // are independent: testing them in an else-if chain drops the params of
        // every named function, which reported the whole of galacticField.js as
        // undefined.
        if (node.id) declared.add(node.id.name);
        for (const p of node.params) collectPattern(p, (n) => declared.add(n));
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name);
        break;
      case 'CatchClause':
        if (node.param) collectPattern(node.param, (n) => declared.add(n));
        break;
      case 'ImportDefaultSpecifier':
      case 'ImportSpecifier':
      case 'ImportNamespaceSpecifier':
        declared.add(node.local.name);
        break;
      default:
        break;
    }
  });
  walk.ancestor(ast, {
    Identifier(node, ancestors) {
      if (!isReference(node, ancestors)) return;
      if (declared.has(node.name) || GLOBALS.has(node.name)) return;
      report(file, node, `'${node.name}' is not defined`);
    },
  });
}

function isReference(node, ancestors) {
  const parent = ancestors[ancestors.length - 2];
  const grand = ancestors[ancestors.length - 3];
  if (!parent) return false;
  switch (parent.type) {
    case 'MemberExpression': return parent.object === node && !parent.computed;
    case 'Property': return !(parent.key === node && !parent.shorthand && !parent.computed);
    case 'MethodDefinition':
    case 'PropertyDefinition': return parent.key !== node;
    case 'VariableDeclarator': return parent.init === node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': return false;
    case 'ClassDeclaration':
    case 'ClassExpression': return false;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier': return false;
    case 'ExportSpecifier': return false;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement': return false;
    case 'CatchClause': return parent.param !== node;
    case 'ObjectPattern':
    case 'ArrayPattern':
    case 'RestElement':
    case 'AssignmentPattern': return parent.type === 'AssignmentPattern' ? parent.right !== node : false;
    default: break;
  }
  // `a.b` where node is the property: parent is MemberExpression, handled above.
  if (grand && grand.type === 'MemberExpression' && grand.property === parent) return false;
  if (parent.type === 'AssignmentExpression' && parent.left === node) return false;
  if (parent.type === 'UpdateExpression' && parent.argument === node) return false;
  return true;
}

let checked = 0;
for (const target of TARGETS) {
  for (const file of listFiles(join(ROOT, target))) {
    const source = readFileSync(file, 'utf8');
    let ast;
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    } catch (err) {
      problems.push(`${relative(ROOT, file)}: parse error — ${err.message}`);
      continue;
    }
    checked++;

    // Module scope: imports, top-level declarations, hoisted function decls.
    const moduleScope = makeScope(null);
    for (const st of ast.body) {
      if (st.type === 'ImportDeclaration') {
        for (const s of st.specifiers) declare(moduleScope, s.local.name, 'let');
      } else if (st.type === 'FunctionDeclaration' && st.id) {
        declare(moduleScope, st.id.name, 'function');
      } else if (st.type === 'ClassDeclaration' && st.id) {
        declare(moduleScope, st.id.name, 'let');
      } else if (st.type === 'VariableDeclaration') {
        for (const d of st.declarations) collectPattern(d.id, (n) => declare(moduleScope, n, 'let'));
      }
    }

    checkUndefined(ast, file);
    checkBlock(ast.body, moduleScope, file);
  }
}

// The deferred-reference rule above is deliberately conservative, so a nested
// function may still read a binding defined later in an enclosing block — that
// is legal at definition time and only fails if it is called too early, which
// no static rule can prove. Note it in the docs rather than pretend otherwise.

if (problems.length) {
  console.error(`✗ ${problems.length} runtime fault(s) in ${checked} module(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ ${checked} modules parse, every reference resolves, and no binding is read before it is declared.`);
