#!/usr/bin/env node
/**
 * Device-independent profile of this scene's large memory costs.
 *
 * Texture and geometry byte counts come from the checked-in assets and the
 * actual Three.js geometries used by the scene. GPU allocations are estimates:
 * RGBA8 images with complete mip chains, RGBA16F composer/bloom targets, depth
 * buffers, and (when eligible) 4x multisample storage. Driver padding, shader
 * programs, browser image caches, and swapchain buffering are not included.
 * This script cannot measure real frame time; use `?profile=1` in a browser for
 * live FPS, draw-call, CPU-submit, and estimated-memory readouts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SphereGeometry } from 'three';
import {
  canUseFloatMsaa,
  CONSTRAINED_RENDER_PIXEL_BUDGET,
  DESKTOP_RENDER_PIXEL_BUDGET,
  getMaxPixelRatio,
} from '../src/renderBudget.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEXTURE_DIR = path.join(ROOT, 'public/textures');
const MIB = 1024 * 1024;

function jpegDimensions(file) {
  const bytes = fs.readFileSync(file);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`${file} is not a JPEG`);
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = bytes.readUInt16BE(offset);
    if (sof.has(marker)) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  throw new Error(`Could not find JPEG dimensions in ${file}`);
}

function mipChainBytes(width, height, bytesPerPixel = 4) {
  let total = 0;
  while (true) {
    total += width * height * bytesPerPixel;
    if (width === 1 && height === 1) return total;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

function geometryBytes(geometry) {
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  if (geometry.index) bytes += geometry.index.array.byteLength;
  return bytes;
}

const textureFiles = fs.readdirSync(TEXTURE_DIR).filter((name) => /\.jpe?g$/i.test(name));
let textureGpuBytes = 0;
let decodedImageBytes = 0;
for (const name of textureFiles) {
  const { width, height } = jpegDimensions(path.join(TEXTURE_DIR, name));
  const base = width * height * 4;
  const mip = mipChainBytes(width, height);
  textureGpuBytes += mip;
  decodedImageBytes += base;
  console.log(`${name.padEnd(22)} ${width}x${height}  RGBA+mips ${(mip / MIB).toFixed(2)} MiB`);
}

const surface = new SphereGeometry(1, 320, 240);
surface.computeTangents();
const geometries = [
  ['surface + tangents', surface],
  ['cloud tops', new SphereGeometry(1, 192, 192)],
  ['upper veil', new SphereGeometry(1, 160, 160)],
  ['atmosphere', new SphereGeometry(1, 96, 64)],
  ['Milky Way shell', new SphereGeometry(1, 96, 64)],
];
let geometryGpuBytes = geometries.reduce((sum, [, geometry]) => sum + geometryBytes(geometry), 0);
geometryGpuBytes += 16_000 * (3 * 4 + 3 * 4 + 4 + 4); // star position, RGB, size, magnitude
geometryGpuBytes += 12 * (3 * 4 + 4); // 12 beacon positions + phases
geometryGpuBytes += 256 * 3 * 4 + 3 * 4; // LEO orbit path + ground marker position buffers

function targetBytes(width, height, pixelRatio, samples) {
  const drawWidth = Math.ceil(width * pixelRatio);
  const drawHeight = Math.ceil(height * pixelRatio);
  const pixels = drawWidth * drawHeight;

  // Two full-resolution RGBA16F composer colors, each with a depth buffer.
  const composer = 2 * pixels * (8 + 4);
  const multisample = samples > 0 ? 2 * pixels * samples * (8 + 4) : 0;

  // UnrealBloomPass has one half-resolution bright target and five horizontal
  // + five vertical mip targets, all RGBA16F and depthless.
  let bloomPixels = 0;
  let mipWidth = Math.round(drawWidth / 2);
  let mipHeight = Math.round(drawHeight / 2);
  bloomPixels += mipWidth * mipHeight;
  for (let i = 0; i < 5; i += 1) {
    bloomPixels += 2 * mipWidth * mipHeight;
    mipWidth = Math.round(mipWidth / 2);
    mipHeight = Math.round(mipHeight / 2);
  }
  const bloom = bloomPixels * 8;
  const backbuffer = pixels * 4; // one RGBA8 browser drawing buffer
  return { drawWidth, drawHeight, pixels, composer, multisample, bloom, backbuffer };
}

const devices = [
  { name: 'Phone / high-DPR', width: 390, height: 844, dpr: 3, memory: 4, coarse: true, budget: CONSTRAINED_RENDER_PIXEL_BUDGET },
  { name: 'Tablet / high-DPR', width: 1024, height: 1366, dpr: 2, memory: 4, coarse: true, budget: CONSTRAINED_RENDER_PIXEL_BUDGET },
  { name: 'Desktop / Retina', width: 1200, height: 905, dpr: 2, memory: 8, coarse: false, budget: DESKTOP_RENDER_PIXEL_BUDGET },
  { name: 'Large desktop', width: 1440, height: 900, dpr: 2, memory: 8, coarse: false, budget: DESKTOP_RENDER_PIXEL_BUDGET },
  { name: 'Desktop / 1x', width: 1024, height: 768, dpr: 1, memory: 8, coarse: false, budget: DESKTOP_RENDER_PIXEL_BUDGET },
];

console.log(`\nTexture assets: ${(textureGpuBytes / MIB).toFixed(1)} MiB GPU estimate; ${(decodedImageBytes / MIB).toFixed(1)} MiB decoded base images.`);
console.log(`Scene geometry buffers: ${(geometryGpuBytes / MIB).toFixed(1)} MiB estimate (including star/beacon attributes).`);
console.log('\nDevice model (not a physical-device FPS test):');
for (const device of devices) {
  const pixelRatio = getMaxPixelRatio({
    width: device.width,
    height: device.height,
    devicePixelRatio: device.dpr,
    pixelBudget: device.budget,
  });
  const useMsaa = canUseFloatMsaa({
    width: device.width,
    height: device.height,
    pixelRatio,
    maxSamples: 4,
    floatColorBuffer: true,
    coarsePointer: device.coarse,
    deviceMemoryGiB: device.memory,
  });
  const targets = targetBytes(device.width, device.height, pixelRatio, useMsaa ? 4 : 0);
  const targetGpuBytes = targets.composer + targets.multisample + targets.bloom + targets.backbuffer;
  const totalGpuBytes = textureGpuBytes + geometryGpuBytes + targetGpuBytes;
  console.log(
    `${device.name.padEnd(22)} DPR ${pixelRatio.toFixed(2)} · ${targets.drawWidth}×${targets.drawHeight} ` +
    `(${(targets.pixels / 1e6).toFixed(2)} MP) · MSAA ${useMsaa ? '4x' : 'off/FXAA'} · ` +
    `targets ${(targetGpuBytes / MIB).toFixed(0)} MiB · GPU estimate ${(totalGpuBytes / MIB).toFixed(0)} MiB`,
  );
}

console.log('\nFPS remains hardware-dependent; run the app with ?profile=1 on the target device for live frame and renderer counters.');
