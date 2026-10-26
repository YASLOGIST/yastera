#!/usr/bin/env node
/**
 * Validate the city directory and its date-aware local-time display.
 *
 * Run with `npm run check:cities`.
 */
import assert from 'node:assert/strict';
import { CITIES, getCityLocalTime } from '../src/cities.js';

assert.ok(CITIES.length > 0, 'the city directory must not be empty');
assert.equal(new Set(CITIES.map(({ id }) => id)).size, CITIES.length, 'city IDs must be unique');

for (const city of CITIES) {
  assert.ok(city.name && city.nameAr, `${city.id}: both display names are required`);
  assert.ok(Number.isFinite(city.lat) && city.lat >= -90 && city.lat <= 90, `${city.id}: invalid latitude`);
  assert.ok(Number.isFinite(city.lng) && city.lng >= -180 && city.lng <= 180, `${city.id}: invalid longitude`);
  assert.doesNotThrow(
    () => new Intl.DateTimeFormat('en-US', { timeZone: city.timeZone }),
    `${city.id}: invalid IANA time zone ${city.timeZone}`,
  );
}

const city = (id) => CITIES.find((entry) => entry.id === id);
const localTime = (id, iso) => getCityLocalTime(city(id), new Date(iso));

// These paired dates catch the fixed-offset regression across both Egyptian
// and US daylight-saving transitions, while also checking the displayed offset.
assert.equal(localTime('cairo', '2026-01-15T12:00:00Z'), '2:00 PM GMT+2');
assert.equal(localTime('cairo', '2026-07-15T12:00:00Z'), '3:00 PM GMT+3');
assert.equal(localTime('new-york', '2026-01-15T12:00:00Z'), '7:00 AM GMT-5');
assert.equal(localTime('new-york', '2026-07-15T12:00:00Z'), '8:00 AM GMT-4');

console.log(`✓ ${CITIES.length} cities have valid coordinates/time zones; local times follow seasonal UTC offsets.`);
