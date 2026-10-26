// Keep device resolution and multisampling inside a predictable render budget.
// DPR alone is not a useful proxy for cost: 2x on a phone and 2x on a 4K canvas
// have very different pixel counts and render-target footprints.
export const MAX_DEVICE_PIXEL_RATIO = 2;
export const DESKTOP_RENDER_PIXEL_BUDGET = 4_000_000;
export const CONSTRAINED_RENDER_PIXEL_BUDGET = 2_500_000;
export const MSAA_PIXEL_BUDGET = 1_500_000;

/**
 * Maximum renderer DPR for a CSS viewport and physical-pixel budget.
 *
 * @param {{ width: number, height: number, devicePixelRatio?: number, pixelBudget: number }} options
 */
export function getMaxPixelRatio({ width, height, devicePixelRatio = 1, pixelBudget }) {
  const cssPixels = Math.max(1, width) * Math.max(1, height);
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const budgetCap = Math.sqrt(Math.max(1, pixelBudget) / cssPixels);
  return Math.max(0.5, Math.min(dpr, MAX_DEVICE_PIXEL_RATIO, budgetCap));
}

/**
 * 4x float MSAA is reserved for small, fine-pointer targets. The multisample
 * color/depth renderbuffers can otherwise cost more memory than the scene.
 *
 * @param {{ width: number, height: number, pixelRatio: number, maxSamples: number, floatColorBuffer: boolean, coarsePointer?: boolean, deviceMemoryGiB?: number, disabled?: boolean }} options
 */
export function canUseFloatMsaa({
  width,
  height,
  pixelRatio,
  maxSamples,
  floatColorBuffer,
  coarsePointer = false,
  deviceMemoryGiB = 0,
  disabled = false,
}) {
  const pixels = Math.ceil(width * pixelRatio) * Math.ceil(height * pixelRatio);
  const memoryLimited = deviceMemoryGiB > 0 && deviceMemoryGiB <= 4;
  return (
    !disabled &&
    floatColorBuffer &&
    maxSamples >= 4 &&
    !coarsePointer &&
    !memoryLimited &&
    pixelRatio <= 1.25 &&
    pixels <= MSAA_PIXEL_BUDGET
  );
}
