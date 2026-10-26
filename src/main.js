import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

import { createEarth } from './earth.js';
import { createBeacons } from './beacons.js';
import { createStarfield } from './starfield.js';
import { solarPosition } from './solar.js';
import { latLngToVector3, formatLatLng } from './geo.js';
import { CITIES, getCityLocalTime } from './cities.js';
import {
  createLEOTracker,
  isSatelliteEclipsed,
  LEO_ALTITUDE_KM,
  LEO_INCLINATION_DEG,
  LEO_ORBITAL_PERIOD_MINUTES,
  LEO_ORBITAL_SPEED_KM_S,
} from './leoTracker.js';
import {
  canUseFloatMsaa,
  CONSTRAINED_RENDER_PIXEL_BUDGET,
  DESKTOP_RENDER_PIXEL_BUDGET,
  getMaxPixelRatio,
} from './renderBudget.js';

// ---------------------------------------------------------------------------
// Fatal error overlay & diagnostics
// ---------------------------------------------------------------------------
const loaderEl = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const fatalEl = document.getElementById('fatal');
const fatalTitleEl = document.getElementById('fatal-title');
const fatalMsgEl = document.getElementById('fatal-msg');
const fatalReloadEl = document.getElementById('fatal-reload');
const fatalDismissEl = document.getElementById('fatal-dismiss');

/**
 * Errors that carry no information and no action.
 *
 * `Script error.` is what the browser reports for an exception from another
 * origin — there is no message, no file and no stack, so showing it tells a
 * visitor nothing except that something, somewhere, went wrong.
 * ResizeObserver's loop warning is emitted by the browser itself when a resize
 * handler changes layout, and is not an exception.
 */
const UNACTIONABLE = ['Script error.', 'ResizeObserver loop'];

// A throwing frame is not a dead app: the animation loop schedules the next
// frame before it does any work, so one bad frame is followed by a good one.
// The panel therefore has to distinguish the two cases, and it must not be
// permanent: an error surface that blacks out a running scene turns a transient
// glitch into a total outage.
let fatalIsBlocking = false;
let lastFatalMessage = '';

function reportFatal(msg, { blocking = false } = {}) {
  const text = String(msg ?? 'Unknown error');
  if (UNACTIONABLE.some((frag) => text.includes(frag))) return;
  console.error(text);

  if (blocking) fatalIsBlocking = true;
  // A blocking failure is never downgraded by a later soft one, and the same
  // string repeated every frame must not rebuild the panel each time.
  if (text === lastFatalMessage && !blocking) return;
  lastFatalMessage = text;

  if (!fatalEl) return;
  if (fatalTitleEl) {
    fatalTitleEl.textContent = fatalIsBlocking ? 'Orbital Engine Error' : 'Runtime warning';
  }
  if (fatalMsgEl) fatalMsgEl.textContent = text;
  // The loader would otherwise sit on top of the panel forever when init dies
  // before it finished.
  if (fatalIsBlocking) loaderEl?.classList.add('done');
  fatalEl.classList.toggle('blocking', fatalIsBlocking);
  if (fatalDismissEl) fatalDismissEl.hidden = fatalIsBlocking;
  fatalEl.removeAttribute('hidden');
}

fatalReloadEl?.addEventListener('click', () => window.location.reload());
fatalDismissEl?.addEventListener('click', () => {
  if (fatalIsBlocking) return;
  fatalEl?.setAttribute('hidden', '');
  lastFatalMessage = '';
});

window.addEventListener('error', (e) => {
  reportFatal(e.message || String(e.error ?? e));
});
window.addEventListener('unhandledrejection', (e) => {
  reportFatal(e.reason?.message || String(e.reason));
});

// ---------------------------------------------------------------------------
// Renderer & Core Scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
if (!canvas) {
  throw new Error('Canvas element #scene not found');
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // MSAA is applied on the HDR composer target instead
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
  stencil: false,
});
const profileMode = new URLSearchParams(window.location.search).get('profile') === '1';
document.documentElement.classList.toggle('profile-mode', profileMode);
renderer.info.autoReset = !profileMode;
const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const deviceMemoryGiB = Number(navigator.deviceMemory) || 0;
const constrainedDevice = coarsePointer || (deviceMemoryGiB > 0 && deviceMemoryGiB <= 4);
const renderPixelBudget = constrainedDevice
  ? CONSTRAINED_RENDER_PIXEL_BUDGET
  : DESKTOP_RENDER_PIXEL_BUDGET;
const maxPixelRatioForViewport = (width, height) =>
  getMaxPixelRatio({
    width,
    height,
    devicePixelRatio: window.devicePixelRatio || 1,
    pixelBudget: renderPixelBudget,
  });
let MAX_PIXEL_RATIO = maxPixelRatioForViewport(window.innerWidth, window.innerHeight);
// Minimum time between adaptive-resolution steps. Long enough that a step gets
// several measurement windows to prove itself before the controller reacts.
const ADAPT_DWELL_MS = 4000;
// HUD text is throttled: four updates a second is faster than a reader can
// follow and avoids invalidating layout on every frame.
const HUD_INTERVAL_MS = 250;

/**
 * Writes text only when it changed.
 *
 * Assigning `textContent` unconditionally dirties the element even when the
 * string is identical, which is the expensive part: it forces the browser to
 * re-measure and re-paint the HUD. Comparing first makes an idle readout free.
 */
function writeText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

/**
 * Whether the visitor has asked for reduced motion.
 *
 * Read from the media query, not from a stored preference: it can change while
 * the page is open, and the scene is a full-screen continuous animation where
 * respecting it is the difference between usable and nauseating.
 */
const motionPreferenceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const prefersReducedMotion = motionPreferenceQuery?.matches ?? false;
let pixelRatio = MAX_PIXEL_RATIO;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

/**
 * Reads the `// program: <key>` breadcrumb that `composeShader` prepends, so a
 * driver error names the program instead of only its line number.
 */
function programNameOf(gl, shader) {
  try {
    const source = gl.getShaderSource(shader) || '';
    const match = source.match(/^\/\/ program: (\w+)/m);
    return match ? match[1] : 'unknown program';
  } catch {
    return 'unknown program';
  }
}

renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
  const vLog = (gl.getShaderInfoLog(glVertexShader) || '').trim();
  const fLog = (gl.getShaderInfoLog(glFragmentShader) || '').trim();
  const sections = ['Shader compile failed'];
  if (vLog) sections.push(`vertex — ${programNameOf(gl, glVertexShader)}\n${vLog}`);
  if (fLog) sections.push(`fragment — ${programNameOf(gl, glFragmentShader)}\n${fLog}`);
  reportFatal(sections.join('\n\n'), { blocking: true });
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// near = 0.001 allows a 50 km descent with no near-plane clipping
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.001, 1200);
camera.position.set(0.6, 0.35, 3.0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.rotateSpeed = 0.42;
controls.zoomSpeed = 0.75;
controls.enablePan = false;
controls.minDistance = 1.0085;
controls.maxDistance = 7.0;
controls.zoomToCursor = false;

// ---------------------------------------------------------------------------
// Post-Processing: HDR + budgeted MSAA/FXAA + calibrated bloom
// ---------------------------------------------------------------------------
// Multisampled HDR targets multiply color/depth storage by the sample count.
// Keep 4x MSAA for small desktop buffers only; coarse-pointer, low-memory,
// high-DPR and large-canvas cases use FXAA instead.
const gl = renderer.getContext();
const msaaDisabledByQuery = new URLSearchParams(window.location.search).get('msaa') === '0';
let canFloatMSAA = canUseFloatMsaa({
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio,
  maxSamples: gl.getParameter(gl.MAX_SAMPLES) || 0,
  floatColorBuffer: renderer.extensions.has('EXT_color_buffer_float'),
  coarsePointer,
  deviceMemoryGiB,
  disabled: msaaDisabledByQuery,
});

const makeRenderTarget = () =>
  new THREE.WebGLRenderTarget(
    Math.floor(window.innerWidth),
    Math.floor(window.innerHeight),
    { type: THREE.HalfFloatType, samples: canFloatMSAA ? 4 : 0 },
  );

const composer = new EffectComposer(renderer, makeRenderTarget());
// EffectComposer treats the supplied target's dimensions as logical pixels and
// applies the renderer's DPR itself. Size it explicitly before adding passes so
// the initial frame uses the same physical resolution (and bloom buffers) as a
// later resize instead of multiplying a pre-scaled target by DPR twice.
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.34,  // strength
  0.62,  // radius
  1.05,  // threshold — only physical HDR highlights (sun glint, city cores)
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// The FXAA pass stays available for a resize that crosses the MSAA pixel
// budget; it is disabled while the small-buffer MSAA path is active.
const fxaaPass = new ShaderPass(FXAAShader);
fxaaPass.enabled = !canFloatMSAA;
fxaaPass.material.uniforms.resolution.value.set(
  1 / (window.innerWidth * pixelRatio),
  1 / (window.innerHeight * pixelRatio),
);
composer.addPass(fxaaPass);

function setMultisampling(enabled) {
  if (enabled === canFloatMSAA) return;
  canFloatMSAA = enabled;
  const samples = enabled ? 4 : 0;
  composer.renderTarget1.samples = samples;
  composer.renderTarget2.samples = samples;
  // Invalidate renderer-owned framebuffers so the new sample count is applied
  // on the next frame, then keep exactly one anti-aliasing path active.
  composer.renderTarget1.dispose();
  composer.renderTarget2.dispose();
  fxaaPass.enabled = !enabled;
}

function estimateTextureGpuBytes(texture) {
  const image = texture?.image;
  let width = image?.naturalWidth || image?.videoWidth || image?.width || 0;
  let height = image?.naturalHeight || image?.videoHeight || image?.height || 0;
  if (!width || !height) return 0;
  let bytes = 0;
  do {
    bytes += width * height * 4; // RGBA8 upper-bound for browser image uploads
    if (!texture.generateMipmaps || (width === 1 && height === 1)) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  } while (true);
  return bytes;
}

function estimateGeometryGpuBytes(root) {
  const seen = new Set();
  let bytes = 0;
  root.traverse((object) => {
    const geometry = object.geometry;
    if (!geometry || seen.has(geometry)) return;
    seen.add(geometry);
    for (const attribute of Object.values(geometry.attributes)) {
      bytes += attribute.array?.byteLength || 0;
    }
    bytes += geometry.index?.array?.byteLength || 0;
  });
  return bytes;
}

function estimateRenderTargetGpuBytes() {
  const targets = [
    composer.renderTarget1,
    composer.renderTarget2,
    bloomPass.renderTargetBright,
    ...bloomPass.renderTargetsHorizontal,
    ...bloomPass.renderTargetsVertical,
  ];
  let bytes = renderer.domElement.width * renderer.domElement.height * 4; // one RGBA8 backbuffer
  for (const target of targets) {
    const pixels = target.width * target.height;
    const hasDepth = target.depthBuffer ? 4 : 0;
    bytes += pixels * (8 + hasDepth); // RGBA16F color + optional depth
    if (target.samples > 0) bytes += pixels * target.samples * (8 + hasDepth);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Asset Loading
// ---------------------------------------------------------------------------
const loadingManager = new THREE.LoadingManager();

loadingManager.onProgress = (_url, loaded, total) => {
  if (loaderBar) loaderBar.style.width = `${(loaded / total) * 100}%`;
};

loadingManager.onLoad = () => {
  setTimeout(() => loaderEl?.classList.add('done'), 260);
};

loadingManager.onError = (url) => {
  reportFatal(`Failed to load asset: ${url}\nPlease run "npm run fetch-assets".`, { blocking: true });
};

const textureLoader = new THREE.TextureLoader(loadingManager);
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

function loadTexture(url, colorSpace = THREE.NoColorSpace) {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = colorSpace;
        tex.anisotropy = maxAnisotropy;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        resolve(tex);
      },
      undefined,
      (err) => reject(err),
    );
  });
}

// ---------------------------------------------------------------------------
// State & Simulation Parameters
// ---------------------------------------------------------------------------
const params = {
  // Solar ephemeris
  liveUTC: true,
  sunLongitude: 0,
  sunLatitude: 0,
  sunIntensity: 1.0,

  // Atmosphere
  atmosphereIntensity: 1.0,

  // Ocean & terrain optics
  specularIntensity: 1.0,
  oceanRoughness: 0.09,
  waveStrength: 1.0,
  detailStrength: 1.0,
  bumpScale: 1.0,
  nightIntensity: 1.0,

  // Clouds
  cloudDrift: 0.004,   // rad/s; tuned for the accelerated globe spin
  cloudOpacity: 1.0,
  cloudRelief: 1.55,
  cloudDetail: 1.0,
  lightningIntensity: 0.65,
  showCloudDeck: true,
  showHighClouds: true,
  showAtmosphere: true,

  // Planetary spin
  // A planet that never stops turning is the wrong default for anyone who has
  // asked the operating system to reduce motion, so the initial state defers to
  // the media query rather than overriding it.
  autoRotation: !prefersReducedMotion,
  rotationSpeed: 0.018,

  // Explicitly simulated low-Earth-orbit overlay; warp is simulated seconds per real second.
  showLEO: true,
  leoTimeWarp: 60,

  // Post-processing
  exposure: 1.0,
  bloomStrength: 0.34,
  bloomRadius: 0.62,
  bloomThreshold: 1.05,

  // Layers
  showBeacons: true,
  beaconIntensity: 1.0,
  showStarfield: true,
  starfieldOpacity: 1.0,
  milkyWayIntensity: 1.0,
};

// ---------------------------------------------------------------------------
// DOM HUD
// ---------------------------------------------------------------------------
const modeDotEl = document.getElementById('mode-dot');
const modeLabelEl = document.getElementById('mode-label');
const utcLabelEl = document.getElementById('utc-label');
const subsolarLabelEl = document.getElementById('subsolar-label');
const fpsLabelEl = document.getElementById('fps-label');
const studioEl = document.getElementById('studio');
const studioToggleBtn = document.getElementById('studio-toggle');
let initializeStudioControls = null;

function updateModeBadge() {
  if (params.liveUTC) {
    modeDotEl?.classList.remove('manual');
    if (modeLabelEl) modeLabelEl.textContent = 'LIVE UTC';
  } else {
    modeDotEl?.classList.add('manual');
    if (modeLabelEl) modeLabelEl.textContent = 'MANUAL SOLAR';
  }
}

if (studioToggleBtn && studioEl) {
  studioToggleBtn.addEventListener('click', async () => {
    const isHidden = studioEl.hasAttribute('hidden');
    if (isHidden) {
      studioEl.removeAttribute('hidden');
      studioToggleBtn.setAttribute('aria-expanded', 'true');
      if (initializeStudioControls) {
        studioEl.setAttribute('aria-busy', 'true');
        try {
          await initializeStudioControls();
        } catch (err) {
          reportFatal(`Could not load studio controls: ${err.message || String(err)}`);
        } finally {
          studioEl.removeAttribute('aria-busy');
        }
      }
    } else {
      studioEl.setAttribute('hidden', '');
      studioToggleBtn.setAttribute('aria-expanded', 'false');
    }
  });
}

// ---------------------------------------------------------------------------
// Resolution control (quality preset + adaptive fallback)
// ---------------------------------------------------------------------------
const qualityButtons = document.querySelectorAll('.segmented button[data-quality]');
let qualityMode = 'ultra';
let adaptiveFloor = 0.7;

let onPixelRatioChanged = null;

function applyPixelRatio(pr, { resize = true } = {}) {
  pixelRatio = THREE.MathUtils.clamp(pr, adaptiveFloor, MAX_PIXEL_RATIO);
  if (Math.abs(renderer.getPixelRatio() - pixelRatio) < 0.001) return;
  renderer.setPixelRatio(pixelRatio);
  composer.setPixelRatio(pixelRatio);
  if (resize) {
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.resolution.set(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio);
  }
}

function setQuality(mode) {
  qualityMode = mode;
  qualityButtons.forEach((btn) => {
    btn.setAttribute('aria-checked', btn.getAttribute('data-quality') === mode ? 'true' : 'false');
  });
  adaptiveFloor = mode === 'ultra' ? 0.7 : 0.55;
  applyPixelRatio(mode === 'ultra' ? MAX_PIXEL_RATIO : Math.min(1, MAX_PIXEL_RATIO));
  onPixelRatioChanged?.();
}

qualityButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const q = btn.getAttribute('data-quality');
    if (q) setQuality(q);
  });
});

// ---------------------------------------------------------------------------
// Initialization & Main Loop
// ---------------------------------------------------------------------------
async function init() {
  const [day, night, specular, topology, clouds] = await Promise.all([
    loadTexture('/textures/earth_day.jpg', THREE.SRGBColorSpace),
    loadTexture('/textures/earth_night.jpg', THREE.SRGBColorSpace),
    loadTexture('/textures/earth_specular.jpg', THREE.NoColorSpace),
    loadTexture('/textures/earth_topology.jpg', THREE.NoColorSpace),
    loadTexture('/textures/earth_clouds.jpg', THREE.NoColorSpace),
  ]);

  const earth = createEarth({ day, night, specular, topology, clouds });
  earth.clouds.visible = params.showCloudDeck;
  earth.cirrus.visible = params.showHighClouds;
  earth.halo.visible = params.showAtmosphere;
  scene.add(earth.group);

  const leoTracker = createLEOTracker(earth.group, earth.spin);
  leoTracker.setVisible(params.showLEO);

  const leoPanelEl = document.getElementById('leo-panel');
  const leoToggleBtn = document.getElementById('leo-toggle');
  const leoCloseBtn = document.getElementById('leo-close');
  const leoVisibilityBtn = document.getElementById('leo-visibility');
  const leoTrackBtn = document.getElementById('leo-track');
  const leoAltitudeEl = document.getElementById('leo-altitude');
  const leoSpeedEl = document.getElementById('leo-speed');
  const leoPeriodEl = document.getElementById('leo-period');
  const leoInclinationEl = document.getElementById('leo-inclination');
  const leoCoordinatesEl = document.getElementById('leo-coordinates');
  const leoPhaseEl = document.getElementById('leo-phase');
  const leoWarpLabelEl = document.getElementById('leo-warp-label');
  const leoSunStatusEl = document.getElementById('leo-sun-status');
  const leoSunLabelEl = document.getElementById('leo-sun-label');
  let leoVisibilityController = null;
  let cameraTrackingLEO = false;

  function setLEOPanelOpen(open) {
    if (!leoPanelEl) return;
    leoPanelEl.hidden = !open;
    leoToggleBtn?.setAttribute('aria-expanded', String(open));
    leoToggleBtn?.setAttribute('title', open ? 'Close simulated LEO tracker' : 'Open simulated LEO tracker');
  }

  function setLEOCameraTracking(enabled, { preserveTarget = false } = {}) {
    cameraTrackingLEO = Boolean(enabled);
    if (cameraTrackingLEO && !params.showLEO) setLEOVisibility(true);
    if (!cameraTrackingLEO && !preserveTarget) controls.target.set(0, 0, 0);
    leoTrackBtn?.setAttribute('aria-pressed', String(cameraTrackingLEO));
    if (leoTrackBtn) leoTrackBtn.textContent = cameraTrackingLEO ? 'STOP TRACKING' : 'TRACK SATELLITE';
  }

  function setLEOVisibility(visible) {
    params.showLEO = Boolean(visible);
    leoTracker.setVisible(params.showLEO);
    leoVisibilityController?.updateDisplay();
    if (!params.showLEO && cameraTrackingLEO) setLEOCameraTracking(false);
    leoVisibilityBtn?.setAttribute('aria-pressed', String(params.showLEO));
    if (leoVisibilityBtn) leoVisibilityBtn.textContent = params.showLEO ? 'HIDE ORBIT' : 'SHOW ORBIT';
  }

  leoToggleBtn?.addEventListener('click', () => setLEOPanelOpen(Boolean(leoPanelEl?.hidden)));
  leoCloseBtn?.addEventListener('click', () => {
    setLEOPanelOpen(false);
    leoToggleBtn?.focus({ preventScroll: true });
  });
  leoVisibilityBtn?.addEventListener('click', () => setLEOVisibility(!params.showLEO));
  leoTrackBtn?.addEventListener('click', () => setLEOCameraTracking(!cameraTrackingLEO));

  if (leoAltitudeEl) leoAltitudeEl.textContent = LEO_ALTITUDE_KM.toFixed(0);
  if (leoSpeedEl) leoSpeedEl.textContent = LEO_ORBITAL_SPEED_KM_S.toFixed(2);
  if (leoPeriodEl) leoPeriodEl.textContent = `${LEO_ORBITAL_PERIOD_MINUTES.toFixed(1)} MIN`;
  if (leoInclinationEl) leoInclinationEl.textContent = LEO_INCLINATION_DEG.toFixed(1);

  const beacons = createBeacons(pixelRatio, earth.uniforms.shared.uSunDirection);
  earth.spin.add(beacons);

  const starfield = createStarfield(pixelRatio, { count: 16000 });
  scene.add(starfield.group);

  // Optional browser-side profiler: image mips, vertex/index buffers, and
  // post-process targets are estimated separately from the driver's own counts.
  const profileAssetGpuBytes = profileMode
    ? [day, night, specular, topology, clouds].reduce((sum, texture) => sum + estimateTextureGpuBytes(texture), 0)
    : 0;
  const profileGeometryGpuBytes = profileMode ? estimateGeometryGpuBytes(scene) : 0;
  let profileRenderStats = { calls: 0, triangles: 0, points: 0 };
  let profileSubmitMs = 0;

  onPixelRatioChanged = () => {
    beacons.material.uniforms.uPixelRatio.value = pixelRatio;
    starfield.setPixelRatio(pixelRatio);
    fxaaPass?.material.uniforms.resolution.value.set(
      1 / (window.innerWidth * pixelRatio),
      1 / (window.innerHeight * pixelRatio),
    );
  };

  // Compile shaders while the loader is still up — avoids a first-frame hitch.
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    renderer.compile(scene, camera);
  }
  if (profileMode) renderer.info.reset();

  // -------------------------------------------------------------------------
  // Studio GUI (loaded only on demand)
  // -------------------------------------------------------------------------
  let gui = null;
  let studioInitialization = null;
  let autoRotationController = null;
  let isCityMode = false;
  let autoRotationBeforeFly = params.autoRotation;

  const createStudioControls = async () => {
    if (gui) return;
    if (studioInitialization) return studioInitialization;

    studioInitialization = (async () => {
      const { default: GUI } = await import('lil-gui');
      gui = new GUI({ container: studioEl, title: 'Studio Controls' });

      const solarFolder = gui.addFolder('Solar & Ephemeris');
      const liveUtcController = solarFolder.add(params, 'liveUTC').name('Real-Time UTC Sync').onChange(updateModeBadge);

      solarFolder
        .add(params, 'sunLongitude', -180, 180, 0.1)
        .name('Sun Longitude (°)')
        .listen()
        .onChange(() => {
          params.liveUTC = false;
          liveUtcController.updateDisplay();
          updateModeBadge();
        });

      solarFolder
        .add(params, 'sunLatitude', -23.5, 23.5, 0.1)
        .name('Sun Latitude (°)')
        .listen()
        .onChange(() => {
          params.liveUTC = false;
          liveUtcController.updateDisplay();
          updateModeBadge();
        });

      solarFolder.add(params, 'sunIntensity', 0.2, 2.5, 0.01).name('Sun Intensity');

      const atmosphereFolder = gui.addFolder('Atmosphere & Scattering');
      atmosphereFolder.add(params, 'atmosphereIntensity', 0.0, 2.5, 0.05).name('Rayleigh Density');
      atmosphereFolder.add(params, 'showAtmosphere').name('Scattering Limb').onChange((visible) => {
        earth.halo.visible = visible;
      });
      atmosphereFolder.add(params, 'nightIntensity', 0.0, 3.0, 0.05).name('City Emission');

      const oceanFolder = gui.addFolder('Ocean & Terrain');
      oceanFolder.add(params, 'specularIntensity', 0.0, 3.0, 0.05).name('Sun Glitter');
      oceanFolder.add(params, 'oceanRoughness', 0.02, 0.45, 0.005).name('Sea Roughness');
      oceanFolder.add(params, 'waveStrength', 0.0, 2.5, 0.05).name('Wave Detail');
      oceanFolder.add(params, 'detailStrength', 0.0, 2.5, 0.05).name('Terrain Detail');
      oceanFolder.add(params, 'bumpScale', 0.0, 3.0, 0.05).name('Relief Strength');

      const cloudsFolder = gui.addFolder('Cloud Decks');
      cloudsFolder.add(params, 'cloudDrift', -0.012, 0.012, 0.0001).name('Zonal Drift');
      cloudsFolder.add(params, 'cloudOpacity', 0.0, 1.0, 0.01).name('Cloud Density');
      cloudsFolder.add(params, 'cloudRelief', 0.0, 2.5, 0.05).name('Cumulus Relief');
      cloudsFolder.add(params, 'cloudDetail', 0.0, 1.5, 0.05).name('Cloud Microdetail');
      cloudsFolder.add(params, 'lightningIntensity', 0.0, 1.5, 0.05).name('Night Storm Flashes');
      cloudsFolder.add(params, 'showCloudDeck').name('Main Deck').onChange((visible) => {
        earth.clouds.visible = visible;
      });
      cloudsFolder.add(params, 'showHighClouds').name('High Ice Veil').onChange((visible) => {
        earth.cirrus.visible = visible;
      });

      const dynamicsFolder = gui.addFolder('Orbital Dynamics');
      autoRotationController = dynamicsFolder.add(params, 'autoRotation').name('Axial Auto-Spin');
      autoRotationController.onChange((enabled) => {
        if (isCityMode) autoRotationBeforeFly = enabled;
      });
      dynamicsFolder.add(params, 'rotationSpeed', -0.08, 0.08, 0.001).name('Spin Velocity');
      leoVisibilityController = dynamicsFolder.add(params, 'showLEO').name('Simulated LEO Orbit').onChange(setLEOVisibility);
      dynamicsFolder.add(params, 'leoTimeWarp', 0, 240, 1).name('LEO Time Warp');

      const postFolder = gui.addFolder('Optics & Post');
      postFolder.add(params, 'exposure', 0.4, 2.0, 0.01).name('Exposure').onChange((v) => (renderer.toneMappingExposure = v));
      postFolder.add(params, 'bloomStrength', 0.0, 2.0, 0.01).name('Bloom Strength').onChange((v) => (bloomPass.strength = v));
      postFolder.add(params, 'bloomRadius', 0.0, 1.0, 0.01).name('Bloom Radius').onChange((v) => (bloomPass.radius = v));
      postFolder.add(params, 'bloomThreshold', 0.0, 2.0, 0.01).name('Bloom Threshold').onChange((v) => (bloomPass.threshold = v));
      postFolder.add(params, 'showBeacons').name('Orbital Beacons').onChange((v) => (beacons.visible = v));
      postFolder.add(params, 'beaconIntensity', 0.0, 3.0, 0.05).name('Beacon Power');
      postFolder.add(params, 'showStarfield').name('Star Field').onChange((v) => (starfield.group.visible = v));
      postFolder.add(params, 'starfieldOpacity', 0.0, 2.0, 0.01).name('Star Brightness');
      postFolder.add(params, 'milkyWayIntensity', 0.0, 3.0, 0.01).name('Milky Way');
    })();

    try {
      await studioInitialization;
    } catch (err) {
      gui?.destroy();
      gui = null;
      studioInitialization = null;
      throw err;
    }
  };

  initializeStudioControls = createStudioControls;
  // A visitor may open the panel before the Earth assets finish loading. Honor
  // that intent once its controls become available.
  if (studioEl && !studioEl.hasAttribute('hidden')) {
    studioEl.setAttribute('aria-busy', 'true');
    try {
      await createStudioControls();
    } catch (err) {
      reportFatal(`Could not load studio controls: ${err.message || String(err)}`);
    } finally {
      studioEl.removeAttribute('aria-busy');
    }
  }

  // -------------------------------------------------------------------------
  // City Navigation & Telemetry
  // -------------------------------------------------------------------------
  const cityNavScrollEl = document.getElementById('city-nav-scroll');
  const cityCardEl = document.getElementById('city-card');
  const citySectorEl = document.getElementById('city-sector');
  const cityNameArEl = document.getElementById('city-name-ar');
  const cityNameEnEl = document.getElementById('city-name-en');
  const cityCoordsEl = document.getElementById('city-coords');
  const cityPopEl = document.getElementById('city-pop');
  const cityTimeEl = document.getElementById('city-time');
  const citySunEl = document.getElementById('city-sun');
  const cityDescEl = document.getElementById('city-desc');
  const cityLandmarksEl = document.getElementById('city-landmarks');
  const btnReturnOrbit = document.getElementById('btn-return-orbit');
  const btnNavReturnOrbit = document.getElementById('btn-nav-return-orbit');
  const cityCardClose = document.getElementById('city-card-close');
  const altitudeLabelEl = document.getElementById('altitude-label');

  let activeCity = null;
  let isFlying = false;
  let flyStartTime = 0;
  let flyDuration = 2000;
  const flyStartPos = new THREE.Vector3();
  const flyEndPos = new THREE.Vector3();
  const flyStartTarget = new THREE.Vector3();
  const flyEndTarget = new THREE.Vector3();

  function setAutoRotation(enabled) {
    params.autoRotation = enabled;
    autoRotationController?.updateDisplay();
  }

  function updateCitySelection(city) {
    cityNavScrollEl?.querySelectorAll('.city-chip').forEach((btn) => {
      const selected = btn.getAttribute('data-city') === city?.id;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
  }

  function updateCityModeControls() {
    if (leoTrackBtn) leoTrackBtn.disabled = isCityMode;
    if (!btnNavReturnOrbit) return;
    const detailsVisible = cityCardEl && !cityCardEl.hasAttribute('hidden');
    btnNavReturnOrbit.hidden = !isCityMode || Boolean(detailsVisible);
  }

  function focusCityChip(city) {
    if (!city || !cityNavScrollEl) return;
    for (const btn of cityNavScrollEl.querySelectorAll('.city-chip')) {
      if (btn.getAttribute('data-city') === city.id) {
        btn.focus({ preventScroll: true });
        return;
      }
    }
  }

  function getCityWorldPosition(city, radius = 1.0) {
    earth.group.updateMatrixWorld(true);
    const v = latLngToVector3(city.lat, city.lng, radius);
    return v.applyMatrix4(earth.spin.matrixWorld);
  }

  function showCityCard(city) {
    activeCity = city;
    updateCitySelection(city);
    if (!cityCardEl) {
      updateCityModeControls();
      return;
    }
    cityCardEl.removeAttribute('hidden');

    if (citySectorEl) citySectorEl.textContent = `${city.countryAr} • ${city.sectorAr}`;
    if (cityNameArEl) cityNameArEl.textContent = city.nameAr;
    if (cityNameEnEl) cityNameEnEl.textContent = `${city.name}, ${city.country}`;
    if (cityCoordsEl) cityCoordsEl.textContent = formatLatLng(city.lat, city.lng);
    if (cityPopEl) cityPopEl.textContent = city.population;
    if (cityTimeEl) cityTimeEl.textContent = getCityLocalTime(city);
    if (cityDescEl) cityDescEl.textContent = city.descriptionAr;

    const cityPos = getCityWorldPosition(city, 1.0);
    const sunDir = earth.uniforms.shared.uSunDirection.value;
    const sunDot = cityPos.clone().normalize().dot(sunDir);
    if (citySunEl) {
      citySunEl.textContent = sunDot > 0.05 ? '☀️ نهار مشمس • DAYLIGHT' : '🌙 أضواء ليلية • NIGHTTIME';
    }

    if (cityLandmarksEl) {
      cityLandmarksEl.innerHTML = '';
      city.landmarks.forEach((lm) => {
        const chip = document.createElement('span');
        chip.className = 'city-landmark-chip';
        chip.textContent = lm;
        cityLandmarksEl.appendChild(chip);
      });
    }

    updateCityModeControls();
  }

  function dismissCityCard() {
    cityCardEl?.setAttribute('hidden', '');
    updateCityModeControls();
  }

  function flyToCity(city) {
    setLEOCameraTracking(false, { preserveTarget: true });
    // Preserve the original spin preference when moving between cities or
    // reopening a dismissed card; only snapshot it on the first entry.
    if (!isCityMode) autoRotationBeforeFly = params.autoRotation;
    isCityMode = true;
    setAutoRotation(false);

    const cityWorldPos = getCityWorldPosition(city, 1.0);
    const earthCenter = new THREE.Vector3().setFromMatrixPosition(earth.group.matrixWorld);
    const dir = cityWorldPos.clone().sub(earthCenter).normalize();
    const targetAltitude = city.altitude || 1.025;
    const destCamPos = earthCenter.clone().add(dir.multiplyScalar(targetAltitude));

    flyStartPos.copy(camera.position);
    flyStartTarget.copy(controls.target);
    flyEndPos.copy(destCamPos);
    flyEndTarget.set(0, 0, 0);

    flyStartTime = performance.now();
    flyDuration = 2100;
    isFlying = true;

    showCityCard(city);
  }

  function resetToOrbit() {
    setLEOCameraTracking(false, { preserveTarget: true });
    const cityToFocus = activeCity;
    isFlying = true;
    flyStartTime = performance.now();
    flyDuration = 1800;

    flyStartPos.copy(camera.position);
    flyStartTarget.copy(controls.target);

    const currentDir = camera.position.clone().normalize();
    flyEndPos.copy(currentDir.multiplyScalar(3.0));
    flyEndTarget.set(0, 0, 0);

    isCityMode = false;
    activeCity = null;
    updateCitySelection(null);
    dismissCityCard();
    // Restore the visitor's pre-visit preference, unless reduced motion was
    // enabled while they were in city mode.
    setAutoRotation(autoRotationBeforeFly);
    focusCityChip(cityToFocus);
  }

  btnReturnOrbit?.addEventListener('click', resetToOrbit);
  btnNavReturnOrbit?.addEventListener('click', resetToOrbit);
  cityCardClose?.addEventListener('click', () => {
    dismissCityCard();
    btnNavReturnOrbit?.focus({ preventScroll: true });
  });

  motionPreferenceQuery?.addEventListener('change', (event) => {
    if (!event.matches) return;
    if (isCityMode) autoRotationBeforeFly = false;
    if (params.autoRotation) setAutoRotation(false);
  });

  if (cityNavScrollEl) {
    CITIES.forEach((city) => {
      const btn = document.createElement('button');
      btn.className = 'city-chip';
      btn.type = 'button';
      btn.setAttribute('data-city', city.id);
      btn.setAttribute('aria-pressed', 'false');

      const nameAr = document.createElement('span');
      nameAr.className = 'city-chip-ar';
      nameAr.lang = 'ar';
      nameAr.dir = 'rtl';
      nameAr.textContent = city.nameAr;

      const nameEn = document.createElement('span');
      nameEn.className = 'city-chip-en';
      nameEn.lang = 'en';
      nameEn.textContent = city.name;

      btn.append(nameAr, nameEn);
      btn.addEventListener('click', () => flyToCity(city));
      cityNavScrollEl.appendChild(btn);
    });
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let pointerDownTime = 0;
  canvas.addEventListener('pointerdown', () => {
    pointerDownTime = performance.now();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (performance.now() - pointerDownTime > 250) return;

    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const hits = raycaster.intersectObject(earth.surface, false);
    if (hits.length === 0) return;

    const hitPoint = hits[0].point;
    let closestCity = null;
    let minDist = Infinity;
    CITIES.forEach((city) => {
      const cityPos = getCityWorldPosition(city, 1.0);
      const dist = hitPoint.distanceTo(cityPos);
      if (dist < minDist) {
        minDist = dist;
        closestCity = city;
      }
    });
    if (closestCity && minDist < 0.16) flyToCity(closestCity);
  });

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------
  function onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    MAX_PIXEL_RATIO = maxPixelRatioForViewport(width, height);
    const qualityTarget = qualityMode === 'ultra' ? MAX_PIXEL_RATIO : Math.min(1, MAX_PIXEL_RATIO);
    if (Math.abs(qualityTarget - pixelRatio) > 0.001) {
      applyPixelRatio(qualityTarget, { resize: false });
      onPixelRatioChanged?.();
    }
    setMultisampling(canUseFloatMsaa({
      width,
      height,
      pixelRatio,
      maxSamples: gl.getParameter(gl.MAX_SAMPLES) || 0,
      floatColorBuffer: renderer.extensions.has('EXT_color_buffer_float'),
      coarsePointer,
      deviceMemoryGiB,
      disabled: msaaDisabledByQuery,
    }));

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
    composer.setSize(width, height);
    bloomPass.resolution.set(width * pixelRatio, height * pixelRatio);
    fxaaPass?.material.uniforms.resolution.value.set(1 / (width * pixelRatio), 1 / (height * pixelRatio));
    beacons.material.uniforms.uPixelRatio.value = pixelRatio;
    starfield.setPixelRatio(pixelRatio);
  }
  window.addEventListener('resize', onResize);

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------
  const timer = new THREE.Timer();
  const subsolarLocal = new THREE.Vector3();
  const sunWorldPos = new THREE.Vector3();
  const earthWorldCenter = new THREE.Vector3();
  const leoWorldPosition = new THREE.Vector3();
  const leoEarthRelativePosition = new THREE.Vector3();
  const flyDir = new THREE.Vector3();
  // Scratch objects for the fly-to interpolation (see the loop body).
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const flyStartDir = new THREE.Vector3();
  const flyEndDir = new THREE.Vector3();
  const flyQuatStart = new THREE.Quaternion();
  const flyQuatEnd = new THREE.Quaternion();
  const flyQuatCur = new THREE.Quaternion();

  let contextLost = false;
  let cloudTime = 0;
  let elapsedTime = 0;
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  let lastAdapt = performance.now();
  let lastHudUpdate = 0;

  // --- Frame-rate governor -------------------------------------------------
  // The previous version compared against a hardcoded 58/42 FPS. That is only
  // meaningful on a 60 Hz display: on a 120 Hz panel 70 FPS is a bad frame and
  // would never trigger a step down, while on a device that cannot reach 60 the
  // step up was unreachable. So the target is measured, not assumed — the
  // display's actual refresh rate, taken as the median of the first frames
  // after load (rAF is throttled to the panel, so that is the refresh rate).
  let refreshRate = 60;
  const probeFrames = [];
  let fpsSmoothed = 0;
  let slowWindows = 0;
  let fastWindows = 0;

  /** Rolling median of the refresh probe; robust to a couple of dropped frames. */
  function measureRefreshRate(dt) {
    if (probeFrames.length >= 30) return;
    if (dt > 0.004 && dt < 0.05) probeFrames.push(dt);
    if (probeFrames.length === 30) {
      const sorted = [...probeFrames].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      refreshRate = Math.round(1 / median);
    }
  }

  // A backgrounded tab pauses rAF. On return, the first sample's elapsed time
  // is the whole time spent hidden, which reads as a catastrophic frame rate and
  // drove the adaptive resolution straight to its floor — the user came back to
  // a blurry planet for no reason. Reset the measurement window instead.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    frameCount = 0;
    lastFpsUpdate = performance.now();
    lastAdapt = performance.now();
    timer.update();
  });

  // --- Graphics context loss -----------------------------------------------
  // A driver reset, a GPU hang or a backgrounded mobile tab can take the WebGL
  // context away at any moment. Nothing listens for that by default: the canvas
  // freezes on its last frame and every later draw call fails, which looks like
  // the app simply died. `preventDefault` is what tells the browser the app
  // intends to carry on, and is required before `webglcontextrestored` fires.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    reportFatal('Graphics context lost. Waiting for the driver to restore it.');
  });

  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    fatalEl?.setAttribute('hidden', '');
    lastFatalMessage = '';
    // three re-uploads textures and programs lazily on the next render, but the
    // clock kept running while the context was gone. Without this the first
    // frame after restoration sees a multi-second delta and the cloud deck jumps.
    timer.update();
    lastFpsUpdate = performance.now();
    lastAdapt = performance.now();
  });

  function animate() {
    requestAnimationFrame(animate);

    timer.update();
    const rawDelta = timer.getDelta();
    const delta = Math.min(rawDelta, 0.1);
    const elapsed = timer.getElapsed();
    measureRefreshRate(rawDelta);

    // --- Camera fly-to -----------------------------------------------------
    // Every vector and quaternion here is a persistent temporary. The naive
    // version allocated six objects per frame for the two seconds of a flight,
    // which is pure garbage in the one place the frame budget is already under
    // pressure.
    if (isFlying) {
      const t = Math.min(1.0, (performance.now() - flyStartTime) / flyDuration);
      const ease = 1.0 - Math.pow(1.0 - t, 5);

      const startDist = flyStartPos.length();
      const endDist = flyEndPos.length();
      flyStartDir.copy(flyStartPos).normalize();
      flyEndDir.copy(flyEndPos).normalize();

      flyQuatStart.setFromUnitVectors(Z_AXIS, flyStartDir);
      flyQuatEnd.setFromUnitVectors(Z_AXIS, flyEndDir);
      flyQuatCur.copy(flyQuatStart).slerp(flyQuatEnd, ease);
      flyDir.copy(Z_AXIS).applyQuaternion(flyQuatCur)
        .multiplyScalar(THREE.MathUtils.lerp(startDist, endDist, ease));

      camera.position.copy(flyDir);
      controls.target.lerpVectors(flyStartTarget, flyEndTarget, ease);

      if (t >= 1.0) isFlying = false;
    }

    controls.update();

    // --- Planetary rotation & cloud advection ------------------------------
    if (params.autoRotation) {
      earth.spin.rotation.y += params.rotationSpeed * delta;
    }
    cloudTime = (cloudTime + delta) % 100000;
    elapsedTime += delta;

    // --- Solar ephemeris ---------------------------------------------------
    const now = new Date();
    let lat;
    let lng;
    if (params.liveUTC) {
      const sol = solarPosition(now);
      lat = sol.declination;
      lng = sol.subsolarLongitude;
      params.sunLatitude = lat;
      params.sunLongitude = lng;
    } else {
      lat = params.sunLatitude;
      lng = params.sunLongitude;
    }

    earth.group.updateMatrixWorld(true);
    latLngToVector3(lat, lng, 1.0, subsolarLocal);
    subsolarLocal.applyMatrix4(earth.spin.matrixWorld);
    earthWorldCenter.setFromMatrixPosition(earth.group.matrixWorld);
    sunWorldPos.copy(subsolarLocal).sub(earthWorldCenter).normalize();

    const leoTelemetry = leoTracker.update(
      elapsedTime * params.leoTimeWarp,
      earth.spin.rotation.y,
      camera.position.length(),
    );
    leoWorldPosition.copy(leoTelemetry.position).applyMatrix4(earth.group.matrixWorld);
    leoEarthRelativePosition.copy(leoWorldPosition).sub(earthWorldCenter);
    leoTelemetry.eclipse = isSatelliteEclipsed(leoEarthRelativePosition, sunWorldPos);
    if (cameraTrackingLEO) {
      controls.target.copy(leoWorldPosition);
      controls.update();
    }

    // --- Uniform sync ------------------------------------------------------
    const camDist = camera.position.length();
    const shared = earth.uniforms.shared;
    shared.uSunDirection.value.copy(sunWorldPos);
    shared.uSunIntensity.value = params.sunIntensity;
    shared.uAtmosphereIntensity.value = params.atmosphereIntensity;
    shared.uCloudOpacity.value = params.cloudOpacity;
    shared.uCameraDistance.value = camDist;
    shared.uCloudTime.value = cloudTime;
    shared.uCloudDrift.value = params.cloudDrift;
    shared.uTime.value = elapsedTime;

    earth.uniforms.surface.uBumpScale.value = params.bumpScale;
    earth.uniforms.surface.uOceanRoughness.value = params.oceanRoughness;
    earth.uniforms.surface.uSpecularIntensity.value = params.specularIntensity;
    earth.uniforms.surface.uNightIntensity.value = params.nightIntensity;
    earth.uniforms.surface.uWaveStrength.value = params.waveStrength;
    earth.uniforms.surface.uDetailStrength.value = params.detailStrength;

    earth.uniforms.clouds.uCloudRelief.value = params.cloudRelief;
    earth.uniforms.clouds.uCloudDetail.value = params.cloudDetail;
    earth.uniforms.clouds.uLightningIntensity.value = params.lightningIntensity;
    earth.uniforms.cirrus.uCloudDetail.value = params.cloudDetail;

    beacons.material.uniforms.uTime.value = elapsed;
    beacons.material.uniforms.uIntensity.value = params.beaconIntensity;

    starfield.starMaterial.uniforms.uOpacity.value = params.starfieldOpacity;
    starfield.milkyWayMaterial.uniforms.uIntensity.value = params.milkyWayIntensity;

    // --- Render ------------------------------------------------------------
    // While the context is gone there is nothing to draw into, and issuing draw
    // calls against a lost context produces an error per call. Profiling records
    // the complete composer (scene + bloom + output/AA), not just the scene pass.
    const renderStarted = profileMode ? performance.now() : 0;
    if (!contextLost) composer.render();
    if (profileMode) {
      const submitMs = performance.now() - renderStarted;
      profileSubmitMs = profileSubmitMs === 0 ? submitMs : profileSubmitMs * 0.8 + submitMs * 0.2;
      profileRenderStats = {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        points: renderer.info.render.points,
      };
      renderer.info.reset();
    }

    // One clock read for the whole frame. It has to be declared before the HUD
    // block that reads it: `const` is hoisted into the temporal dead zone, so
    // referencing it above its declaration throws a ReferenceError on the very
    // first frame, which the window error handler turns into the fatal overlay.
    const nowPerf = performance.now();

    // --- HUD ---------------------------------------------------------------
    // These readouts are second-resolution at best, but the naive version wrote
    // them every frame: a UTC string built with toISOString + two replaces, a
    // formatted lat/lng, and an Intl-formatted altitude, 60 times a second. Each
    // write invalidates layout for text a person cannot re-read that fast.
    // Four updates a second is imperceptible and costs ~93% less work; the
    // change guard means an idle readout writes nothing at all.
    if (nowPerf - lastHudUpdate >= HUD_INTERVAL_MS) {
      lastHudUpdate = nowPerf;

      if (utcLabelEl) {
        writeText(
          utcLabelEl,
          params.liveUTC
            ? `${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`
            : 'MANUAL SOLAR OVERRIDE',
        );
      }
      if (subsolarLabelEl) writeText(subsolarLabelEl, `SUBSOLAR ${formatLatLng(lat, lng)}`);

      if (altitudeLabelEl) {
        const altitudeKm = Math.round(Math.max(0, camDist - 1.0) * 6371);
        writeText(
          altitudeLabelEl,
          camDist < 1.08
            ? `ALTITUDE ${altitudeKm.toLocaleString()} KM (URBAN INSPECTION)`
            : `ALTITUDE ${altitudeKm.toLocaleString()} KM`,
        );
      }

      if (activeCity && cityTimeEl) writeText(cityTimeEl, getCityLocalTime(activeCity, now));

      if (leoPanelEl && !leoPanelEl.hidden) {
        if (leoCoordinatesEl) writeText(leoCoordinatesEl, formatLatLng(leoTelemetry.latitude, leoTelemetry.longitude));
        if (leoPhaseEl) writeText(leoPhaseEl, `${(leoTelemetry.phase * 100).toFixed(1)}%`);
        if (leoWarpLabelEl) writeText(leoWarpLabelEl, `· ${params.leoTimeWarp.toFixed(0)}×`);
        leoSunStatusEl?.classList.toggle('eclipse', leoTelemetry.eclipse);
        leoSunStatusEl?.classList.toggle('sunlit', !leoTelemetry.eclipse);
        if (leoSunLabelEl) writeText(leoSunLabelEl, leoTelemetry.eclipse ? 'ECLIPSE' : 'SUNLIT');
      }
    }

    // --- FPS + adaptive resolution ----------------------------------------
    frameCount += 1;
    if (nowPerf - lastFpsUpdate >= 500) {
      const fps = Math.round((frameCount * 1000) / (nowPerf - lastFpsUpdate));
      // Seed from the first real sample rather than a guessed 60.
      fpsSmoothed = fpsSmoothed === 0 ? fps : fpsSmoothed * 0.6 + fps * 0.4;
      if (fpsLabelEl) {
        if (profileMode) {
          const renderTargetMiB = estimateRenderTargetGpuBytes() / (1024 * 1024);
          const gpuEstimateMiB =
            (profileAssetGpuBytes + profileGeometryGpuBytes + estimateRenderTargetGpuBytes()) / (1024 * 1024);
          const jsHeapMiB = performance.memory?.usedJSHeapSize
            ? ` · JS ${ (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(0) } MiB`
            : '';
          fpsLabelEl.textContent =
            `FPS ${fps} (${(1000 / Math.max(fps, 1)).toFixed(1)} ms) · DPR ${pixelRatio.toFixed(2)} · ` +
            `${profileRenderStats.calls} draws · ${(profileRenderStats.triangles / 1e6).toFixed(2)}M tris · ` +
            `${renderer.info.memory.textures} textures / ${renderer.info.memory.geometries} geometries · ` +
            `GPU est ${gpuEstimateMiB.toFixed(0)} MiB (${renderTargetMiB.toFixed(0)} MiB targets) · ` +
            `CPU submit ${profileSubmitMs.toFixed(1)} ms${jsHeapMiB}`;
          fpsLabelEl.title = 'GPU memory is estimated from uncompressed RGBA8 textures and render targets; submit time is CPU-side, not a GPU timer.';
        } else {
          fpsLabelEl.textContent = `${fps} FPS`;
        }
      }
      frameCount = 0;
      lastFpsUpdate = nowPerf;

      // Thresholds are fractions of the measured refresh rate, and a step is
      // only taken after two consecutive samples agree. Without that dwell the
      // controller oscillates: stepping down buys enough headroom to trip the
      // step-up rule, which loses it again a few seconds later.
      if (qualityMode === 'ultra') {
        const low = refreshRate * 0.75;
        const high = refreshRate * 0.92;
        if (fpsSmoothed < low) {
          slowWindows += 1;
          fastWindows = 0;
        } else if (fpsSmoothed > high) {
          fastWindows += 1;
          slowWindows = 0;
        } else {
          slowWindows = 0;
          fastWindows = 0;
        }

        if (nowPerf - lastAdapt > ADAPT_DWELL_MS && slowWindows >= 2 && pixelRatio > adaptiveFloor + 0.02) {
          applyPixelRatio(pixelRatio - 0.2);
          lastAdapt = nowPerf;
          slowWindows = 0;
          fastWindows = 0;
        } else if (nowPerf - lastAdapt > ADAPT_DWELL_MS && fastWindows >= 2 && pixelRatio < MAX_PIXEL_RATIO - 0.02) {
          applyPixelRatio(pixelRatio + 0.15);
          lastAdapt = nowPerf;
          slowWindows = 0;
          fastWindows = 0;
        }
      } else {
        slowWindows = 0;
        fastWindows = 0;
      }
    }
  }

  updateModeBadge();
  setQuality('ultra');
  animate();
}

init().catch((err) => {
  reportFatal(err.message || String(err), { blocking: true });
});

