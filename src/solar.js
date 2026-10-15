/**
 * Low-precision solar ephemeris (Astronomical Almanac / NOAA algorithm).
 *
 * Accuracy: ~0.01° in declination and right ascension for 1950–2050, which
 * is far below one texel of a 4K equirectangular Earth map (~0.09°).
 */

const DEG = Math.PI / 180;

/** @param {number} x */
const norm360 = (x) => ((x % 360) + 360) % 360;

/** @param {number} x */
const norm180 = (x) => {
  const v = norm360(x + 180) - 180;
  return v === -180 ? 180 : v;
};

/**
 * @typedef {object} SolarPosition
 * @property {number} declination        Subsolar latitude in degrees (+N).
 * @property {number} subsolarLongitude  Subsolar longitude in degrees (+E, [-180, 180]).
 * @property {number} rightAscension     Apparent right ascension in degrees.
 * @property {number} gmst               Greenwich mean sidereal time in degrees.
 * @property {number} obliquity          Mean obliquity of the ecliptic in degrees.
 */

/**
 * Computes the geographic point where the Sun is at the zenith.
 * @param {Date} date
 * @returns {SolarPosition}
 */
export function solarPosition(date) {
  const julianDay = date.getTime() / 86_400_000 + 2_440_587.5;
  const n = julianDay - 2_451_545.0; // days since J2000.0

  const meanLongitude = norm360(280.460 + 0.9856474 * n);
  const meanAnomaly = norm360(357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = 23.439 - 0.0000004 * n;
  const eps = obliquity * DEG;

  const rightAscension = Math.atan2(Math.cos(eps) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) / DEG;
  const declination = Math.asin(Math.sin(eps) * Math.sin(eclipticLongitude)) / DEG;
  const gmst = norm360(280.46061837 + 360.98564736629 * n);

  return {
    declination,
    subsolarLongitude: norm180(rightAscension - gmst),
    rightAscension: norm360(rightAscension),
    gmst,
    obliquity,
  };
}

export { norm180 };
