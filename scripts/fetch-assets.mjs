#!/usr/bin/env node
/**
 * Deterministic NASA Earth texture pipeline.
 *
 * Produces the five 4096x2048 equirectangular maps the renderer consumes:
 *
 *   earth_day.jpg       True-colour Blue Marble land albedo + neutral deep-water
 *                       base. Deliberately *not* pre-shaded: relief lighting,
 *                       aerial perspective and ocean optics are all solved per
 *                       pixel in the surface shader, which is what keeps the
 *                       planet from looking like a painted billboard.
 *   earth_night.jpg     Black Marble city emission with the sensor's diffuse
 *                       airglow floor removed (the raw mosaic carries a purple
 *                       wash over every continent that reads as "fake").
 *   earth_specular.jpg  Anti-aliased ocean mask (R = water).
 *   earth_topology.jpg  Continuous height field: bathymetry in [15..85] grey
 *                       levels, SRTM land elevation in [85..255].
 *   earth_clouds.jpg    Cloud optical-density map (NASA cloud climatology),
 *                       alpha-weighted so thin cirrus and dense cumulus both
 *                       survive the JPEG round trip.
 *
 * Usage:
 *   node scripts/fetch-assets.mjs           # regenerate only what is missing
 *   node scripts/fetch-assets.mjs --force   # rebuild every output
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { gradeLand } from './lib/landGrade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'textures');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const FORCE = process.argv.includes('--force');
const TIMEOUT_MS = 90_000;
const ATTEMPTS_PER_SOURCE = 3;

const TARGET_W = 4096;
const TARGET_H = 2048;

// JPEG quality is a realism lever, not a size knob: low quality banding on
// smooth ocean gradients is instantly visible at orbital scale.
const Q_ALBEDO = 93;
const Q_NIGHT = 95;
const Q_MASK = 94;
const Q_CLOUDS = 94;

const THREE_PLANETS = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets';
const THREE_GLOBE = 'https://unpkg.com/three-globe@2/example/img';
const WEBGL_EARTH = 'https://raw.githubusercontent.com/turban/webgl-earth/master/images';

// NASA Visible Earth bathymetry (5400x2700 topo + bathy mosaic).
const NASA_BATHY_JULY = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73751/world.topo.bathy.200407.3x5400x2700.jpg';
const NASA_BATHY_DEC = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg';

// Height-field convention shared by the pipeline and the surface shader.
const HF_OCEAN_MIN = 15; // abyssal plain
const HF_OCEAN_MAX = 85; // continental shelf break
const HF_LAND_MIN = 85; // coastline
const HF_LAND_MAX = 250; // 8 km peaks

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

function probeImage(b) {
  if (isPng(b)) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  if (!isJpeg(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), format: 'jpeg' };
    i += 2 + len;
  }
  return null;
}

function decodeBuffer(buf) {
  if (isPng(buf)) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  const img = jpeg.decode(buf, {
    useTArray: true,
    formatAsRGBA: true,
    maxMemoryUsageInMB: 4096,
    maxResolutionInMP: 300,
  });
  return { width: img.width, height: img.height, data: Buffer.from(img.data) };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x | 0);
const lerp = (a, b, t) => a + (b - a) * clamp01(t);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Bilinear sample of an RGBA image at normalised UV, returning linear-free 0..255. */
function sampleBilinear(img, u, v, out) {
  const x = clamp01(u) * (img.width - 1);
  const y = clamp01(v) * (img.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * img.width + x0) * 4;
  const i10 = (y0 * img.width + x1) * 4;
  const i01 = (y1 * img.width + x0) * 4;
  const i11 = (y1 * img.width + x1) * 4;
  const d = img.data;
  for (let c = 0; c < 3; c += 1) {
    const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * fx;
    const bottom = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * fx;
    out[c] = top + (bottom - top) * fy;
  }
  return out;
}

/**
 * Separable box blur used to tame JPEG blocking on smooth ocean gradients and
 * to widen the coastal shelf ramp without a hard edge.
 */
function boxBlur(src, width, height, radius, passes = 2) {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const r = Math.max(1, radius | 0);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p += 1) {
    // horizontal
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let acc = 0;
      for (let x = -r; x <= r; x += 1) acc += a[row + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x += 1) {
        b[row + x] = acc * norm;
        const add = a[row + Math.min(width - 1, x + r + 1)];
        const sub = a[row + Math.max(0, x - r)];
        acc += add - sub;
      }
    }
    // vertical
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let y = -r; y <= r; y += 1) acc += b[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y += 1) {
        a[y * width + x] = acc * norm;
        const add = b[Math.min(height - 1, y + r + 1) * width + x];
        const sub = b[Math.max(0, y - r) * width + x];
        acc += add - sub;
      }
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const declared = Number(res.headers.get('content-length'));
  const encoding = res.headers.get('content-encoding');
  if (declared > 0 && !encoding && declared !== buf.length) {
    throw new Error(`truncated body (${buf.length} of ${declared} bytes)`);
  }
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function downloadCached(filename, sources, minBytes = 100_000) {
  const cachePath = path.join(CACHE_DIR, filename);
  try {
    const existing = await readFile(cachePath);
    if (existing.length >= minBytes && probeImage(existing)) return existing;
  } catch { /* missing or invalid */ }

  const errors = [];
  for (const src of sources) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_SOURCE; attempt += 1) {
      try {
        console.log(`  ↓ ${filename} ← ${src.note}`);
        const raw = await download(src.url);
        if (!probeImage(raw)) throw new Error('Not a decodable image');
        if (raw.length < minBytes) throw new Error(`File too small: ${raw.length} bytes`);
        await writeFile(cachePath, raw);
        return raw;
      } catch (err) {
        errors.push(`${src.url} [attempt ${attempt}]: ${err.message || err}`);
        if (attempt < ATTEMPTS_PER_SOURCE) await sleep(400 * attempt);
      }
    }
  }
  throw new Error(`All sources failed for ${filename}:\n  ${errors.join('\n  ')}`);
}

/**
 * The bathymetric half of the height field is stable across releases. When the
 * NASA mirrors are unreachable we bootstrap from the previously generated
 * earth_topology.jpg instead of failing the whole pipeline.
 */
async function seedCacheFromOutputs() {
  const pairs = [['raw_heightfield.jpg', 'earth_topology.jpg'], ['raw_night_4096.jpg', 'earth_night.jpg']];
  for (const [cacheName, outName] of pairs) {
    const cachePath = path.join(CACHE_DIR, cacheName);
    try {
      await stat(cachePath);
      continue;
    } catch { /* seed it */ }
    try {
      const buf = await readFile(path.join(OUT_DIR, outName));
      if (probeImage(buf)) await writeFile(cachePath, buf);
    } catch { /* nothing to seed */ }
  }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------
async function buildSpecularMask(waterImg, specImg) {
  const dst = Buffer.alloc(TARGET_W * TARGET_H * 4);
  const tmp = new Float32Array(TARGET_W * TARGET_H);
  const px = [0, 0, 0];

  for (let y = 0; y < TARGET_H; y += 1) {
    const v = y / (TARGET_H - 1);
    for (let x = 0; x < TARGET_W; x += 1) {
      const u = x / (TARGET_W - 1);
      sampleBilinear(waterImg, u, v, px);
      let water = px[0];
      if (specImg) {
        sampleBilinear(specImg, u, v, px);
        // Marginal seas (Mediterranean, Red Sea, Persian Gulf, Caspian) are
        // under-detected in the 4K mask; the 2K NASA specular map fills them.
        water = Math.max(water, px[0]);
      }
      tmp[y * TARGET_W + x] = water / 255;
    }
  }

  // One light blur kills single-pixel speckle, then a contrast curve re-sharpens
  // the shoreline. Without this the mask bleeds a 3-4 km grey halo that reads as
  // a glowing white-blue beach ring from orbit.
  const blurred = boxBlur(tmp, TARGET_W, TARGET_H, 1, 1);
  for (let i = 0; i < blurred.length; i += 1) {
    const idx = i * 4;
    const centred = smoothstep(0.30, 0.72, blurred[i]);
    const v = clamp255(centred * 255);
    dst[idx] = v;
    dst[idx + 1] = v;
    dst[idx + 2] = v;
    dst[idx + 3] = 255;
  }
  const encoded = jpeg.encode({ width: TARGET_W, height: TARGET_H, data: dst }, Q_MASK);
  return Buffer.from(encoded.data);
}

async function buildHeightField(heightFieldImg, srtmImg, waterMask) {
  const dst = Buffer.alloc(TARGET_W * TARGET_H * 4);
  const ocean = new Float32Array(TARGET_W * TARGET_H);
  const land = new Float32Array(TARGET_W * TARGET_H);
  const px = [0, 0, 0];

  for (let y = 0; y < TARGET_H; y += 1) {
    const v = y / (TARGET_H - 1);
    for (let x = 0; x < TARGET_W; x += 1) {
      const u = x / (TARGET_W - 1);
      const idx = y * TARGET_W + x;
      const isLand = waterMask[idx * 4] < 128;

      sampleBilinear(heightFieldImg, u, v, px);
      const hf = px[0];

      if (isLand) {
        let elevation = 0;
        if (srtmImg) {
          sampleBilinear(srtmImg, u, v, px);
          elevation = px[0];
        } else {
          elevation = Math.max(0, hf - HF_LAND_MIN) * (HF_LAND_MAX - HF_LAND_MIN) / (255 - HF_LAND_MIN);
        }
        land[idx] = elevation;
        ocean[idx] = HF_OCEAN_MAX;
      } else {
        // Depth from the bathymetric mosaic, normalised to the ocean band.
        const depth = clamp01((hf - HF_OCEAN_MIN) / (HF_OCEAN_MAX - HF_OCEAN_MIN));
        ocean[idx] = HF_OCEAN_MIN + depth * (HF_OCEAN_MAX - HF_OCEAN_MIN);
        land[idx] = 0;
      }
    }
  }

  // Ocean depth is a smooth low-frequency field: blur it so JPEG block noise
  // never shows up as contour bands through the deep-water shading.
  const oceanSmooth = boxBlur(ocean, TARGET_W, TARGET_H, 2, 2);
  const landSmooth = boxBlur(land, TARGET_W, TARGET_H, 1, 1);

  for (let i = 0; i < TARGET_W * TARGET_H; i += 1) {
    const water = waterMask[i * 4] / 255;
    const oceanValue = oceanSmooth[i];
    // Continuous shelf: land elevation starts exactly at the coastline value so
    // the shader can derive a shoreline normal without a step discontinuity.
    const landValue = HF_LAND_MIN + clamp01(landSmooth[i] / 255) * (HF_LAND_MAX - HF_LAND_MIN);
    const value = clamp255(lerp(oceanValue, landValue, water * 0.0 + (1 - water)));
    const idx = i * 4;
    dst[idx] = value;
    dst[idx + 1] = value;
    dst[idx + 2] = value;
    dst[idx + 3] = 255;
  }

  const encoded = jpeg.encode({ width: TARGET_W, height: TARGET_H, data: dst }, Q_MASK);
  return Buffer.from(encoded.data);
}

/**
 * Land albedo + neutral deep-water base.
 *
 * The previous pass painted a synthetic turquoise bathymetry palette into the
 * map itself, which produced the "white-blue beach" halo and a cartoon ocean.
 * Ocean colour is now pure shading; this map only needs a believable base tone.
 */
async function buildAlbedo(trueColorImg, waterMask) {
  const dst = Buffer.alloc(TARGET_W * TARGET_H * 4);
  const px = [0, 0, 0];

  for (let y = 0; y < TARGET_H; y += 1) {
    const v = y / (TARGET_H - 1);
    for (let x = 0; x < TARGET_W; x += 1) {
      const u = x / (TARGET_W - 1);
      const idx = y * TARGET_W + x;
      const water = waterMask[idx * 4] / 255;

      if (water > 0.98) {
        // Deep-water base: cool, very dark, no saturation so the shader's
        // Fresnel sky reflection and sun glitter own the final look.
        dst[idx * 4] = 9;
        dst[idx * 4 + 1] = 21;
        dst[idx * 4 + 2] = 34;
        dst[idx * 4 + 3] = 255;
        continue;
      }

      sampleBilinear(trueColorImg, u, v, px);
      // Undo the composite's baked-in atmosphere and restore the reflectance
      // spread that averaging flattened. See scripts/lib/landGrade.mjs.
      const graded = gradeLand(px[0], px[1], px[2]);
      let r = graded[0];
      let g = graded[1];
      let b = graded[2];

      // Blend the last kilometre of coastline toward the water base so the
      // anti-aliased mask edge never shows a bright sand/cyan seam.
      if (water > 0.02) {
        const t = smoothstep(0.02, 0.98, water);
        r = lerp(r, 9, t);
        g = lerp(g, 21, t);
        b = lerp(b, 34, t);
      }

      dst[idx * 4] = clamp255(r);
      dst[idx * 4 + 1] = clamp255(g);
      dst[idx * 4 + 2] = clamp255(b);
      dst[idx * 4 + 3] = 255;
    }
  }

  const encoded = jpeg.encode({ width: TARGET_W, height: TARGET_H, data: dst }, Q_ALBEDO);
  return Buffer.from(encoded.data);
}

/**
 * Black Marble city emission.
 *
 * The raw mosaic carries a broad airglow pedestal: unpopulated desert sits at
 * luma 35 (Sahara), 23 (Australian outback) and the mosaic's 90th percentile is
 * 49 out of 255. Without removal every continent glows a flat purple and the
 * night side reads as a texture, not as a photograph.
 *
 * We estimate that pedestal with a morphological opening (min filter at 8x
 * downsample, then a wide blur) and keep only what rises above it. That
 * preserves villages and highway filaments while the deserts go truly black.
 */
async function buildNight(nightImg) {
  const dst = Buffer.alloc(TARGET_W * TARGET_H * 4);
  const n = TARGET_W * TARGET_H;
  const px = [0, 0, 0];
  const lum = new Float32Array(n);

  for (let y = 0; y < TARGET_H; y += 1) {
    const v = y / (TARGET_H - 1);
    for (let x = 0; x < TARGET_W; x += 1) {
      const u = x / (TARGET_W - 1);
      sampleBilinear(nightImg, u, v, px);
      lum[y * TARGET_W + x] = luma(px[0], px[1], px[2]) / 255;
    }
  }

  // Pedestal estimate: 8x min-downsample (kills compact cities), then blur the
  // coarse grid so the estimate becomes a smooth airglow field, then upsample.
  const DS = 8;
  const gw = Math.ceil(TARGET_W / DS);
  const gh = Math.ceil(TARGET_H / DS);
  const grid = new Float32Array(gw * gh).fill(1);
  for (let y = 0; y < TARGET_H; y += 1) {
    const gy = (y / DS) | 0;
    for (let x = 0; x < TARGET_W; x += 1) {
      const gx = (x / DS) | 0;
      const value = lum[y * TARGET_W + x];
      const gi = gy * gw + gx;
      if (value < grid[gi]) grid[gi] = value;
    }
  }
  const gridBlur = boxBlur(grid, gw, gh, 6, 3);

  for (let y = 0; y < TARGET_H; y += 1) {
    const gy = Math.min(gh - 1, y / DS);
    const gy0 = Math.floor(gy);
    const gy1 = Math.min(gh - 1, gy0 + 1);
    const fy = gy - gy0;
    for (let x = 0; x < TARGET_W; x += 1) {
      const gx = Math.min(gw - 1, x / DS);
      const gx0 = Math.floor(gx);
      const gx1 = Math.min(gw - 1, gx0 + 1);
      const fx = gx - gx0;
      const bgTop = gridBlur[gy0 * gw + gx0] + (gridBlur[gy0 * gw + gx1] - gridBlur[gy0 * gw + gx0]) * fx;
      const bgBottom = gridBlur[gy1 * gw + gx0] + (gridBlur[gy1 * gw + gx1] - gridBlur[gy1 * gw + gx0]) * fx;
      const bg = bgTop + (bgBottom - bgTop) * fy;

      const l = lum[y * TARGET_W + x];
      // Keep 92% of the pedestal subtracted so the faintest settlements survive.
      const emission = clamp01((l - bg * 0.92) / (1 - 0.32));
      const shaped = emission > 0 ? Math.pow(emission, 0.86) : 0;
      // Subtle warm bias baked in; the shader adds the per-density colour
      // temperature ladder (sodium amber -> LED white).
      const value = clamp255(shaped * 1.06 * 255);
      const idx = (y * TARGET_W + x) * 4;
      dst[idx] = value;
      dst[idx + 1] = clamp255(value * 0.955);
      dst[idx + 2] = clamp255(value * 0.88);
      dst[idx + 3] = 255;
    }
  }

  // Two gentle blur passes remove JPEG mosquito noise between individual
  // streetlights; roads stay visible because their contrast is much higher.
  const smooth = boxBlur(
    Float32Array.from({ length: n }, (_, i) => dst[i * 4]),
    TARGET_W, TARGET_H, 1, 1,
  );
  for (let i = 0; i < n; i += 1) {
    const value = clamp255(Math.round(smooth[i]));
    dst[i * 4] = value;
    dst[i * 4 + 1] = clamp255(Math.round(value * 0.955));
    dst[i * 4 + 2] = clamp255(Math.round(value * 0.88));
  }

  const encoded = jpeg.encode({ width: TARGET_W, height: TARGET_H, data: dst }, Q_NIGHT);
  return Buffer.from(encoded.data);
}

/**
 * Cloud optical density from NASA's cloud climatology mosaic.
 *
 * fair_clouds_4k is a multi-day composite: it stores coverage in alpha (mean
 * 0.15, p90 0.54) and its RGB payload is essentially white, so alpha *is* the
 * optical depth. Two of its properties need cleaning before it can drive a
 * shader that will be inspected from 50 km:
 *
 *   • Salt-and-pepper alpha noise that renders as white speckle,
 *   • thin full-width discontinuities where the source tiles were stitched,
 *     which show up as horizontal seams circling the planet.
 *
 * A 3x3 median removes the speckle without eating real cirrus filaments, and a
 * 1.5-pixel vertical blur melts the stitching lines.
 */
async function buildClouds(cloudImg) {
  const n = TARGET_W * TARGET_H;
  const raw = new Float32Array(n);

  for (let y = 0; y < TARGET_H; y += 1) {
    const sy = Math.min(cloudImg.height - 1, Math.round((y / (TARGET_H - 1)) * (cloudImg.height - 1)));
    for (let x = 0; x < TARGET_W; x += 1) {
      const sx = Math.min(cloudImg.width - 1, Math.round((x / (TARGET_W - 1)) * (cloudImg.width - 1)));
      raw[y * TARGET_W + x] = cloudImg.data[(sy * cloudImg.width + sx) * 4 + 3] / 255;
    }
  }

  // --- 5x5 median ---
  // The mosaic is assembled from swaths, so it carries both salt-and-pepper
  // coverage noise and 1-2 px straight seam lines. A 3x3 median removes the
  // speckle; the 5x5 window is what actually erases the seam lines, and it
  // still preserves 10+ px cumulus structure, which is all the deck needs at
  // the resolutions this renderer displays.
  const median = new Float32Array(n);
  const win = new Float32Array(25);
  for (let y = 0; y < TARGET_H; y += 1) {
    for (let x = 0; x < TARGET_W; x += 1) {
      let k = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        const yy = Math.min(TARGET_H - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx += 1) {
          // wrap in longitude so there is no seam at the antimeridian
          const xx = (x + dx + TARGET_W) % TARGET_W;
          win[k++] = raw[yy * TARGET_W + xx];
        }
      }
      for (let i = 1; i < 25; i += 1) {
        const v = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j -= 1; }
        win[j + 1] = v;
      }
      median[y * TARGET_W + x] = win[12];
    }
  }

  const smooth = boxBlur(median, TARGET_W, TARGET_H, 1, 1);

  const dst = Buffer.alloc(n * 4);
  // Store coverage linearly. An earlier pass applied a 0.70 gamma lift here to
  // "make the clouds brighter", which also lifted half the clear sky off zero
  // and turned the whole planet under a grey film; the shader cannot remove a
  // veil it cannot distinguish from cloud. Contrast shaping belongs in
  // `cloudDensity()` in lib/clouds.glsl, where it stays tunable.
  for (let i = 0; i < n; i += 1) {
    const density = clamp01(smooth[i]);
    const value = clamp255(density * 255);
    dst[i * 4] = value;
    dst[i * 4 + 1] = value;
    dst[i * 4 + 2] = value;
    dst[i * 4 + 3] = 255;
  }

  const encoded = jpeg.encode({ width: TARGET_W, height: TARGET_H, data: dst }, Q_CLOUDS);
  return Buffer.from(encoded.data);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const REQUIRED_OUTPUTS = [
  ['earth_day.jpg', 300_000],
  ['earth_night.jpg', 100_000],
  ['earth_specular.jpg', 200_000],
  ['earth_topology.jpg', 200_000],
  ['earth_clouds.jpg', 200_000],
];

async function allOutputsValid() {
  for (const [file, minBytes] of REQUIRED_OUTPUTS) {
    try {
      const p = path.join(OUT_DIR, file);
      const stats = await stat(p);
      if (stats.size < minBytes) return false;
      if (!probeImage(await readFile(p))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  console.log(`\n🌍  Earth texture pipeline → ${path.relative(ROOT, OUT_DIR)}${FORCE ? ' (forced)' : ''}`);

  if (!FORCE && (await allOutputsValid())) {
    console.log('  ✔ All 5 maps present and valid — skipping download & synthesis.');
    console.log('    Run with --force to rebuild.\n');
    return;
  }

  await seedCacheFromOutputs();

  console.log('  ⬇  Fetching source imagery…');
  const [cloudsBuf, trueColorBuf, waterBuf, nightBuf, srtmBuf, heightFieldBuf] = await Promise.all([
    downloadCached('raw_clouds.jpg', [
      { url: `${WEBGL_EARTH}/fair_clouds_4k.png`, note: 'NASA cloud climatology 4K' },
      { url: `${THREE_PLANETS}/earth_bump_roughness_clouds_4096.jpg`, note: 'three.js packed 4K (B = clouds)' },
    ], 200_000),

    downloadCached('raw_truecolor_4k.jpg', [
      { url: `${WEBGL_EARTH}/2_no_clouds_4k.jpg`, note: 'Blue Marble NextGen 4K true colour' },
      { url: `${THREE_PLANETS}/earth_atmos_2048.jpg`, note: 'three.js planetary fallback' },
    ], 300_000),

    downloadCached('raw_water_4k.png', [
      { url: `${WEBGL_EARTH}/water_4k.png`, note: '4K ocean mask' },
    ], 400_000),

    downloadCached('raw_night_4096.jpg', [
      { url: `${THREE_PLANETS}/earth_night_4096.jpg`, note: 'Black Marble 4K' },
      { url: `${THREE_GLOBE}/earth-night.jpg`, note: 'three-globe night' },
    ], 100_000),

    downloadCached('raw_srtm_4k.jpg', [
      { url: `${WEBGL_EARTH}/elev_bump_4k.jpg`, note: 'SRTM elevation 4K' },
      { url: `${THREE_GLOBE}/earth-topology.png`, note: 'three-globe topology' },
    ], 100_000),

    downloadCached('raw_heightfield.jpg', [
      { url: NASA_BATHY_JULY, note: 'NASA topo + bathymetry 5400x2700' },
      { url: NASA_BATHY_DEC, note: 'NASA topo + bathymetry (Dec) 5400x2700' },
      { url: `${THREE_PLANETS}/earth_day_4096.jpg`, note: 'three.js Blue Marble fallback' },
    ], 200_000),
  ]);

  console.log('  ⚙  Decoding sources…');
  const cloudsImg = decodeBuffer(cloudsBuf);
  const trueColorImg = decodeBuffer(trueColorBuf);
  const waterImg = decodeBuffer(waterBuf);
  const nightImg = decodeBuffer(nightBuf);
  const srtmImg = decodeBuffer(srtmBuf);
  const heightFieldImg = decodeBuffer(heightFieldBuf);

  console.log('  ⚙  4K ocean mask…');
  const specular = await buildSpecularMask(waterImg, null);
  await writeFile(path.join(OUT_DIR, 'earth_specular.jpg'), specular);
  console.log(`  ✔  earth_specular.jpg  ${mb(specular.length)}`);

  const waterMask = Buffer.from(decodeBuffer(specular).data);

  console.log('  ⚙  Cloud optical density…');
  const clouds = await buildClouds(cloudsImg);
  await writeFile(path.join(OUT_DIR, 'earth_clouds.jpg'), clouds);
  console.log(`  ✔  earth_clouds.jpg  ${mb(clouds.length)}`);

  console.log('  ⚙  Land albedo + deep-water base…');
  const albedo = await buildAlbedo(trueColorImg, waterMask);
  await writeFile(path.join(OUT_DIR, 'earth_day.jpg'), albedo);
  console.log(`  ✔  earth_day.jpg  ${mb(albedo.length)}`);

  console.log('  ⚙  Height field (bathymetry + SRTM)…');
  const heightField = await buildHeightField(heightFieldImg, srtmImg, waterMask);
  await writeFile(path.join(OUT_DIR, 'earth_topology.jpg'), heightField);
  console.log(`  ✔  earth_topology.jpg  ${mb(heightField.length)}`);

  console.log('  ⚙  City emission (airglow removed)…');
  const night = await buildNight(nightImg);
  await writeFile(path.join(OUT_DIR, 'earth_night.jpg'), night);
  console.log(`  ✔  earth_night.jpg  ${mb(night.length)}`);

  const manifest = [];
  for (const [file] of REQUIRED_OUTPUTS) {
    const p = path.join(OUT_DIR, file);
    const buf = await readFile(p);
    const info = probeImage(buf);
    const size = await stat(p);
    manifest.push({
      file,
      width: info.width,
      height: info.height,
      bytes: size.size,
      sha256: createHash('sha256').update(buf).digest('hex'),
    });
    console.log(`  ★  ${file.padEnd(20)} ${`${info.width}x${info.height}`.padEnd(10)} ${mb(size.size).padStart(9)}`);
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('\n✨  Textures rebuilt.\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
