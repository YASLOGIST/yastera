#!/usr/bin/env node
/**
 * Numerical checks for the illustrative low-Earth-orbit model.
 * Run with `npm run check:leo`.
 */
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  EARTH_MEAN_RADIUS_KM,
  LEO_ALTITUDE_KM,
  LEO_INCLINATION_DEG,
  LEO_ORBITAL_PERIOD_MINUTES,
  LEO_ORBITAL_SPEED_KM_S,
  LEO_ORBIT_RADIUS,
  LEO_ORBIT_RADIUS_KM,
  earthFixedPosition,
  geodeticFromPosition,
  isSatelliteEclipsed,
  leoPositionAtSeconds,
} from '../src/leoTracker.js';

const tolerance = 1e-9;
assert.equal(LEO_ORBIT_RADIUS_KM, EARTH_MEAN_RADIUS_KM + LEO_ALTITUDE_KM);
assert.ok(Math.abs(LEO_ORBITAL_SPEED_KM_S - 7.66) < 0.02, 'circular LEO speed should be about 7.66 km/s');
assert.ok(Math.abs(LEO_ORBITAL_PERIOD_MINUTES - 92.8) < 0.2, '420 km circular LEO period should be about 92.8 minutes');
assert.ok(Math.abs(LEO_ORBIT_RADIUS - LEO_ORBIT_RADIUS_KM / EARTH_MEAN_RADIUS_KM) < tolerance);

const initial = leoPositionAtSeconds(0, new Vector3());
const afterOneOrbit = leoPositionAtSeconds(LEO_ORBITAL_PERIOD_MINUTES * 60, new Vector3());
assert.ok(initial.distanceTo(afterOneOrbit) < 1e-9, 'orbit position should repeat after one period');

const sample = new Vector3();
let maximumAbsoluteLatitude = 0;
for (let i = 0; i < 720; i += 1) {
  leoPositionAtSeconds((LEO_ORBITAL_PERIOD_MINUTES * 60 * i) / 720, sample);
  assert.ok(Math.abs(sample.length() - LEO_ORBIT_RADIUS) < 1e-6, 'circular orbit radius must remain constant');
  maximumAbsoluteLatitude = Math.max(maximumAbsoluteLatitude, Math.abs(geodeticFromPosition(sample).latitude));
}
assert.ok(
  Math.abs(maximumAbsoluteLatitude - LEO_INCLINATION_DEG) < 0.02,
  'maximum sub-satellite latitude should match the modeled inclination',
);

const inertialEquatorPoint = new Vector3(1, 0, 0);
const bodyFixed = earthFixedPosition(inertialEquatorPoint, Math.PI / 2, new Vector3());
const rotatedCoordinates = geodeticFromPosition(bodyFixed);
assert.ok(Math.abs(rotatedCoordinates.longitude + 90) < 1e-8, 'planet spin must be removed from the ground-track longitude');

const sunDirection = new Vector3(0, 0, 1);
assert.equal(isSatelliteEclipsed(new Vector3(0, 0, LEO_ORBIT_RADIUS), sunDirection), false, 'sunward satellite should be illuminated');
assert.equal(isSatelliteEclipsed(new Vector3(0, 0, -LEO_ORBIT_RADIUS), sunDirection), true, 'satellite behind the Earth should be in eclipse');
assert.equal(isSatelliteEclipsed(new Vector3(1.01, 0, -LEO_ORBIT_RADIUS), sunDirection), false, 'satellite outside the cylindrical shadow should remain sunlit');

console.log(`✓ LEO model: ${LEO_ALTITUDE_KM} km altitude, ${LEO_ORBITAL_SPEED_KM_S.toFixed(2)} km/s, ${LEO_ORBITAL_PERIOD_MINUTES.toFixed(1)} min period; ground-track and eclipse geometry pass.`);
