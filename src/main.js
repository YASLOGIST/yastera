import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;

renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
  const vLog = gl.getShaderInfoLog(glVertexShader);
  const fLog = gl.getShaderInfoLog(glFragmentShader);
  reportFatal(`Shader Compile Error:\nVertex:\n${vLog}\n\nFragment:\n${fLog}`);
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// Camera: near plane 0.001 allows zero-clipping descent down to 50 km above terrain
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.001, 1000);
camera.position.set(0, 0, 3.1);

// Orbit Controls with orbital inertia and deep city-zoom altitude
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.85;
controls.enablePan = false;
controls.minDistance = 1.008; // Close orbital inspection (~50 km above surface)
controls.maxDistance = 6.0;

// ---------------------------------------------------------------------------
// Post-Processing Pipeline (HDR Selective Bloom)
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45, // strength (refined photorealistic glow)
  0.38, // radius
  0.88  // threshold (isolates pure HDR glints and atmospheric limb)
);
composer.addPass(bloomPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

// ---------------------------------------------------------------------------
// Asset Loading Pipeline
// ---------------------------------------------------------------------------
const loaderEl = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const loadingManager = new THREE.LoadingManager();

loadingManager.onProgress = (_url, loaded, total) => {
  if (loaderBar) {
    loaderBar.style.width = `${(loaded / total) * 100}%`;
  }
};

loadingManager.onLoad = () => {
  setTimeout(() => {
    if (loaderEl) loaderEl.classList.add('done');
  }, 220);
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
        resolve(tex);
      },
      undefined,
      (err) => reject(err)
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

  // Atmosphere & Surface
  atmosphereIntensity: 1.0,
  oceanRoughness: 0.14,
  specularIntensity: 1.0,
  nightIntensity: 1.0,
  bumpScale: 0.0035,

  // Clouds
  cloudSpeed: 0.012, // rad/sec relative drift
  cloudOpacity: 1.0,
  cloudRelief: 0.0035,

  // Planetary spin
  autoRotation: true,
  rotationSpeed: 0.018, // rad/sec

  // Bloom
  bloomStrength: 0.45,
  bloomRadius: 0.38,
  bloomThreshold: 0.88,

  // Layers
  showBeacons: true,
  beaconIntensity: 1.0,
  showStarfield: true,
  starfieldOpacity: 0.55,
};

// ---------------------------------------------------------------------------
// DOM HUD Elements
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

// Studio collapsible drawer toggle
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

// Quality preset segmented toggle
const qualityButtons = document.querySelectorAll('.segmented button[data-quality]');
function setQuality(mode) {
  qualityButtons.forEach((btn) => {
    const matches = btn.getAttribute('data-quality') === mode;
    btn.setAttribute('aria-checked', matches ? 'true' : 'false');
  });

  const pr = mode === 'ultra' ? Math.min(window.devicePixelRatio, 2) : 1;
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.resolution.set(window.innerWidth * pr, window.innerHeight * pr);
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
  // 1. Download/Load 5 textures
  const [day, night, specular, topology, clouds] = await Promise.all([
    loadTexture('/textures/earth_day.jpg', THREE.SRGBColorSpace),
    loadTexture('/textures/earth_night.jpg', THREE.SRGBColorSpace),
    loadTexture('/textures/earth_specular.jpg', THREE.NoColorSpace),
    loadTexture('/textures/earth_topology.jpg', THREE.NoColorSpace),
    loadTexture('/textures/earth_clouds.jpg', THREE.NoColorSpace),
  ]);

  // 2. Earth three-sphere system
  const earth = createEarth({ day, night, specular, topology, clouds });
  scene.add(earth.group);

  // 3. HDR Beacons & Starfield
  const pr = renderer.getPixelRatio();
  const beacons = createBeacons(pr, earth.uniforms.shared.uSunDirection);
  earth.spin.add(beacons);

  const starfield = createStarfield(pr);
  scene.add(starfield);

  // 4. Studio GUI setup
  const gui = new GUI({ container: studioEl, title: 'Studio Controls' });

  const solarFolder = gui.addFolder('Solar & Ephemeris');
  const liveUtcController = solarFolder
    .add(params, 'liveUTC')
    .name('Real-Time UTC Sync')
    .onChange(() => {
      updateModeBadge();
    });

  const lonController = solarFolder
    .add(params, 'sunLongitude', -180, 180, 0.1)
    .name('Sun Longitude (°)')
    .listen()
    .onChange(() => {
      params.liveUTC = false;
      liveUtcController.updateDisplay();
      updateModeBadge();
    });

  const latController = solarFolder
    .add(params, 'sunLatitude', -23.5, 23.5, 0.1)
    .name('Sun Latitude (°)')
    .listen()
    .onChange(() => {
      params.liveUTC = false;
      liveUtcController.updateDisplay();
      updateModeBadge();
    });

  solarFolder.add(params, 'sunIntensity', 0.2, 3.0, 0.05).name('Sun Intensity');

  const opticsFolder = gui.addFolder('Atmosphere & Surface');
  opticsFolder.add(params, 'atmosphereIntensity', 0.0, 2.5, 0.05).name('Atmosphere Rayleigh');
  opticsFolder.add(params, 'nightIntensity', 0.0, 3.0, 0.05).name('City Emission');
  opticsFolder.add(params, 'specularIntensity', 0.0, 3.0, 0.05).name('Ocean GGX Glint');
  opticsFolder.add(params, 'oceanRoughness', 0.04, 0.5, 0.01).name('Ocean Roughness');
  opticsFolder.add(params, 'bumpScale', 0.0, 0.015, 0.0005).name('Terrain Relief');

  const cloudsFolder = gui.addFolder('Cloud Layer');
  cloudsFolder.add(params, 'cloudSpeed', -0.05, 0.05, 0.001).name('Cloud Drift Speed');
  cloudsFolder.add(params, 'cloudOpacity', 0.0, 1.0, 0.05).name('Cloud Density');
  cloudsFolder.add(params, 'cloudRelief', 0.0, 0.01, 0.0005).name('Cumulus Relief');

  const dynamicsFolder = gui.addFolder('Orbital Dynamics');
  dynamicsFolder.add(params, 'autoRotation').name('Axial Auto-Spin');
  dynamicsFolder.add(params, 'rotationSpeed', -0.08, 0.08, 0.001).name('Spin Velocity');

  const postFolder = gui.addFolder('Post-Processing & Bloom');
  postFolder.add(params, 'bloomStrength', 0.0, 2.0, 0.05).name('Bloom Strength').onChange((v) => (bloomPass.strength = v));
  postFolder.add(params, 'bloomRadius', 0.0, 1.0, 0.05).name('Bloom Radius').onChange((v) => (bloomPass.radius = v));
  postFolder.add(params, 'bloomThreshold', 0.0, 1.5, 0.05).name('Bloom Threshold').onChange((v) => (bloomPass.threshold = v));
  postFolder.add(params, 'showBeacons').name('Orbital Beacons').onChange((v) => (beacons.visible = v));
  postFolder.add(params, 'beaconIntensity', 0.0, 3.0, 0.05).name('Beacon Power');
  postFolder.add(params, 'showStarfield').name('Starfield').onChange((v) => (starfield.visible = v));
  postFolder.add(params, 'starfieldOpacity', 0.0, 1.0, 0.05).name('Starfield Opacity');

  // -------------------------------------------------------------------------
  // City Navigation & Telemetry Setup
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
  let flyDuration = 1800;
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
    if (cityCardEl) cityCardEl.setAttribute('hidden', '');
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
    flyEndTarget.copy(cityWorldPos);

    flyStartTime = performance.now();
    flyDuration = 1800;
    isFlying = true;

    showCityCard(city);
  }

  function resetToOrbit() {
    isFlying = true;
    flyStartTime = performance.now();
    flyDuration = 1600;

    flyStartPos.copy(camera.position);
    flyStartTarget.copy(controls.target);

    const currentDir = camera.position.clone().normalize();
    flyEndPos.copy(currentDir.multiplyScalar(3.1));
    flyEndTarget.set(0, 0, 0);

    hideCityCard();
    params.autoRotation = true;
  }

  if (btnReturnOrbit) btnReturnOrbit.addEventListener('click', resetToOrbit);
  if (cityCardClose) cityCardClose.addEventListener('click', hideCityCard);

  // Populate navigation ribbon with city chips
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

  // Interactive Raycasting on Globe
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let pointerDownTime = 0;
  canvas.addEventListener('pointerdown', () => { pointerDownTime = performance.now(); });
  canvas.addEventListener('pointerup', (e) => {
    if (performance.now() - pointerDownTime > 250) return; // ignore orbit drags

    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const hits = raycaster.intersectObject(earth.surface, false);
    if (hits.length > 0) {
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
      if (closestCity && minDist < 0.16) {
        flyToCity(closestCity);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Resize Handler
  // -------------------------------------------------------------------------
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
    composer.setSize(width, height);

    const currentPr = renderer.getPixelRatio();
    bloomPass.resolution.set(width * currentPr, height * currentPr);
    beacons.material.uniforms.uPixelRatio.value = currentPr;
    starfield.material.uniforms.uPixelRatio.value = currentPr;
  });

  // -------------------------------------------------------------------------
  // Animation & Telemetry Loop
  // -------------------------------------------------------------------------
  const timer = new THREE.Timer();
  const subsolarLocal = new THREE.Vector3();
  const sunWorldPos = new THREE.Vector3();
  const earthWorldCenter = new THREE.Vector3();

  let cloudAngle = 0;
  let frameCount = 0;
  let lastFpsUpdate = performance.now();

  function animate() {
    requestAnimationFrame(animate);

    timer.update();
    const delta = Math.min(timer.getDelta(), 0.1);
    const elapsed = timer.getElapsed();

    // 0. Smooth Camera Fly-To Interpolation
    if (isFlying) {
      const elapsedFly = performance.now() - flyStartTime;
      const t = Math.min(1.0, elapsedFly / flyDuration);
      // Quintic ease out for silky cinematic deceleration
      const ease = 1.0 - Math.pow(1.0 - t, 5);

      const startDist = flyStartPos.length();
      const endDist = flyEndPos.length();
      const startDir = flyStartPos.clone().normalize();
      const endDir = flyEndPos.clone().normalize();

      const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
      const qEnd = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), endDir);
      const qCur = new THREE.Quaternion().copy(qStart).slerp(qEnd, ease);

      const curDir = new THREE.Vector3(0, 0, 1).applyQuaternion(qCur);
      const curDist = THREE.MathUtils.lerp(startDist, endDist, ease);

      camera.position.copy(curDir.multiplyScalar(curDist));
      controls.target.lerpVectors(flyStartTarget, flyEndTarget, ease);

      if (t >= 1.0) {
        isFlying = false;
      }
    }

    // 1. Controls update
    controls.update();

    // 2. Earth rotation & cloud drift
    if (params.autoRotation) {
      earth.spin.rotation.y += params.rotationSpeed * delta;
    }
    cloudAngle += params.cloudSpeed * delta;
    earth.setCloudRotation(cloudAngle);

    // 3. Solar ephemeris calculation
    const now = new Date();
    let lat, lng;
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

    // Ensure matrices are updated for local-to-world transformation
    earth.group.updateMatrixWorld(true);

    // Transform subsolar point to world direction
    latLngToVector3(lat, lng, 1.0, subsolarLocal);
    subsolarLocal.applyMatrix4(earth.spin.matrixWorld);
    earthWorldCenter.setFromMatrixPosition(earth.group.matrixWorld);
    sunWorldPos.copy(subsolarLocal).sub(earthWorldCenter).normalize();

    // 4. Sync Uniforms & Camera Distance
    const camDist = camera.position.length();
    earth.uniforms.shared.uSunDirection.value.copy(sunWorldPos);
    earth.uniforms.shared.uSunIntensity.value = params.sunIntensity;
    earth.uniforms.shared.uAtmosphereIntensity.value = params.atmosphereIntensity;
    earth.uniforms.shared.uCloudOpacity.value = params.cloudOpacity;
    earth.uniforms.shared.uCameraDistance.value = camDist;

    earth.uniforms.surface.uBumpScale.value = params.bumpScale;
    earth.uniforms.surface.uOceanRoughness.value = params.oceanRoughness;
    earth.uniforms.surface.uSpecularIntensity.value = params.specularIntensity;
    earth.uniforms.surface.uNightIntensity.value = params.nightIntensity;

    earth.uniforms.clouds.uCloudRelief.value = params.cloudRelief;

    beacons.material.uniforms.uTime.value = elapsed;
    beacons.material.uniforms.uIntensity.value = params.beaconIntensity;

    starfield.material.uniforms.uTime.value = elapsed;
    starfield.material.uniforms.uOpacity.value = params.starfieldOpacity;

    // 5. Render post-processing chain
    composer.render();

    // 6. HUD Telemetry Updates
    if (params.liveUTC) {
      if (utcLabelEl) {
        utcLabelEl.textContent = `${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
      }
    } else {
      if (utcLabelEl) {
        utcLabelEl.textContent = 'MANUAL SOLAR OVERRIDE';
      }
    }

    if (subsolarLabelEl) {
      subsolarLabelEl.textContent = `SUBSOLAR ${formatLatLng(lat, lng)}`;
    }

    if (altitudeLabelEl) {
      const altitudeKm = Math.round(Math.max(0, camDist - 1.0) * 6371);
      if (camDist < 1.08) {
        altitudeLabelEl.textContent = `ALTITUDE ${altitudeKm.toLocaleString()} KM (URBAN INSPECTION)`;
      } else {
        altitudeLabelEl.textContent = `ALTITUDE ${altitudeKm.toLocaleString()} KM`;
      }
    }

    if (activeCity && cityTimeEl) {
      cityTimeEl.textContent = getCityLocalTime(activeCity, now);
    }

    frameCount++;
    const nowPerf = performance.now();
    if (nowPerf - lastFpsUpdate >= 250) {
      const fps = Math.round((frameCount * 1000) / (nowPerf - lastFpsUpdate));
      if (fpsLabelEl) fpsLabelEl.textContent = `${fps} FPS`;
      frameCount = 0;
      lastFpsUpdate = nowPerf;
    }
  }

  updateModeBadge();
  animate();
}

init().catch((err) => {
  reportFatal(err.message || String(err));
});
