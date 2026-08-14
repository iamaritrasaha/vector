import * as THREE from 'three';

export interface SolarState {
  directionEquatorial: THREE.Vector3;
  rightAscensionRad: number;
  declinationRad: number;
  subsolarLatitudeDeg: number;
  subsolarLongitudeDeg: number;
}

const JD_J2000 = 2451545.0;
const MILLISECONDS_PER_DAY = 86400000;

/**
 * Calculates Julian Date from a UTC millisecond timestamp.
 */
export function calculateJulianDate(epochMs: number): number {
  return epochMs / MILLISECONDS_PER_DAY + 2440587.5;
}

/**
 * Calculates Greenwich Mean Sidereal Time (GMST) in radians from a UTC millisecond timestamp.
 * Based on IAU-82 standard polynomial formula.
 */
export function calculateGmstRad(epochMs: number): number {
  const jd = calculateJulianDate(epochMs);
  const d = jd - JD_J2000;
  const T = d / 36525.0;
  let gmstDeg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000.0;
  gmstDeg = ((gmstDeg % 360) + 360) % 360;
  return THREE.MathUtils.degToRad(gmstDeg);
}

/**
 * Calculates deterministic high-precision low-error astronomical solar state from UTC.
 * Uses standard low-error solar ephemeris (Julian centuries, geometric mean longitude,
 * mean anomaly, equation of center, apparent ecliptic longitude, nutation correction,
 * and true obliquity).
 * 
 * Returns direction vector in VECTOR's equatorial frame (x=Y_eci, y=Z_eci, z=X_eci),
 * RA/Dec in radians, and subsolar latitude/longitude in degrees.
 */
export function calculateSolarState(dateInput: Date | number): SolarState {
  const epochMs = typeof dateInput === 'number' ? dateInput : dateInput.getTime();
  const jd = calculateJulianDate(epochMs);
  const T = (jd - JD_J2000) / 36525.0;

  // 1. Geometric Mean Longitude of Sun (degrees)
  let L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  L0 = ((L0 % 360) + 360) % 360;

  // 2. Mean Anomaly of Sun (degrees)
  let M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  M = ((M % 360) + 360) % 360;
  const Mrad = THREE.MathUtils.degToRad(M);

  // 3. Sun's Equation of the Center (degrees)
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
    + 0.000289 * Math.sin(3 * Mrad);

  // 4. Sun's True Longitude (degrees)
  const sunTrueLon = L0 + C;

  // 5. Longitude of Moon's ascending node (degrees) for nutation
  const omega = 125.04 - 1934.136 * T;
  const omegaRad = THREE.MathUtils.degToRad(omega);

  // 6. Apparent Ecliptic Longitude (degrees)
  const lambdaDeg = sunTrueLon - 0.00569 - 0.00478 * Math.sin(omegaRad);
  const lambdaRad = THREE.MathUtils.degToRad(lambdaDeg);

  // 7. Obliquity of the Ecliptic (degrees)
  const eps0 = 23.439291 - 0.0130042 * T - 0.00000016 * T * T + 0.000000504 * T * T * T;
  const epsDeg = eps0 + 0.00256 * Math.cos(omegaRad);
  const epsRad = THREE.MathUtils.degToRad(epsDeg);

  // 8. Equatorial Coordinates (Right Ascension alpha, Declination delta)
  const sinDelta = Math.sin(epsRad) * Math.sin(lambdaRad);
  const declinationRad = Math.asin(sinDelta);

  const yAlpha = Math.cos(epsRad) * Math.sin(lambdaRad);
  const xAlpha = Math.cos(lambdaRad);
  let rightAscensionRad = Math.atan2(yAlpha, xAlpha);
  if (rightAscensionRad < 0) {
    rightAscensionRad += Math.PI * 2;
  }

  // 9. Direction in VECTOR Equatorial Frame (where x = Y_eci, y = Z_eci, z = X_eci)
  // X_eci = cos(delta)*cos(alpha)
  // Y_eci = cos(delta)*sin(alpha)
  // Z_eci = sin(delta)
  const cosDelta = Math.cos(declinationRad);
  const dirX = cosDelta * Math.sin(rightAscensionRad); // Y_eci
  const dirY = sinDelta;                              // Z_eci
  const dirZ = cosDelta * Math.cos(rightAscensionRad); // X_eci
  const directionEquatorial = new THREE.Vector3(dirX, dirY, dirZ).normalize();

  // 10. Subsolar geographic coordinates (Lat in [-90, 90], Lon in [-180, 180))
  const subsolarLatitudeDeg = THREE.MathUtils.radToDeg(declinationRad);
  const gmstRad = calculateGmstRad(epochMs);
  let subsolarLonDeg = THREE.MathUtils.radToDeg(rightAscensionRad - gmstRad);
  subsolarLonDeg = ((subsolarLonDeg + 180) % 360 + 360) % 360 - 180;
  if (subsolarLonDeg === 180) subsolarLonDeg = -180;

  return {
    directionEquatorial,
    rightAscensionRad,
    declinationRad,
    subsolarLatitudeDeg,
    subsolarLongitudeDeg: subsolarLonDeg,
  };
}

/**
 * Deterministic mathematical verification of the solar ephemeris model.
 * Asserts unit length, equinox declinations ≈ 0°, solstice declinations ≈ ±23.44°,
 * and subsolar longitude bounds [-180, 180).
 */
export function verifySolarEphemeris(): { passed: boolean; results: Record<string, any> } {
  const tests: Record<string, any> = {};

  // Test A: Unit length
  const nowState = calculateSolarState(Date.now());
  const len = nowState.directionEquatorial.length();
  tests.unitLength = { length: len, pass: Math.abs(len - 1.0) < 1e-6 };

  // Test B: March Equinox (around March 20, 2026 14:46 UTC)
  const marchEquinox = calculateSolarState(new Date('2026-03-20T14:46:00Z'));
  tests.marchEquinox = {
    subsolarLat: marchEquinox.subsolarLatitudeDeg,
    pass: Math.abs(marchEquinox.subsolarLatitudeDeg) < 0.25,
  };

  // Test C: June Solstice (around June 21, 2026 08:24 UTC)
  const juneSolstice = calculateSolarState(new Date('2026-06-21T08:24:00Z'));
  tests.juneSolstice = {
    subsolarLat: juneSolstice.subsolarLatitudeDeg,
    pass: Math.abs(juneSolstice.subsolarLatitudeDeg - 23.44) < 0.25,
  };

  // Test D: September Equinox (around Sept 22, 2026 21:05 UTC)
  const septEquinox = calculateSolarState(new Date('2026-09-22T21:05:00Z'));
  tests.septEquinox = {
    subsolarLat: septEquinox.subsolarLatitudeDeg,
    pass: Math.abs(septEquinox.subsolarLatitudeDeg) < 0.25,
  };

  // Test E: December Solstice (around Dec 21, 2026 20:50 UTC)
  const decSolstice = calculateSolarState(new Date('2026-12-21T20:50:00Z'));
  tests.decSolstice = {
    subsolarLat: decSolstice.subsolarLatitudeDeg,
    pass: Math.abs(decSolstice.subsolarLatitudeDeg - (-23.44)) < 0.25,
  };

  // Test F: Longitude bounds [-180, 180) across 24 hourly samples
  let lonBoundsPass = true;
  for (let h = 0; h < 24; h++) {
    const s = calculateSolarState(new Date(Date.UTC(2026, 5, 21, h, 0, 0)));
    if (s.subsolarLongitudeDeg < -180 || s.subsolarLongitudeDeg >= 180) {
      lonBoundsPass = false;
    }
  }
  tests.longitudeBounds = { pass: lonBoundsPass };

  const allPassed = Object.values(tests).every((t) => t.pass);
  return { passed: allPassed, results: tests };
}
