#!/usr/bin/env node
/**
 * Verify the initial EffectComposer / bloom dimensions without creating a GPU.
 *
 * The composer expects its supplied render target to be in logical pixels and
 * applies the renderer DPR itself. This catches accidental DPR double-scaling
 * before it inflates bloom buffers on high-density screens.
 */
import assert from 'node:assert/strict';
import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import { canUseFloatMsaa, getMaxPixelRatio } from '../src/renderBudget.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

for (const dpr of [1, 1.5, 2]) {
  const width = 1024;
  const height = 768;
  const renderer = { getPixelRatio: () => dpr };
  const composer = new EffectComposer(
    renderer,
    new WebGLRenderTarget(width, height, { type: HalfFloatType }),
  );
  composer.setSize(width, height);

  const bloom = new UnrealBloomPass(new Vector2(width, height), 0.34, 0.62, 1.05);
  composer.addPass(bloom);

  assert.deepEqual(
    [composer.renderTarget1.width, composer.renderTarget1.height],
    [width * dpr, height * dpr],
    `composer target should apply DPR ${dpr} exactly once`,
  );
  assert.deepEqual(
    [bloom.renderTargetBright.width, bloom.renderTargetBright.height],
    [Math.round((width * dpr) / 2), Math.round((height * dpr) / 2)],
    `bloom target should use half-resolution at DPR ${dpr}`,
  );

  bloom.dispose();
  composer.dispose();
}

const mobileRatio = getMaxPixelRatio({ width: 390, height: 844, devicePixelRatio: 3, pixelBudget: 2_500_000 });
assert.equal(mobileRatio, 2, 'phone DPR should remain capped at 2× within the mobile pixel budget');
const tabletRatio = getMaxPixelRatio({ width: 1024, height: 1366, devicePixelRatio: 2, pixelBudget: 2_500_000 });
assert.ok(1024 * 1366 * tabletRatio ** 2 <= 2_500_000 + 4_000, 'large tablet should respect its pixel budget');
const desktopRatio = getMaxPixelRatio({ width: 1200, height: 905, devicePixelRatio: 2, pixelBudget: 4_000_000 });
assert.ok(1200 * 905 * desktopRatio ** 2 <= 4_000_000 + 4_000, 'high-DPR desktop should respect its pixel budget');

const msaaBase = { maxSamples: 4, floatColorBuffer: true, deviceMemoryGiB: 8 };
assert.equal(canUseFloatMsaa({ ...msaaBase, width: 1024, height: 768, pixelRatio: 1 }), true);
assert.equal(canUseFloatMsaa({ ...msaaBase, width: 390, height: 844, pixelRatio: 2, coarsePointer: true }), false);
assert.equal(canUseFloatMsaa({ ...msaaBase, width: 1200, height: 905, pixelRatio: 2 }), false);
assert.equal(canUseFloatMsaa({ ...msaaBase, width: 1024, height: 768, pixelRatio: 1, deviceMemoryGiB: 4 }), false);

console.log('✓ composer/bloom DPR sizing and mobile/high-DPR pixel/MSAA budgets pass.');
