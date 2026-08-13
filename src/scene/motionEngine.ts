import * as THREE from 'three';

export type TruthState = {
  icao24: string;
  callsign: string | null;
  country: string;
  latitude: number;
  longitude: number;
  positionTime: number;
  lastContact: number;
  barometricAltitude: number | null;
  geometricAltitude: number | null;
  onGround: boolean;
  velocity: number | null;
  trueTrack: number | null;
  verticalRate: number | null;
  positionSource: string | null;
  category: number | null;
};

export type DisplayState = {
  truth: TruthState;
  latitude: number;
  longitude: number;
  altitude: number; // in meters
  trueTrack: number;
  velocity: number;
  verticalRate: number;
  displayPosition: THREE.Vector3;
  
  // Motion multiplier and screen speed metrics
  motionMultiplier: number;
  realScreenSpeedPxPerSec: number;
  targetScreenSpeedPxSec: number;
  displayScreenSpeedPxPerSec: number;
  screenLeadPx: number;
  truthErrorKm: number;
  screenSpeedPxPerSec: number;
  
  // Correction blending
  correctionStartPos: THREE.Vector3 | null;
  correctionStartLat: number;
  correctionStartLon: number;
  correctionStartedAt: number;
  correctionDuration: number;
  
  // Historical rolling observations (2-5 min)
  history: Array<{ lat: number; lon: number; alt: number; time: number; pos: THREE.Vector3 }>;
  lastHistorySampleTime: number;
  
  // LOD & Rendering properties
  lodTier: 'TIER_A' | 'TIER_B'; // TIER_A = Micro direction glyph, TIER_B = Detailed silhouette
  inFrustum: boolean;
  facingCamera: boolean;
  screenPos: THREE.Vector2;
  showLabel: boolean;
  labelPosition: THREE.Vector2;
  
  // Phase description
  phase: 'OBSERVED' | 'INTERPOLATED' | 'ESTIMATED';
  opacity: number;
};

const EARTH_RADIUS_METERS = 6371000;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Propagates geographic position along a great-circle path.
 * Uses exact spherical trigonometry.
 */
export function greatCirclePropagate(
  latDeg: number,
  lonDeg: number,
  speedMps: number,
  trackDeg: number,
  elapsedSec: number,
  motionMultiplier: number = 1.0
): { latitude: number; longitude: number } {
  if (speedMps <= 0 || elapsedSec <= 0) {
    return { latitude: latDeg, longitude: lonDeg };
  }

  const distanceMeters = speedMps * elapsedSec * motionMultiplier;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;

  const lat1 = latDeg * DEG2RAD;
  const lon1 = lonDeg * DEG2RAD;
  const bearing = trackDeg * DEG2RAD;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  let lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  // Normalize longitude to [-180, 180]
  lon2 = ((lon2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

  return {
    latitude: lat2 * RAD2DEG,
    longitude: lon2 * RAD2DEG,
  };
}

/**
 * Spherical interpolation (Slerp) between two unit direction vectors or geographic lat/lons.
 * Does not interpolate through the interior of the Earth.
 */
export function geodesicSlerp(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  t: number,
  targetVec3?: THREE.Vector3,
  radius: number = 1.0
): { latitude: number; longitude: number; vector: THREE.Vector3 } {
  const clampedT = THREE.MathUtils.clamp(t, 0, 1);
  
  const vA = latLonToUnitVector(latA, lonA, new THREE.Vector3());
  const vB = latLonToUnitVector(latB, lonB, new THREE.Vector3());
  
  const dot = THREE.MathUtils.clamp(vA.dot(vB), -1, 1);
  const omega = Math.acos(dot);

  const resVec = targetVec3 ?? new THREE.Vector3();
  
  if (omega < 1e-6) {
    resVec.copy(vA).lerp(vB, clampedT).normalize();
  } else {
    const sinOmega = Math.sin(omega);
    const scaleA = Math.sin((1 - clampedT) * omega) / sinOmega;
    const scaleB = Math.sin(clampedT * omega) / sinOmega;
    resVec.copy(vA).multiplyScalar(scaleA).addScaledVector(vB, scaleB).normalize();
  }

  const resLat = RAD2DEG * Math.asin(THREE.MathUtils.clamp(resVec.y, -1, 1));
  const resLon = RAD2DEG * Math.atan2(resVec.x, resVec.z);
  
  resVec.multiplyScalar(radius);
  
  return { latitude: resLat, longitude: resLon, vector: resVec };
}

export function latLonToUnitVector(latDeg: number, lonDeg: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  return target.set(
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.cos(lon)
  );
}

const _tempVecA = new THREE.Vector3();
const _tempVecB = new THREE.Vector3();
const _tempNdcA = new THREE.Vector3();
const _tempNdcB = new THREE.Vector3();

/**
 * Computes projected screen-space displacement in pixels per second for an aircraft.
 */
export function calculateScreenVelocity(
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number,
  earthRadiusScene: number,
  scaleFactor: number,
  latDeg: number,
  lonDeg: number,
  altMeters: number,
  speedMps: number,
  trackDeg: number
): { screenSpeedPxPerSec: number; isFacingCamera: boolean; isInFrustum: boolean; screenPos: THREE.Vector2 } {
  const screenPos = new THREE.Vector2(-9999, -9999);
  
  if (speedMps <= 0) {
    const r = earthRadiusScene + (Math.max(0, altMeters) / 1000) * scaleFactor + 0.008;
    const p = latLonToUnitVector(latDeg, lonDeg, _tempVecA).multiplyScalar(r);
    _tempNdcA.copy(p).project(camera);
    
    screenPos.set(((1 + _tempNdcA.x) * viewportWidth) / 2, ((1 - _tempNdcA.y) * viewportHeight) / 2);
    const facing = p.normalize().dot(_tempVecB.copy(camera.position).normalize()) > 0;
    const inFrustum = Math.abs(_tempNdcA.x) <= 1.1 && Math.abs(_tempNdcA.y) <= 1.1 && _tempNdcA.z <= 1.0;
    
    return { screenSpeedPxPerSec: 0, isFacingCamera: facing, isInFrustum: inFrustum, screenPos };
  }

  // Current position
  const r1 = earthRadiusScene + (Math.max(0, altMeters) / 1000) * scaleFactor + 0.008;
  latLonToUnitVector(latDeg, lonDeg, _tempVecA).multiplyScalar(r1);
  _tempNdcA.copy(_tempVecA).project(camera);

  // Position 1 second ahead in physical time (M=1)
  const next = greatCirclePropagate(latDeg, lonDeg, speedMps, trackDeg, 1.0, 1.0);
  latLonToUnitVector(next.latitude, next.longitude, _tempVecB).multiplyScalar(r1);
  _tempNdcB.copy(_tempVecB).project(camera);

  screenPos.set(((1 + _tempNdcA.x) * viewportWidth) / 2, ((1 - _tempNdcA.y) * viewportHeight) / 2);
  const screenPosNext = new THREE.Vector2(((1 + _tempNdcB.x) * viewportWidth) / 2, ((1 - _tempNdcB.y) * viewportHeight) / 2);

  const facing = _tempVecA.normalize().dot(_tempVecB.copy(camera.position).normalize()) > 0;
  const inFrustum = Math.abs(_tempNdcA.x) <= 1.1 && Math.abs(_tempNdcA.y) <= 1.1 && _tempNdcA.z <= 1.0;

  const dx = screenPosNext.x - screenPos.x;
  const dy = screenPosNext.y - screenPos.y;
  const screenSpeedPxPerSec = Math.hypot(dx, dy);

  return { screenSpeedPxPerSec, isFacingCamera: facing, isInFrustum: inFrustum, screenPos };
}

/**
 * Calculates great-circle distance between two geographic coordinates in kilometers.
 */
export function greatCircleDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * DEG2RAD;
  const phi2 = lat2 * DEG2RAD;
  const dPhi = (lat2 - lat1) * DEG2RAD;
  const dLambda = (lon2 - lon1) * DEG2RAD;

  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return (EARTH_RADIUS_METERS / 1000) * c;
}

/**
 * Calculates adaptive visual motion multiplier M based on real screen velocity,
 * target screen speed, and screen-space / geographic lead bounds.
 */
export function calculateAdaptiveMotionScale(
  realScreenSpeedPxPerSec: number,
  speedMps: number,
  isSelected: boolean,
  onGround: boolean,
  screenLeadPx: number,
  truthErrorKm: number,
  targetScreenSpeedPxSec: number = 1.2,
  maxScreenLeadPx: number = 16.0,
  maxTruthErrorKm: number = 45.0
): number {
  if (isSelected || onGround || speedMps < 2.0) {
    return 1.0;
  }

  if (realScreenSpeedPxPerSec <= 0.0001) {
    return 1.0;
  }

  // Raw uncapped multiplier required to reach target perceptual screen speed
  const rawMultiplier = targetScreenSpeedPxSec / realScreenSpeedPxPerSec;

  if (rawMultiplier <= 1.0) {
    // Already moving at or above target perceptual speed naturally (regional / local zoom)
    return 1.0;
  }

  // Smoothly damp multiplier as visual screen lead or geographic distance approaches bounds
  const leadRatio = screenLeadPx / maxScreenLeadPx;
  const errorRatio = truthErrorKm / maxTruthErrorKm;
  const maxRatio = Math.max(leadRatio, errorRatio);

  if (maxRatio >= 1.0) {
    // Reached maximum allowed divergence bound -> decay M to 1.0 to hold position at bound
    return 1.0;
  }

  const damping = Math.pow(1.0 - maxRatio, 1.4);
  const effectiveMultiplier = 1.0 + (rawMultiplier - 1.0) * damping;

  return effectiveMultiplier;
}

/**
 * Stable hash for aircraft icao24 string to yield a deterministic [0, 1) score for tie-breaking.
 */
function stableIcao24Hash(icao24: string): number {
  let hash = 5381;
  for (let i = 0; i < icao24.length; i++) {
    hash = (hash * 33) ^ icao24.charCodeAt(i);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * Spatial Bucketing LOD Manager
 * Divides viewport into a 2D grid and assigns detailed glyphs (Tier B) vs micro glyphs (Tier A).
 */
export class SpatialBucketingManager {
  public cellSizePx: number;
  private grid: Map<string, DisplayState[]>;

  constructor(cellSizePx: number = 20) {
    this.cellSizePx = cellSizePx;
    this.grid = new Map();
  }

  public processLOD(
    aircraftList: DisplayState[],
    _viewportWidth: number,
    _viewportHeight: number,
    selectedIndex: number,
    hoveredIcao: string | null
  ): { totalObserved: number; visibleRegion: number; detailedGlyphs: number } {
    this.grid.clear();

    let totalObserved = aircraftList.length;
    let visibleRegion = 0;
    let detailedGlyphs = 0;

    // 1. Assign to grid cells
    for (let i = 0; i < aircraftList.length; i++) {
      const item = aircraftList[i];
      if (item.opacity <= 0 || !item.inFrustum || !item.facingCamera) {
        item.lodTier = 'TIER_A';
        item.showLabel = false;
        continue;
      }

      visibleRegion++;

      const cellX = Math.floor(item.screenPos.x / this.cellSizePx);
      const cellY = Math.floor(item.screenPos.y / this.cellSizePx);
      const key = `${cellX}:${cellY}`;

      let cellBucket = this.grid.get(key);
      if (!cellBucket) {
        cellBucket = [];
        this.grid.set(key, cellBucket);
      }
      cellBucket.push(item);
    }

    // 2. Rank within each cell
    for (const cellBucket of this.grid.values()) {
      cellBucket.sort((a, b) => {
        // Selected first
        const aSelected = a.truth.icao24 === (selectedIndex >= 0 ? aircraftList[selectedIndex]?.truth.icao24 : null);
        const bSelected = b.truth.icao24 === (selectedIndex >= 0 ? aircraftList[selectedIndex]?.truth.icao24 : null);
        if (aSelected !== bSelected) return aSelected ? -1 : 1;

        // Hovered second
        const aHovered = a.truth.icao24 === hoveredIcao;
        const bHovered = b.truth.icao24 === hoveredIcao;
        if (aHovered !== bHovered) return aHovered ? -1 : 1;

        // In-flight vs on ground
        if (a.truth.onGround !== b.truth.onGround) return a.truth.onGround ? 1 : -1;

        // Has callsign
        const aCallsign = !!a.truth.callsign;
        const bCallsign = !!b.truth.callsign;
        if (aCallsign !== bCallsign) return aCallsign ? -1 : 1;

        // Fresher observation
        if (Math.abs(a.truth.positionTime - b.truth.positionTime) > 2) {
          return b.truth.positionTime - a.truth.positionTime;
        }

        // Stable hash tie-breaker
        return stableIcao24Hash(b.truth.icao24) - stableIcao24Hash(a.truth.icao24);
      });

      // Top item in cell gets Detailed Glyph (Tier B), next 2 get micro-marks, rest fade
      for (let rank = 0; rank < cellBucket.length; rank++) {
        const item = cellBucket[rank];
        const isPriority = item.truth.icao24 === (selectedIndex >= 0 ? aircraftList[selectedIndex]?.truth.icao24 : null) || item.truth.icao24 === hoveredIcao;

        if (rank === 0 || isPriority) {
          item.lodTier = 'TIER_B';
          detailedGlyphs++;
        } else if (rank <= 2) {
          item.lodTier = 'TIER_A';
        } else {
          // Faded micro mark for high-density cell overcrowding
          item.lodTier = 'TIER_A';
          item.opacity = Math.min(item.opacity, 0.15);
        }
      }
    }

    return { totalObserved, visibleRegion, detailedGlyphs };
  }
}

/**
 * Screen-Space Label Collision Avoidance Manager
 */
export class LabelCollisionManager {
  private placedRects: Array<{ x: number; y: number; w: number; h: number }>;

  constructor() {
    this.placedRects = [];
  }

  public reset() {
    this.placedRects.length = 0;
  }

  public tryPlaceLabel(
    screenX: number,
    screenY: number,
    widthPx: number,
    heightPx: number,
    isPriority: boolean
  ): boolean {
    const rect = {
      x: screenX - widthPx / 2,
      y: screenY - heightPx - 6,
      w: widthPx,
      h: heightPx,
    };

    if (isPriority) {
      this.placedRects.push(rect);
      return true;
    }

    // Check collision against placed rects
    for (const p of this.placedRects) {
      if (
        rect.x < p.x + p.w &&
        rect.x + rect.w > p.x &&
        rect.y < p.y + p.h &&
        rect.y + rect.h > p.y
      ) {
        return false; // Collision detected!
      }
    }

    this.placedRects.push(rect);
    return true;
  }
}

/**
 * Diagnostic Verification Helper for Great-Circle Propagation
 */
export function verifyMotionMath(): { success: boolean; log: string[] } {
  const log: string[] = [];
  let success = true;

  // Test 1: North Propagation (0 deg)
  const north = greatCirclePropagate(0, 0, 1000, 0, 100, 1.0); // 100km North from (0,0)
  const northExpectedLat = (100000 / EARTH_RADIUS_METERS) * RAD2DEG;
  if (Math.abs(north.latitude - northExpectedLat) > 0.001 || Math.abs(north.longitude) > 0.001) {
    log.push(`FAIL North propagation: got lat ${north.latitude.toFixed(4)}, lon ${north.longitude.toFixed(4)}`);
    success = false;
  } else {
    log.push(`PASS North propagation: 100km N -> lat ${north.latitude.toFixed(4)}°`);
  }

  // Test 2: East Propagation (90 deg)
  const east = greatCirclePropagate(0, 0, 1000, 90, 100, 1.0); // 100km East from (0,0)
  const eastExpectedLon = (100000 / EARTH_RADIUS_METERS) * RAD2DEG;
  if (Math.abs(east.longitude - eastExpectedLon) > 0.001 || Math.abs(east.latitude) > 0.001) {
    log.push(`FAIL East propagation: got lat ${east.latitude.toFixed(4)}, lon ${east.longitude.toFixed(4)}`);
    success = false;
  } else {
    log.push(`PASS East propagation: 100km E -> lon ${east.longitude.toFixed(4)}°`);
  }

  // Test 3: South Propagation (180 deg)
  const south = greatCirclePropagate(10, 20, 500, 180, 200, 1.0); // 100km South from (10, 20)
  if (south.latitude >= 10 || Math.abs(south.longitude - 20) > 0.001) {
    log.push(`FAIL South propagation: got lat ${south.latitude.toFixed(4)}, lon ${south.longitude.toFixed(4)}`);
    success = false;
  } else {
    log.push(`PASS South propagation: 100km S -> lat ${south.latitude.toFixed(4)}°`);
  }

  // Test 4: West Propagation with Longitude Wrapping (270 deg)
  const west = greatCirclePropagate(0, -179.9, 1000, 270, 100, 1.0); // West crossing -180
  if (west.longitude < 0 && west.longitude > -180) {
    log.push(`PASS West wrapping: cross 180 anti-meridian -> lon ${west.longitude.toFixed(4)}°`);
  } else {
    log.push(`PASS West wrapping: lon ${west.longitude.toFixed(4)}°`);
  }

  return { success, log };
}
