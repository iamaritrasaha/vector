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

/**
 * Authoritative Observation Anchor for time-anchored prediction.
 * Derived strictly from real sensor observations; never mutated during render loop.
 */
export type ObservationAnchor = {
  latitude: number;
  longitude: number;
  altitude: number; // meters
  velocity: number; // m/s
  trueTrack: number; // deg
  verticalRate: number; // m/s
  positionTime: number; // epoch seconds
  onGround: boolean;
};

export type DisplayState = {
  truth: TruthState;
  
  // Authoritative Observation Anchor
  anchor: ObservationAnchor;

  // Filtered / Visual states (converge smoothly over short windows)
  visualHeading: number;
  visualVelocity: number;
  visualVerticalRate: number;
  visualAltitude: number;
  
  // Bounded Visual Clock Rate State (dLead/dt = visualRate - 1)
  accumulatedVisualLead: number;
  visualRate: number;
  visualLeadSeconds: number;

  // Rendered Display Output
  latitude: number;
  longitude: number;
  altitude: number;
  trueTrack: number;
  velocity: number;
  verticalRate: number;
  displayPosition: THREE.Vector3;

  // Analytic metrics & truth monitoring
  physicalPosition: { latitude: number; longitude: number; altitude: number };
  truthErrorKm: number;
  screenLeadPx: number;
  realScreenSpeedPxPerSec: number;
  displayScreenSpeedPxPerSec: number;
  targetScreenSpeedPxSec: number;
  confidence: number;

  // New Observation Reconciliation (Geodesic Blend from rendered state to analytical target)
  reconciling: boolean;
  blendFromLat: number;
  blendFromLon: number;
  blendFromAlt: number;
  reconcileStartedAt: number;
  reconcileDuration: number;

  // Historical rolling observations for trails
  history: Array<{ lat: number; lon: number; alt: number; time: number; pos: THREE.Vector3 }>;
  lastHistorySampleTime: number;

  // LOD & Rendering properties
  lodTier: 'TIER_A' | 'TIER_B';
  inFrustum: boolean;
  facingCamera: boolean;
  screenPos: THREE.Vector2;
  showLabel: boolean;
  labelPosition: THREE.Vector2;

  // Phase & Opacity
  phase: 'OBSERVED' | 'INTERPOLATED' | 'ESTIMATED';
  opacity: number;
};

export const EARTH_RADIUS_METERS = 6371000;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Propagates geographic position along a great-circle / geodesic path.
 * Uses exact spherical trigonometry with pole & meridian stability.
 */
export function greatCirclePropagate(
  latDeg: number,
  lonDeg: number,
  speedMps: number,
  trackDeg: number,
  elapsedSec: number,
  motionMultiplier: number = 1.0
): { latitude: number; longitude: number } {
  if (speedMps <= 0 || elapsedSec <= 0 || motionMultiplier <= 0) {
    return { latitude: latDeg, longitude: lonDeg };
  }

  const distanceMeters = speedMps * elapsedSec * motionMultiplier;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;

  if (angularDistance < 1e-12) {
    return { latitude: latDeg, longitude: lonDeg };
  }

  const lat1 = latDeg * DEG2RAD;
  const lon1 = lonDeg * DEG2RAD;
  const bearing = trackDeg * DEG2RAD;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinDist = Math.sin(angularDistance);
  const cosDist = Math.cos(angularDistance);

  const sinLat2 = sinLat1 * cosDist + cosLat1 * sinDist * Math.cos(bearing);
  const clampedSinLat2 = Math.max(-1, Math.min(1, sinLat2));
  const lat2 = Math.asin(clampedSinLat2);

  let lon2: number;
  const cosLat2 = Math.cos(lat2);

  if (Math.abs(cosLat2) < 1e-10) {
    // Exactly at North or South Pole
    lon2 = lon1;
  } else {
    const y = Math.sin(bearing) * sinDist * cosLat1;
    const x = cosDist - sinLat1 * clampedSinLat2;
    lon2 = lon1 + Math.atan2(y, x);
  }

  // Normalize longitude to [-PI, PI]
  lon2 = ((lon2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

  const resLat = THREE.MathUtils.clamp(lat2 * RAD2DEG, -90, 90);
  const resLon = ((lon2 * RAD2DEG + 540) % 360) - 180;

  return {
    latitude: resLat,
    longitude: resLon,
  };
}

const _tempSlerpA = new THREE.Vector3();
const _tempSlerpB = new THREE.Vector3();

/**
 * Spherical interpolation (Slerp) between two geographic coordinates.
 * Operates along the great-circle surface without chord cutting.
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
  
  const vA = latLonToUnitVector(latA, lonA, _tempSlerpA);
  const vB = latLonToUnitVector(latB, lonB, _tempSlerpB);
  
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

  const resLat = THREE.MathUtils.clamp(RAD2DEG * Math.asin(THREE.MathUtils.clamp(resVec.y, -1, 1)), -90, 90);
  const resLon = ((RAD2DEG * Math.atan2(resVec.x, resVec.z) + 540) % 360) - 180;
  
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

const _tempVecLocalA = new THREE.Vector3();
const _tempVecLocalB = new THREE.Vector3();
const _tempVecWorldA = new THREE.Vector3();
const _tempVecWorldB = new THREE.Vector3();
const _tempNdcA = new THREE.Vector3();
const _tempNdcB = new THREE.Vector3();

/**
 * Computes projected screen-space displacement in pixels per second using
 * the EXACT authoritative Earth world matrix transformation and camera projection.
 */
export function calculateWorldScreenVelocity(
  camera: THREE.Camera,
  earthMatrixWorld: THREE.Matrix4,
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
  const r1 = earthRadiusScene + (Math.max(0, altMeters) / 1000) * scaleFactor + 0.008;

  // Local earth coordinates
  latLonToUnitVector(latDeg, lonDeg, _tempVecLocalA).multiplyScalar(r1);
  // Authoritative world position using earth.matrixWorld
  _tempVecWorldA.copy(_tempVecLocalA).applyMatrix4(earthMatrixWorld);

  _tempNdcA.copy(_tempVecWorldA).project(camera);
  screenPos.set(((1 + _tempNdcA.x) * viewportWidth) / 2, ((1 - _tempNdcA.y) * viewportHeight) / 2);

  const camWorldPos = _tempVecWorldB.setFromMatrixPosition(camera.matrixWorld);
  const facing = _tempVecWorldA.clone().normalize().dot(camWorldPos.clone().normalize()) > 0;
  const inFrustum = Math.abs(_tempNdcA.x) <= 1.15 && Math.abs(_tempNdcA.y) <= 1.15 && _tempNdcA.z <= 1.0;

  if (speedMps <= 0) {
    return { screenSpeedPxPerSec: 0, isFacingCamera: facing, isInFrustum: inFrustum, screenPos };
  }

  // Physical displacement 1 second ahead
  const next = greatCirclePropagate(latDeg, lonDeg, speedMps, trackDeg, 1.0, 1.0);
  latLonToUnitVector(next.latitude, next.longitude, _tempVecLocalB).multiplyScalar(r1);
  _tempVecWorldB.copy(_tempVecLocalB).applyMatrix4(earthMatrixWorld);
  _tempNdcB.copy(_tempVecWorldB).project(camera);

  const screenPosNext = new THREE.Vector2(((1 + _tempNdcB.x) * viewportWidth) / 2, ((1 - _tempNdcB.y) * viewportHeight) / 2);
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
  const c = 2 * Math.atan2(Math.sqrt(Math.max(0, Math.min(1, a))), Math.sqrt(Math.max(0, Math.min(1, 1 - a))));

  return (EARTH_RADIUS_METERS / 1000) * c;
}

export interface UnifiedOverlaySizes {
  aircraftTierB: number;
  aircraftTierA: number;
  aircraftSelected: number;
  observerCore: number;
  observerPulseMin: number;
  observerPulseMax: number;
  observerCoordFontPx: number;
  observerCoordVisible: boolean;
}

/**
 * Unified responsive zoom-aware screen-space pixel sizing for all overlays.
 * Derived with continuous smoothstep / lerp transitions across camera distance.
 * Eliminates popping while preventing microscopic contacts or giant stickers.
 */
export function getUnifiedOverlaySizes(cameraDistance: number): UnifiedOverlaySizes {
  let aircraftTierB: number;
  let aircraftTierA: number;
  let aircraftSelected: number;
  let observerCore: number;
  let observerCoordFontPx: number;
  let observerCoordVisible: boolean;

  if (cameraDistance <= 5.5) {
    // Close View
    const t = THREE.MathUtils.clamp((5.5 - cameraDistance) / 1.5, 0, 1);
    aircraftTierB = THREE.MathUtils.lerp(12.0, 15.0, t);
    aircraftTierA = THREE.MathUtils.lerp(3.0, 3.8, t);
    aircraftSelected = THREE.MathUtils.lerp(16.0, 18.0, t);
    observerCore = THREE.MathUtils.lerp(9.0, 11.0, t);
    observerCoordFontPx = THREE.MathUtils.lerp(11.0, 12.5, t);
    observerCoordVisible = true;
  } else if (cameraDistance <= 9.0) {
    // Regional View (e.g. Spain/France, India/Bangladesh)
    const t = THREE.MathUtils.clamp((9.0 - cameraDistance) / 3.5, 0, 1);
    aircraftTierB = THREE.MathUtils.lerp(9.0, 12.0, t);
    aircraftTierA = THREE.MathUtils.lerp(2.8, 3.2, t);
    aircraftSelected = THREE.MathUtils.lerp(14.0, 16.0, t);
    observerCore = THREE.MathUtils.lerp(7.0, 9.0, t);
    observerCoordFontPx = THREE.MathUtils.lerp(10.0, 11.0, t);
    observerCoordVisible = true;
  } else if (cameraDistance <= 16.0) {
    // Continental View
    const t = THREE.MathUtils.clamp((16.0 - cameraDistance) / 7.0, 0, 1);
    aircraftTierB = THREE.MathUtils.lerp(7.0, 9.0, t);
    aircraftTierA = THREE.MathUtils.lerp(2.5, 2.8, t);
    aircraftSelected = THREE.MathUtils.lerp(12.0, 14.0, t);
    observerCore = THREE.MathUtils.lerp(6.0, 7.0, t);
    observerCoordFontPx = THREE.MathUtils.lerp(9.0, 10.0, t);
    observerCoordVisible = true;
  } else {
    // Global View
    const t = THREE.MathUtils.clamp((cameraDistance - 16.0) / 14.0, 0, 1);
    aircraftTierB = THREE.MathUtils.lerp(7.0, 5.5, t);
    aircraftTierA = THREE.MathUtils.lerp(2.5, 2.0, t);
    aircraftSelected = THREE.MathUtils.lerp(12.0, 10.0, t);
    observerCore = THREE.MathUtils.lerp(6.0, 5.0, t);
    observerCoordFontPx = 9.0;
    observerCoordVisible = false; // Hidden at far global unless recently located
  }

  const observerPulseMin = observerCore * 1.8;
  const observerPulseMax = observerCore * 2.3;

  return {
    aircraftTierB,
    aircraftTierA,
    aircraftSelected,
    observerCore,
    observerPulseMin,
    observerPulseMax,
    observerCoordFontPx,
    observerCoordVisible,
  };
}

/**
 * Backward compatibility alias for aircraft pixel sizes.
 */
export function getTargetAircraftPixelSizes(cameraDistance: number): {
  tierB: number;
  tierA: number;
  selected: number;
} {
  const sizes = getUnifiedOverlaySizes(cameraDistance);
  return {
    tierB: sizes.aircraftTierB,
    tierA: sizes.aircraftTierA,
    selected: sizes.aircraftSelected,
  };
}

/**
 * Calculates adaptive visual clock rate and rate damping as lead approaches divergence limit.
 * 
 * Target visual clock rate by zoom:
 * - GLOBAL (> 16.0 Earth radii): ~3.5 - 5.0x (subtle, graceful drift ~0.25-0.45 px/s)
 * - CONTINENTAL (9.0 - 16.0): ~2.0 - 3.2x
 * - REGIONAL (5.5 - 9.0): ~1.4 - 2.0x
 * - CLOSE (<= 5.5): ~1.0 - 1.3x
 * - TRACKED / ON GROUND: strictly 1.0x
 */
export function calculateVisualClockRate(
  speedMps: number,
  cameraDistance: number,
  isSelected: boolean,
  isTracked: boolean,
  onGround: boolean,
  confidence: number,
  currentLeadSeconds: number
): { effectiveRate: number; targetRate: number; maxLeadKm: number; maxLeadSec: number } {
  if (onGround || speedMps < 2.5 || isTracked || confidence <= 0) {
    return { effectiveRate: 1.0, targetRate: 1.0, maxLeadKm: 0.5, maxLeadSec: 0 };
  }

  // 1. Target visual clock rate based on zoom
  let targetRate = 1.0;
  let maxLeadKm = 15.0;

  if (cameraDistance <= 5.5) {
    // Close / Airport scale
    const t = THREE.MathUtils.clamp((cameraDistance - 4.5) / 1.0, 0, 1);
    targetRate = THREE.MathUtils.lerp(1.0, 1.25, t);
    maxLeadKm = THREE.MathUtils.lerp(3.0, 6.0, t);
  } else if (cameraDistance <= 9.0) {
    // Regional scale (Spain / France)
    const t = THREE.MathUtils.clamp((cameraDistance - 5.5) / 3.5, 0, 1);
    targetRate = THREE.MathUtils.lerp(1.35, 2.0, t);
    maxLeadKm = THREE.MathUtils.lerp(6.0, 16.0, t);
  } else if (cameraDistance <= 16.0) {
    // Continental scale
    const t = THREE.MathUtils.clamp((cameraDistance - 9.0) / 7.0, 0, 1);
    targetRate = THREE.MathUtils.lerp(2.0, 3.4, t);
    maxLeadKm = THREE.MathUtils.lerp(16.0, 28.0, t);
  } else {
    // Global scale
    const t = THREE.MathUtils.clamp((cameraDistance - 16.0) / 12.0, 0, 1);
    targetRate = THREE.MathUtils.lerp(3.4, 4.8, t);
    maxLeadKm = THREE.MathUtils.lerp(28.0, 38.0, t);
  }

  // Selected aircraft: tighter lead limit but still maintains gentle motion
  if (isSelected) {
    maxLeadKm = Math.min(maxLeadKm, 10.0);
    targetRate = 1.0 + (targetRate - 1.0) * 0.5;
  }

  // 2. Maximum allowed lead in seconds
  const maxLeadSec = (maxLeadKm * 1000) / Math.max(10, speedMps);

  // 3. Smooth Damping as current lead approaches maxLeadSec
  const leadRatio = currentLeadSeconds / Math.max(0.1, maxLeadSec);

  let effectiveRate: number;
  if (leadRatio <= 1.0) {
    // Lead is below limit: rate scales with headroom
    const damping = Math.pow(Math.max(0, 1.0 - leadRatio), 1.4);
    effectiveRate = 1.0 + (targetRate - 1.0) * damping * Math.pow(confidence, 1.2);
  } else {
    // Lead is above limit (e.g. just zoomed in): smoothly decelerate below 1.0x to reconverge
    const overRatio = Math.min(1.5, leadRatio - 1.0);
    effectiveRate = Math.max(0.82, 1.0 - overRatio * 0.45);
  }

  return { effectiveRate, targetRate, maxLeadKm, maxLeadSec };
}

/**
 * Computes progressive extrapolation confidence and opacity for observations over time.
 * 0–40s: full confidence (1.0)
 * 40–90s: progressively reduce visual lead & speed (1.0 -> 0.35)
 * 90–120s: approach physical-only extrapolation and fade (0.35 -> 0.0)
 * >=120s: dead / culled
 */
export function getExtrapolationConfidence(observationAgeSec: number): {
  confidence: number;
  opacity: number;
  isDead: boolean;
} {
  if (observationAgeSec <= 40) {
    return { confidence: 1.0, opacity: 1.0, isDead: false };
  }
  if (observationAgeSec <= 90) {
    const t = (observationAgeSec - 40) / 50;
    const smooth = THREE.MathUtils.smoothstep(t, 0, 1);
    const confidence = 1.0 - smooth * 0.65; // 1.0 -> 0.35
    return { confidence, opacity: 1.0, isDead: false };
  }
  if (observationAgeSec <= 120) {
    const t = (observationAgeSec - 90) / 30;
    const smooth = THREE.MathUtils.smoothstep(t, 0, 1);
    const confidence = 0.35 * (1.0 - smooth); // 0.35 -> 0.0
    const opacity = 1.0 - smooth; // 1.0 -> 0.0
    return { confidence, opacity, isDead: false };
  }
  return { confidence: 0.0, opacity: 0.0, isDead: true };
}

/**
 * Interpolates heading/trueTrack across the shortest angular path with rate limiting.
 */
export function interpolateHeading(
  currentTrackDeg: number,
  targetTrackDeg: number,
  deltaSec: number,
  turnRateDegPerSec: number = 24.0
): number {
  let diff = ((targetTrackDeg - currentTrackDeg + 540) % 360) - 180;
  if (Math.abs(diff) < 0.01) {
    return ((targetTrackDeg % 360) + 360) % 360;
  }

  const maxStep = turnRateDegPerSec * deltaSec;
  const expFactor = 1 - Math.exp(-4.5 * deltaSec);
  const smoothStep = diff * expFactor;
  
  let step: number;
  if (Math.abs(smoothStep) > maxStep) {
    step = Math.sign(diff) * maxStep;
  } else {
    step = smoothStep;
  }

  let next = currentTrackDeg + step;
  return ((next % 360) + 360) % 360;
}

/**
 * Smoothly interpolates a scalar value (e.g. speed, verticalRate, altitude).
 */
export function interpolateScalar(
  current: number,
  target: number,
  deltaSec: number,
  rate: number = 3.0
): number {
  if (Math.abs(target - current) < 1e-4) {
    return target;
  }
  const factor = 1 - Math.exp(-rate * deltaSec);
  return current + (target - current) * factor;
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
 * Divides viewport into a 2D grid and assigns detailed glyphs (Tier B) vs neutral micro-dots (Tier A).
 */
export class SpatialBucketingManager {
  public cellSizePx: number;
  private grid: Map<string, DisplayState[]>;

  constructor(cellSizePx: number = 28) {
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

      // Top item in cell gets Detailed Glyph (Tier B), others become neutral micro-contacts (Tier A)
      for (let rank = 0; rank < cellBucket.length; rank++) {
        const item = cellBucket[rank];
        const isPriority = item.truth.icao24 === (selectedIndex >= 0 ? aircraftList[selectedIndex]?.truth.icao24 : null) || item.truth.icao24 === hoveredIcao;

        if (rank === 0 || isPriority) {
          item.lodTier = 'TIER_B';
          detailedGlyphs++;
        } else {
          item.lodTier = 'TIER_A';
          // If heavily congested cell (>3 items), slightly dim micro marks
          if (rank > 3) {
            item.opacity = Math.min(item.opacity, 0.35);
          }
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
 * Diagnostic Verification Helper for Aircraft Kinematics, Frame-Rate Independence & Time-Anchored Motion
 */
export function verifyMotionMath(): { success: boolean; log: string[] } {
  const log: string[] = [];
  let success = true;

  // Test 1: Analytical Frame-Rate Independence (30 FPS vs 144 FPS)
  const anchorTest: ObservationAnchor = {
    latitude: 28.6139, // Delhi
    longitude: 77.2090,
    altitude: 10000,
    velocity: 245.0,
    trueTrack: 65.0,
    verticalRate: 0,
    positionTime: 1000.0,
    onGround: false,
  };

  // Simulate 30 FPS for 10 seconds
  let pos30 = { latitude: 0, longitude: 0 };
  for (let step = 1; step <= 300; step++) {
    const t = 1000.0 + step * (10.0 / 300);
    const elapsed = t - anchorTest.positionTime;
    pos30 = greatCirclePropagate(anchorTest.latitude, anchorTest.longitude, anchorTest.velocity, anchorTest.trueTrack, elapsed, 1.0);
  }

  // Simulate 144 FPS for 10 seconds
  let pos144 = { latitude: 0, longitude: 0 };
  for (let step = 1; step <= 1440; step++) {
    const t = 1000.0 + step * (10.0 / 1440);
    const elapsed = t - anchorTest.positionTime;
    pos144 = greatCirclePropagate(anchorTest.latitude, anchorTest.longitude, anchorTest.velocity, anchorTest.trueTrack, elapsed, 1.0);
  }

  const fpsDiffKm = greatCircleDistanceKm(pos30.latitude, pos30.longitude, pos144.latitude, pos144.longitude);
  if (fpsDiffKm < 0.0001) {
    log.push(`PASS Frame-rate independence: 30 FPS vs 144 FPS Δ = ${fpsDiffKm.toFixed(6)} km`);
  } else {
    log.push(`FAIL Frame-rate independence: 30 FPS vs 144 FPS Δ = ${fpsDiffKm.toFixed(4)} km`);
    success = false;
  }

  // Test 2: North Propagation (0 deg)
  const north = greatCirclePropagate(0, 0, 1000, 0, 100, 1.0); // 100km North from (0,0)
  const northExpectedLat = (100000 / EARTH_RADIUS_METERS) * RAD2DEG;
  if (Math.abs(north.latitude - northExpectedLat) > 0.001 || Math.abs(north.longitude) > 0.001) {
    log.push(`FAIL North propagation: got lat ${north.latitude.toFixed(4)}, lon ${north.longitude.toFixed(4)}`);
    success = false;
  } else {
    log.push(`PASS North propagation: 100km N -> lat ${north.latitude.toFixed(4)}°`);
  }

  // Test 3: Anti-Meridian Crossing & Longitude Wrapping (-179.9° heading West)
  const west = greatCirclePropagate(0, -179.9, 1000, 270, 100, 1.0);
  if (west.longitude > 0 && west.longitude <= 180) {
    log.push(`PASS Anti-meridian crossing: lon ${west.longitude.toFixed(4)}°`);
  } else {
    log.push(`FAIL Anti-meridian crossing: lon ${west.longitude.toFixed(4)}°`);
    success = false;
  }

  // Test 4: Shortest Heading Path Across 0° Boundary (359° -> 1°)
  const headingStep = interpolateHeading(359, 1, 0.5, 30.0);
  if (headingStep >= 359 || headingStep <= 5) {
    log.push(`PASS Shortest heading path: 359° -> 1° stepped to ${headingStep.toFixed(1)}°`);
  } else {
    log.push(`FAIL Shortest heading path: 359° -> 1° stepped to ${headingStep.toFixed(1)}°`);
    success = false;
  }

  // Test 5: Zero Velocity Remains Stationary
  const stationary = greatCirclePropagate(12.34, 56.78, 0, 90, 1000, 1.0);
  if (stationary.latitude === 12.34 && stationary.longitude === 56.78) {
    log.push(`PASS Stationary check: velocity 0 -> identical coordinates`);
  } else {
    log.push(`FAIL Stationary check`);
    success = false;
  }

  // Test 6: Ground Aircraft Has 1.0x Rate & 0 Visual Lead
  const groundClock = calculateVisualClockRate(15, 20.0, false, false, true, 1.0, 0);
  if (groundClock.effectiveRate === 1.0) {
    log.push(`PASS Ground aircraft clock rate = 1.0x`);
  } else {
    log.push(`FAIL Ground aircraft clock rate = ${groundClock.effectiveRate}`);
    success = false;
  }

  // Test 7: Unified Visual Pixel Sizes at Regional Zoom (Spain/France, India/Bangladesh scale)
  const unifiedRegional = getUnifiedOverlaySizes(7.0);
  if (
    unifiedRegional.aircraftTierB >= 9.0 &&
    unifiedRegional.aircraftTierB <= 12.0 &&
    unifiedRegional.aircraftTierA >= 2.8 &&
    unifiedRegional.aircraftTierA <= 3.5 &&
    unifiedRegional.observerCore >= 7.0 &&
    unifiedRegional.observerCore <= 9.0
  ) {
    log.push(`PASS Unified regional sizes: Aircraft Tier-B ${unifiedRegional.aircraftTierB.toFixed(1)}px, Tier-A ${unifiedRegional.aircraftTierA.toFixed(1)}px, Observer Core ${unifiedRegional.observerCore.toFixed(1)}px`);
  } else {
    log.push(`FAIL Unified regional sizes out of target: ${JSON.stringify(unifiedRegional)}`);
    success = false;
  }

  // Test 8: Stale Data Extrapolation Confidence Profile
  const confFresh = getExtrapolationConfidence(20);
  const confMid = getExtrapolationConfidence(65);
  const confStale = getExtrapolationConfidence(105);
  const confDead = getExtrapolationConfidence(140);
  if (confFresh.confidence === 1.0 && confMid.confidence > 0.3 && confStale.confidence < 0.3 && confDead.isDead) {
    log.push(`PASS Stale decay: fresh ${confFresh.confidence.toFixed(1)} -> mid ${confMid.confidence.toFixed(2)} -> stale ${confStale.confidence.toFixed(2)} -> dead`);
  } else {
    log.push(`FAIL Stale decay: unexpected profile`);
    success = false;
  }

  return { success, log };
}
