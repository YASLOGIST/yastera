import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import GUI from 'lil-gui';

import { createEarth } from './earth.js';
import { createBeacons } from './beacons.js';
import { createStarfield } from './starfield.js';
import { solarPosition } from './solar.js';
import { latLngToVector3, formatLatLng } from './geo.js';
import { CITIES, getCityLocalTime } from './cities.js';

// ---------------------------------------------------------------------------
// Fatal error overlay & diagnostics
// ---------------------------------------------------------------------------
const fatalEl = document.getElementById('fatal');
function reportFatal(msg) {
  if (fatalEl) {
    fatalEl.removeAttribute('hidden');
    fatalEl.textContent = `[Orbital Engine Error]\n${msg}`;
  }
  console.error(msg);
}

window.addEventListener('error', (e) => {
  reportFatal(e.message || String(e));
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
const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);
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
  reportFatal(sections.join('\n\n'));
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
// Post-Processing: HDR + 4x MSAA + calibrated bloom
// ---------------------------------------------------------------------------
// HDR targets are renderable only with the float colour-buffer extension, and
// multisampled half-float targets are not guaranteed on every mobile GPU. Probe
// once, then fall back to a post-process anti-aliaser instead of MSAA.
const gl = renderer.getContext();
const msaaDisabledByQuery = new URLSearchParams(window.location.search).get('msaa') === '0';
const canFloatMSAA =
  !msaaDisabledByQuery &&
  renderer.extensions.has('EXT_color_buffer_float') &&
  (gl.getParameter(gl.MAX_SAMPLES) || 0) >= 4;

const makeRenderTarget = () =>
  new THREE.WebGLRenderTarget(
    Math.floor(window.innerWidth * pixelRatio),
    Math.floor(window.innerHeight * pixelRatio),
    { type: THREE.HalfFloatType, samples: canFloatMSAA ? 4 : 0 },
  );

const composer = new EffectComposer(renderer, makeRenderTarget());
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.34,  // strength
  0.62,  // radius
  1.05,  // threshold — only physical HDR highlights (sun glint, city cores)
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Anti-alias the LDR result only when the MSAA path is unavailable.
let fxaaPass = null;
if (!canFloatMSAA) {
  fxaaPass = new ShaderPass(FXAAShader);
  fxaaPass.material.uniforms.resolution.value.set(
    1 / (window.innerWidth * pixelRatio),
    1 / (window.innerHeight * pixelRatio),
  );
  composer.addPass(fxaaPass);
}

// ---------------------------------------------------------------------------
// Asset Loading
// ---------------------------------------------------------------------------
const loaderEl = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const loadingManager = new THREE.LoadingManager();

loadingManager.onProgress = (_url, loaded, total) => {
  if (loaderBar) loaderBar.style.width = `${(loaded / total) * 100}%`;
};

loadingManager.onLoad = () => {
  setTimeout(() => loaderEl?.classList.add('done'), 260);
};

loadingManager.onError = (url) => {
  reportFatal(`Failed to load asset: ${url}\nPlease run "npm run fetch-assets".`);
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
  cloudDrift: 0.035,   // rad/s of differential drift
  cloudOpacity: 1.0,
  cloudRelief: 1.0,

  // Planetary spin
  autoRotation: true,
  rotationSpeed: 0.018,

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
  studioToggleBtn.addEventListener('click', () => {
    const isHidden = studioEl.hasAttribute('hidden');
    if (isHidden) {
      studioEl.removeAttribute('hidden');
      studioToggleBtn.setAttribute('aria-expanded', 'true');
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
  scene.add(earth.group);

  const beacons = createBeacons(pixelRatio, earth.uniforms.shared.uSunDirection);
  earth.spin.add(beacons);

  const starfield = createStarfield(pixelRatio, { count: 9000 });
  scene.add(starfield.group);

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

  // -------------------------------------------------------------------------
  // Studio GUI
  // -------------------------------------------------------------------------
  const gui = new GUI({ container: studioEl, title: 'Studio Controls' });

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
  atmosphereFolder.add(params, 'nightIntensity', 0.0, 3.0, 0.05).name('City Emission');

  const oceanFolder = gui.addFolder('Ocean & Terrain');
  oceanFolder.add(params, 'specularIntensity', 0.0, 3.0, 0.05).name('Sun Glitter');
  oceanFolder.add(params, 'oceanRoughness', 0.02, 0.45, 0.005).name('Sea Roughness');
  oceanFolder.add(params, 'waveStrength', 0.0, 2.5, 0.05).name('Wave Detail');
  oceanFolder.add(params, 'detailStrength', 0.0, 2.5, 0.05).name('Terrain Detail');
  oceanFolder.add(params, 'bumpScale', 0.0, 3.0, 0.05).name('Relief Strength');

  const cloudsFolder = gui.addFolder('Cloud Decks');
  cloudsFolder.add(params, 'cloudDrift', -0.15, 0.15, 0.001).name('Zonal Drift');
  cloudsFolder.add(params, 'cloudOpacity', 0.0, 1.0, 0.01).name('Cloud Density');
  cloudsFolder.add(params, 'cloudRelief', 0.0, 2.5, 0.05).name('Cumulus Relief');

  const dynamicsFolder = gui.addFolder('Orbital Dynamics');
  dynamicsFolder.add(params, 'autoRotation').name('Axial Auto-Spin');
  dynamicsFolder.add(params, 'rotationSpeed', -0.08, 0.08, 0.001).name('Spin Velocity');

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

  function getCityWorldPosition(city, radius = 1.0) {
    earth.group.updateMatrixWorld(true);
    const v = latLngToVector3(city.lat, city.lng, radius);
    return v.applyMatrix4(earth.spin.matrixWorld);
  }

  function showCityCard(city) {
    activeCity = city;
    if (!cityCardEl) return;
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

    document.querySelectorAll('.city-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-city') === city.id);
    });
  }

  function hideCityCard() {
    activeCity = null;
    cityCardEl?.setAttribute('hidden', '');
    document.querySelectorAll('.city-chip').forEach((btn) => btn.classList.remove('active'));
  }

  function flyToCity(city) {
    activeCity = city;
    params.autoRotation = false;

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
    isFlying = true;
    flyStartTime = performance.now();
    flyDuration = 1800;

    flyStartPos.copy(camera.position);
    flyStartTarget.copy(controls.target);

    const currentDir = camera.position.clone().normalize();
    flyEndPos.copy(currentDir.multiplyScalar(3.0));
    flyEndTarget.set(0, 0, 0);

    hideCityCard();
    params.autoRotation = true;
  }

  btnReturnOrbit?.addEventListener('click', resetToOrbit);
  cityCardClose?.addEventListener('click', hideCityCard);

  if (cityNavScrollEl) {
    CITIES.forEach((city) => {
      const btn = document.createElement('button');
      btn.className = 'city-chip';
      btn.type = 'button';
      btn.setAttribute('data-city', city.id);
      btn.innerHTML = `<span class="city-chip-ar">${city.nameAr}</span><span class="city-chip-en">${city.name}</span>`;
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
  const flyDir = new THREE.Vector3();

  let cloudTime = 0;
  let elapsedTime = 0;
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  let fpsSmoothed = 60;
  let lastAdapt = performance.now();

  function animate() {
    requestAnimationFrame(animate);

    timer.update();
    const delta = Math.min(timer.getDelta(), 0.1);
    const elapsed = timer.getElapsed();

    // --- Camera fly-to -----------------------------------------------------
    if (isFlying) {
      const t = Math.min(1.0, (performance.now() - flyStartTime) / flyDuration);
      const ease = 1.0 - Math.pow(1.0 - t, 5);

      const startDist = flyStartPos.length();
      const endDist = flyEndPos.length();
      const startDir = flyStartPos.clone().normalize();
      const endDir = flyEndPos.clone().normalize();

      const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
      const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), endDir);
      const qCur = new THREE.Quaternion().copy(qStart).slerp(qEnd, ease);
      flyDir.set(0, 0, 1).applyQuaternion(qCur).multiplyScalar(THREE.MathUtils.lerp(startDist, endDist, ease));

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
    earth.uniforms.cirrus.uCloudRelief.value = params.cloudRelief * 0.55;

    beacons.material.uniforms.uTime.value = elapsed;
    beacons.material.uniforms.uIntensity.value = params.beaconIntensity;

    starfield.starMaterial.uniforms.uOpacity.value = params.starfieldOpacity;
    starfield.milkyWayMaterial.uniforms.uIntensity.value = params.milkyWayIntensity;

    // --- Render ------------------------------------------------------------
    composer.render();

    // --- HUD ---------------------------------------------------------------
    if (utcLabelEl) {
      utcLabelEl.textContent = params.liveUTC
        ? `${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`
        : 'MANUAL SOLAR OVERRIDE';
    }
    if (subsolarLabelEl) subsolarLabelEl.textContent = `SUBSOLAR ${formatLatLng(lat, lng)}`;

    if (altitudeLabelEl) {
      const altitudeKm = Math.round(Math.max(0, camDist - 1.0) * 6371);
      altitudeLabelEl.textContent =
        camDist < 1.08
          ? `ALTITUDE ${altitudeKm.toLocaleString()} KM (URBAN INSPECTION)`
          : `ALTITUDE ${altitudeKm.toLocaleString()} KM`;
    }

    if (activeCity && cityTimeEl) cityTimeEl.textContent = getCityLocalTime(activeCity, now);

    // --- FPS + adaptive resolution ----------------------------------------
    frameCount += 1;
    const nowPerf = performance.now();
    if (nowPerf - lastFpsUpdate >= 500) {
      const fps = Math.round((frameCount * 1000) / (nowPerf - lastFpsUpdate));
      fpsSmoothed = fpsSmoothed * 0.6 + fps * 0.4;
      if (fpsLabelEl) fpsLabelEl.textContent = `${fps} FPS`;
      frameCount = 0;
      lastFpsUpdate = nowPerf;

      if (qualityMode === 'ultra' && nowPerf - lastAdapt > 2200) {
        if (fpsSmoothed < 42 && pixelRatio > adaptiveFloor + 0.02) {
          applyPixelRatio(pixelRatio - 0.15);
          lastAdapt = nowPerf;
        } else if (fpsSmoothed > 58 && pixelRatio < MAX_PIXEL_RATIO - 0.02) {
          applyPixelRatio(pixelRatio + 0.1);
          lastAdapt = nowPerf;
        }
      }
    }
  }

  updateModeBadge();
  setQuality('ultra');
  animate();
}

init().catch((err) => {
  reportFatal(err.message || String(err));
});

