/**
 * Land-surface colour grade for the Blue Marble albedo mosaic.
 *
 * Why this exists
 * ---------------
 * The source mosaic (`2_no_clouds_4k.jpg`) is a multi-year composite of NASA's
 * Blue Marble land-surface product, and it cannot be used as reflectance
 * directly. Three artefacts of that process have to be undone first.
 *
 * 1. The atmosphere is still in the picture. Rayleigh path radiance is added on
 *    top of the surface signal, so every land pixel carries a pedestal of sky
 *    light. That is why the raw mosaic reads as a pastel watercolour: it lifts
 *    the black point and pulls everything toward blue-grey. Removing it is an
 *    additive step, so it has to happen in linear light — the space the addition
 *    actually occurred in.
 *
 * 2. The composite is biased bright. Averaging many days of imagery leaves land
 *    well above its real reflectance: ground that is genuinely mid-grey
 *    (rho ~ 0.15) arrives at rho ~ 0.30, which under a full sun is the
 *    difference between "soil" and "sand". One achromatic exposure below,
 *    fitted to published reflectance values, removes that bias.
 *
 * 3. Two cover types were flattened toward the same middle grey, in opposite
 *    directions, and each needs its own correction:
 *
 *      canopy  — leaf reflectance is ~0.07 and strongly green, but the
 *                composite renders it as a bright, over-saturated green that
 *                reads as radioactive under bloom. Real forest is a
 *                desaturated grey-green: red and blue need to come *up*,
 *                green needs to come *down*.
 *      desert  — sand reflectance is ~0.35 and red-dominant, but the composite
 *                renders it as a pale cream, which after de-hazing turns pink.
 *                Blue has to drop hard to get ochre back.
 *
 * Both have to be decided from the pixel's own spectrum, not its brightness:
 * bright sand and bright canopy must end up different colours, and no single
 * tone curve can do that.
 *
 * Everything here runs once, offline, inside `scripts/fetch-assets.mjs`. The
 * runtime shaders do no colour correction at all, which is the point: grading a
 * baked texture is free, whereas anything done per-pixel in a fragment shader
 * costs frame time on every device forever.
 *
 * Two traps worth recording, because both produced plausible-looking results
 * that were wrong:
 *
 *   • The haze magnitude must be constrained to a blue-dominant shape. Left
 *     free, a least-squares fit "explains" dark canopy by inventing a large
 *     green sky (it chose 0.16 in green against 0.02 in blue), which is not a
 *     colour that exists.
 *   • The exposure must be achromatic. A per-channel exposure fitted to bright
 *     desert also darkens red relative to blue, which rotates hue and is what
 *     made every dune field look pink. Brightness and white balance are
 *     separate corrections and must be applied separately.
 */

// sRGB transfer function, 0..255 <-> 0..1 linear.
export const srgbToLinear = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

export const linearToSrgb = (x) => {
  const v = Math.max(0, x);
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};

/**
 * Published land-cover reflectance (linear). These are what the texture should
 * hold, because the shader adds the atmosphere on top at render time.
 */
export const TARGETS = {
  saharaSand: [0.395, 0.31, 0.212],
  arabia: [0.42, 0.33, 0.22],
  australia: [0.3, 0.215, 0.14],
  gobi: [0.28, 0.225, 0.175],
  amazonCanopy: [0.048, 0.072, 0.036],
  congoCanopy: [0.05, 0.07, 0.04],
  boreal: [0.072, 0.092, 0.066],
  sahelGrass: [0.25, 0.2, 0.13],
  snow: [0.7, 0.74, 0.8],
  iceSheet: [0.76, 0.79, 0.84],
};

const HAZE_SHAPE = [0.35, 0.78, 1.0];
const HAZE_MAGNITUDE = 0.019;

/** Achromatic exposure that removes the composite's bright bias. */
const EXPOSURE = 0.62;

/** Desert: warm pixels drop blue hard to recover ochre. */
const SAND_WINDOW = [0.20, 0.50];
const SAND_GAIN = [1.1, 0.96, 0.58];

/** Canopy: raise red and blue, lower green, toward real grey-green foliage. */
const VEG_WINDOW = [0.05, 0.42];
const VEG_GAIN = [1.18, 0.80, 1.10];

/** Snow and ice: lift toward a cool white. */
const ICE_LIFT = 0.8;
const ICE_TARGET = [0.85, 0.89, 0.96];

/**
 * Grade one land pixel.
 *
 * @param {number} r sRGB 0..255
 * @param {number} g sRGB 0..255
 * @param {number} b sRGB 0..255
 * @returns {[number, number, number]} graded sRGB 0..255
 */
export function gradeLand(r, g, b) {
  // --- 1. De-haze + exposure, in linear light -----------------------------
  const lift = (v, i) => {
    const haze = HAZE_MAGNITUDE * HAZE_SHAPE[i];
    return clamp01((srgbToLinear(v) - haze) / (1 - haze)) * EXPOSURE;
  };
  let lr = lift(r, 0);
  let lg = lift(g, 1);
  let lb = lift(b, 2);

  const luminance = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;

  // --- 2. Spectral classification ----------------------------------------
  // Ice: blue-dominant and bright. The blue test is what separates snow from
  // bright desert — both are luminous, only one is blue-shifted.
  const blueness = (lb - lr) / 0.17;
  const ice = smoothstep(0, 0.55, blueness) * smoothstep(0.17, 0.31, luminance);

  // Warmth is scale-invariant, so it works on bright and dark desert alike.
  // There is deliberately no luminance gate: an earlier version had one, and it
  // excluded every mid-brightness desert on Earth — including Australia, the
  // most famously ochre land there is.
  const warmth = clamp01((lr - lb) / Math.max(lr, 1e-4));
  const sand = smoothstep(SAND_WINDOW[0], SAND_WINDOW[1], warmth) * (1 - ice);

  // Greenness: green rising above the mean of red and blue.
  const greenness = (lg - 0.5 * (lr + lb)) / 0.26;
  const veg = smoothstep(VEG_WINDOW[0], VEG_WINDOW[1], greenness) * (1 - ice) * (1 - sand);

  // --- 3. Per-class corrections ------------------------------------------
  const s = sand;
  lr *= 1 + (SAND_GAIN[0] - 1) * s;
  lg *= 1 + (SAND_GAIN[1] - 1) * s;
  lb *= 1 + (SAND_GAIN[2] - 1) * s;

  const v = veg;
  lr *= 1 + (VEG_GAIN[0] - 1) * v;
  lg *= 1 + (VEG_GAIN[1] - 1) * v;
  lb *= 1 + (VEG_GAIN[2] - 1) * v;

  const iceT = ice * ICE_LIFT;
  lr = lr + (ICE_TARGET[0] - lr) * iceT;
  lg = lg + (ICE_TARGET[1] - lg) * iceT;
  lb = lb + (ICE_TARGET[2] - lb) * iceT;

  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}
