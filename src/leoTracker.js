import * as THREE from 'three';

export const EARTH_MEAN_RADIUS_KM = 6371.0;
export const EARTH_GRAVITATIONAL_PARAMETER_KM3_S2 = 398600.4418;
export const LEO_ALTITUDE_KM = 420.0;
export const LEO_INCLINATION_DEG = 51.6;
export const LEO_ORBIT_RADIUS_KM = EARTH_MEAN_RADIUS_KM + LEO_ALTITUDE_KM;
export const LEO_ORBIT_RADIUS = LEO_ORBIT_RADIUS_KM / EARTH_MEAN_RADIUS_KM;
export const LEO_ORBITAL_SPEED_KM_S = Math.sqrt(
  EARTH_GRAVITATIONAL_PARAMETER_KM3_S2 / LEO_ORBIT_RADIUS_KM,
);
export const LEO_ORBITAL_PERIOD_SECONDS = 2 * Math.PI * Math.sqrt(
  (LEO_ORBIT_RADIUS_KM ** 3) / EARTH_GRAVITATIONAL_PARAMETER_KM3_S2,
);
export const LEO_ORBITAL_PERIOD_MINUTES = LEO_ORBITAL_PERIOD_SECONDS / 60;

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const INCLINATION = THREE.MathUtils.degToRad(LEO_INCLINATION_DEG);
const INITIAL_PHASE = THREE.MathUtils.degToRad(39.0);
const ORBIT_SEGMENTS = 256;
const GROUND_TRACK_RADIUS = 1.0012;
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

/** Position on a circular, 51.6° inclined LEO in Earth radii. */
export function leoPositionAtSeconds(simulationSeconds, target = new THREE.Vector3()) {
  const meanMotion = TAU / LEO_ORBITAL_PERIOD_SECONDS;
  const phase = INITIAL_PHASE + simulationSeconds * meanMotion;
  return target.set(
    LEO_ORBIT_RADIUS * Math.cos(phase),
    LEO_ORBIT_RADIUS * Math.sin(phase) * Math.sin(INCLINATION),
    -LEO_ORBIT_RADIUS * Math.sin(phase) * Math.cos(INCLINATION),
  );
}

/**
 * Convert an inertial orbit position into the rotating planet-fixed frame.
 * The Earth spin is around local +Y; longitude is positive east.
 */
export function earthFixedPosition(position, spinAngle, target = new THREE.Vector3()) {
  return target.copy(position).applyAxisAngle(LOCAL_Y, -spinAngle);
}

export function geodeticFromPosition(position, target = {}) {
  const radius = Math.max(position.length(), 1e-8);
  target.latitude = Math.asin(THREE.MathUtils.clamp(position.y / radius, -1, 1)) * DEG;
  target.longitude = Math.atan2(-position.z, position.x) * DEG;
  return target;
}

/** Cylindrical Earth-shadow test; false in the penumbra boundary by design. */
export function isSatelliteEclipsed(position, sunDirection) {
  const alongSun = position.dot(sunDirection);
  if (alongSun >= 0) return false;
  const perpendicularRadiusSq = Math.max(position.lengthSq() - alongSun * alongSun, 0);
  return perpendicularRadiusSq < 1.0;
}

function createSatelliteTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the LEO marker texture');

  const glow = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  glow.addColorStop(0, 'rgba(77, 223, 255, 0.44)');
  glow.addColorStop(0.42, 'rgba(49, 183, 238, 0.14)');
  glow.addColorStop(1, 'rgba(49, 183, 238, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 64);

  context.strokeStyle = 'rgba(181, 244, 255, 0.96)';
  context.lineWidth = 2;
  context.fillStyle = '#2185a8';
  context.fillRect(8, 25, 16, 14);
  context.fillRect(40, 25, 16, 14);
  for (const x of [13, 19, 45, 51]) {
    context.beginPath();
    context.moveTo(x, 26);
    context.lineTo(x, 38);
    context.stroke();
  }
  context.fillStyle = '#f0fcff';
  context.fillRect(27, 23, 10, 18);
  context.strokeRect(27, 23, 10, 18);
  context.beginPath();
  context.moveTo(32, 23);
  context.lineTo(32, 13);
  context.lineTo(37, 9);
  context.moveTo(32, 13);
  context.lineTo(27, 9);
  context.stroke();
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.arc(32, 32, 2, 0, TAU);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

/**
 * Creates an explicitly illustrative ISS-class low-Earth-orbit overlay.
 * The orbit radius is to scale; the billboard marker is enlarged for visibility.
 */
export function createLEOTracker(earthGroup, earthSpin) {
  const orbitGroup = new THREE.Group();
  orbitGroup.name = 'leoOrbitSystem';
  earthGroup.add(orbitGroup);

  const orbitPositions = new Float32Array(ORBIT_SEGMENTS * 3);
  const orbitSample = new THREE.Vector3();
  for (let i = 0; i < ORBIT_SEGMENTS; i += 1) {
    const phase = INITIAL_PHASE + (i / ORBIT_SEGMENTS) * TAU;
    orbitSample.set(
      LEO_ORBIT_RADIUS * Math.cos(phase),
      LEO_ORBIT_RADIUS * Math.sin(phase) * Math.sin(INCLINATION),
      -LEO_ORBIT_RADIUS * Math.sin(phase) * Math.cos(INCLINATION),
    );
    orbitSample.toArray(orbitPositions, i * 3);
  }

  const orbitGeometry = new THREE.BufferGeometry();
  orbitGeometry.setAttribute('position', new THREE.BufferAttribute(orbitPositions, 3));
  orbitGeometry.computeBoundingSphere();
  const orbitPath = new THREE.LineLoop(
    orbitGeometry,
    new THREE.LineBasicMaterial({
      color: 0x64dff7,
      transparent: true,
      opacity: 0.38,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  orbitPath.name = 'leoOrbitPath';
  orbitPath.renderOrder = 3;
  orbitGroup.add(orbitPath);

  const iconTexture = createSatelliteTexture();
  const icon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: iconTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 0.96,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }));
  icon.name = 'leoSatelliteMarker';
  icon.renderOrder = 5;
  icon.frustumCulled = false;
  orbitGroup.add(icon);

  const groundGeometry = new THREE.BufferGeometry();
  groundGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const groundMarker = new THREE.Points(
    groundGeometry,
    new THREE.PointsMaterial({
      color: 0x70eaff,
      size: 7,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  groundMarker.name = 'leoGroundTrackMarker';
  groundMarker.renderOrder = 4;
  groundMarker.frustumCulled = false;
  earthSpin.add(groundMarker);

  const position = new THREE.Vector3();
  const earthFixed = new THREE.Vector3();
  const coordinates = { latitude: 0, longitude: 0 };
  const telemetry = {
    position,
    latitude: 0,
    longitude: 0,
    phase: 0,
    eclipse: false,
  };

  function update(simulationSeconds, earthSpinAngle, cameraDistance = 3.0) {
    leoPositionAtSeconds(simulationSeconds, position);
    icon.position.copy(position);
    // This is a map symbol rather than a to-scale spacecraft model. Scaling by
    // camera range keeps it legible without becoming enormous during city zooms.
    icon.scale.setScalar(Math.max(0.006, cameraDistance * 0.0075));

    earthFixedPosition(position, earthSpinAngle, earthFixed);
    geodeticFromPosition(earthFixed, coordinates);
    telemetry.latitude = coordinates.latitude;
    telemetry.longitude = coordinates.longitude;
    telemetry.phase = ((INITIAL_PHASE + simulationSeconds * TAU / LEO_ORBITAL_PERIOD_SECONDS) % TAU + TAU) % TAU / TAU;
    earthFixed.setLength(GROUND_TRACK_RADIUS);
    groundMarker.position.copy(earthFixed);
    return telemetry;
  }

  function setVisible(visible) {
    orbitGroup.visible = visible;
    groundMarker.visible = visible;
  }

  return {
    group: orbitGroup,
    orbitPath,
    icon,
    groundMarker,
    position,
    telemetry,
    update,
    setVisible,
  };
}
