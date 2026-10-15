import { Vector3 } from 'three';

const DEG = Math.PI / 180;

/**
 * Converts geodetic latitude/longitude to a point on a sphere in the planet's
 * local frame, matching THREE.SphereGeometry's equirectangular UV layout:
 *   lon   0° → +X (Greenwich, u = 0.5)
 *   lon -90° → +Z (u = 0.25)
 *   lat +90° → +Y (north pole, v = 1)
 *
 * @param {number} lat     Latitude in degrees (+N).
 * @param {number} lng     Longitude in degrees (+E).
 * @param {number} radius  Sphere radius.
 * @param {Vector3} [target]
 * @returns {Vector3}
 */
export function latLngToVector3(lat, lng, radius = 1, target = new Vector3()) {
  const phi = lat * DEG;
  const lambda = lng * DEG;
  const cosPhi = Math.cos(phi);
  return target.set(
    radius * cosPhi * Math.cos(lambda),
    radius * Math.sin(phi),
    -radius * cosPhi * Math.sin(lambda),
  );
}

/**
 * @param {number} lat
 * @param {number} lng
 * @returns {string} e.g. "8.65°S 33.56°W"
 */
export function formatLatLng(lat, lng) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(lng).toFixed(2)}°${ew}`;
}
