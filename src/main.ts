import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as satellite from 'satellite.js';
import coastline from './data/ne_50m_coastline.json';
import borders from './data/ne_50m_admin_0_boundary_lines_land.json';
import disputedBorders from './data/ne_50m_admin_0_boundary_lines_disputed_areas.json';
import {
  createAircraftGlyph,
  createAircraftMarkerGeometry,
  createAircraftMicroGlyphGeometry,
  createSelectionBrackets,
  createSatelliteGlyph,
  createSatelliteGlyphGeometry,
} from './scene/markers';
import {
  greatCirclePropagate,
  geodesicSlerp,
  calculateWorldScreenVelocity,
  calculateVisualClockRate,
  getUnifiedOverlaySizes,
  greatCircleDistanceKm,
  interpolateHeading,
  interpolateScalar,
  getExtrapolationConfidence,
  SpatialBucketingManager,
  LabelCollisionManager,
  verifyMotionMath,
} from './scene/motionEngine';
import type { TruthState, DisplayState, ObservationAnchor } from './scene/motionEngine';
import { COUNTRY_LABELS } from './scene/countryLabels';
import './style.css';
import './status.css';

// Automated Kinematic Verification Check
const verificationResult = verifyMotionMath();
console.log('[VECTOR MOTION ENGINE VERIFICATION]', verificationResult.log.join(' | '));

// DOM Selectors & Scale Constants
const canvas = document.querySelector<HTMLCanvasElement>('#vector-canvas')!;
const labelsContainer = document.querySelector<HTMLElement>('#labels-container')!;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

const earthRadius = 4.0;
const scale = earthRadius / 6371;

/**
 * Calculates exact world scale required to maintain a precise screen-space apparent pixel size
 * for a perspective camera at any given distance.
 */
function getWorldScaleForPixelSize(
  camera: THREE.PerspectiveCamera,
  distance: number,
  desiredPixelSize: number,
  viewportHeight: number
): number {
  const vFovRad = THREE.MathUtils.degToRad(camera.fov);
  const visibleWorldHeightAtDistance = 2 * distance * Math.tan(vFovRad / 2);
  const worldUnitsPerPixel = visibleWorldHeightAtDistance / viewportHeight;
  return desiredPixelSize * worldUnitsPerPixel;
}

// Camera System Architecture & Ownership State
type CameraMode = 'MANUAL' | 'LOCATING' | 'TRACKING';
let cameraMode: CameraMode = 'MANUAL';

interface LocateAnimationState {
  startCamPos: THREE.Vector3;
  targetCamPos: THREE.Vector3;
  startTime: number;
  duration: number;
}
let locateAnim: LocateAnimationState | null = null;
let deviceLat: number | null = null;
let deviceLon: number | null = null;
let observerWorldPos: THREE.Vector3 | null = null;

// THREE.js Core Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.008);

// Camera positioning: Default view occupies ~64% of viewport height at distance ~22.0
const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(13.8, 8.8, 14.8);

// Authoritative Earth Orientation State
interface EarthOrientationState {
  gmstRad: number;
  gmstDeg: number;
  rotAngleDeg: number;
  quaternion: THREE.Quaternion;
}
const currentEarthOrientation: EarthOrientationState = {
  gmstRad: 0,
  gmstDeg: 0,
  rotAngleDeg: 0,
  quaternion: new THREE.Quaternion(),
};

type EarthTimeScale = 1 | 60 | 240;
const SIDEREAL_DAY_MS = 86_164_090.5;
let earthTimeScale: EarthTimeScale = 1;
let earthClockAnchorRealMs = Date.now();
let earthClockAnchorSimulationMs = earthClockAnchorRealMs;
let earthRealtimeReconciliation: { startedAtMs: number; offsetMs: number; durationMs: number } | null = null;

function earthSimulationTimeMs(realUtcMs: number) {
  if (earthRealtimeReconciliation) {
    const progress = THREE.MathUtils.clamp(
      (realUtcMs - earthRealtimeReconciliation.startedAtMs) / earthRealtimeReconciliation.durationMs,
      0,
      1
    );
    const eased = THREE.MathUtils.smoothstep(progress, 0, 1);
    const simulationMs = realUtcMs + earthRealtimeReconciliation.offsetMs * (1 - eased);
    if (progress >= 1) {
      earthRealtimeReconciliation = null;
      earthClockAnchorRealMs = realUtcMs;
      earthClockAnchorSimulationMs = realUtcMs;
      updateEarthRateControl();
    }
    return simulationMs;
  }
  return earthClockAnchorSimulationMs + (realUtcMs - earthClockAnchorRealMs) * earthTimeScale;
}

function updateEarthRateControl() {
  document.querySelectorAll<HTMLButtonElement>('.earth-rate-btn').forEach((button) => {
    const active = Number(button.dataset.earthRate) === earthTimeScale;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const state = $('#earth-rate-state');
  state.textContent = earthRealtimeReconciliation
    ? 'SYNCING'
    : earthTimeScale === 1
      ? 'REALTIME'
      : `VISUAL ×${earthTimeScale}`;
}

function setEarthTimeScale(nextScale: EarthTimeScale) {
  if (nextScale === earthTimeScale && !earthRealtimeReconciliation) return;
  const realUtcMs = Date.now();
  const currentSimulationMs = earthSimulationTimeMs(realUtcMs);
  earthTimeScale = nextScale;

  if (nextScale === 1) {
    const realGmst = satellite.gstime(new Date(realUtcMs));
    const simulationGmst = satellite.gstime(new Date(currentSimulationMs));
    const shortestAngle = Math.atan2(
      Math.sin(simulationGmst - realGmst),
      Math.cos(simulationGmst - realGmst)
    );
    earthRealtimeReconciliation = {
      startedAtMs: realUtcMs,
      offsetMs: (shortestAngle / (Math.PI * 2)) * SIDEREAL_DAY_MS,
      durationMs: 1200,
    };
  } else {
    earthRealtimeReconciliation = null;
    earthClockAnchorRealMs = realUtcMs;
    earthClockAnchorSimulationMs = currentSimulationMs;
  }
  updateEarthRateControl();
}

function updateEarthOrientation(date: Date) {
  const gmst = satellite.gstime(date);
  // `earth` is the only Earth-fixed transform.  Nothing else writes this
  // rotation: geography, observer and aircraft inherit it exactly once.
  earth.rotation.set(0, gmst, 0);
  earth.updateMatrixWorld(true);

  const rotAngleDeg = THREE.MathUtils.radToDeg(gmst % (Math.PI * 2));
  currentEarthOrientation.gmstRad = gmst;
  currentEarthOrientation.gmstDeg = THREE.MathUtils.radToDeg(gmst);
  currentEarthOrientation.rotAngleDeg = rotAngleDeg < 0 ? rotAngleDeg + 360 : rotAngleDeg;
  currentEarthOrientation.quaternion.copy(earth.quaternion);
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setAnimationLoop(render);

// OrbitControls setup: minDistance = 4.6 allows regional/local zoom down to ~950 km altitude!
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 4.6;
controls.maxDistance = 38.0;
controls.target.set(0, 0, 0);

/**
 * Smoothly zoom-adaptive OrbitControls sensitivity and damping.
 * Derives rotateSpeed and dampingFactor from camera distance / altitude above Earth.
 * Targets:
 * - GLOBAL (d in [18.0, 38.0]): rotateSpeed 0.72 - 0.88, dampingFactor 0.06
 * - CONTINENTAL (d in [9.5, 18.0]): rotateSpeed 0.45 - 0.72, dampingFactor 0.068 - 0.06
 * - REGIONAL (d in [6.0, 9.5]): rotateSpeed 0.22 - 0.45, dampingFactor 0.08 - 0.068
 * - CLOSE (d in [4.6, 6.0]): rotateSpeed 0.10 - 0.22, dampingFactor 0.10 - 0.08 (crisp stopping without overshoot)
 */
function computeAdaptiveControlsSensitivity(cameraDist: number): { rotateSpeed: number; dampingFactor: number } {
  const d = THREE.MathUtils.clamp(cameraDist, 4.6, 38.0);
  let rotateSpeed: number;
  let dampingFactor: number;

  if (d <= 6.0) {
    const t = THREE.MathUtils.smoothstep(d, 4.6, 6.0);
    rotateSpeed = THREE.MathUtils.lerp(0.10, 0.22, t);
    dampingFactor = THREE.MathUtils.lerp(0.10, 0.08, t);
  } else if (d <= 9.5) {
    const t = THREE.MathUtils.smoothstep(d, 6.0, 9.5);
    rotateSpeed = THREE.MathUtils.lerp(0.22, 0.45, t);
    dampingFactor = THREE.MathUtils.lerp(0.08, 0.068, t);
  } else if (d <= 18.0) {
    const t = THREE.MathUtils.smoothstep(d, 9.5, 18.0);
    rotateSpeed = THREE.MathUtils.lerp(0.45, 0.72, t);
    dampingFactor = THREE.MathUtils.lerp(0.068, 0.06, t);
  } else {
    const t = THREE.MathUtils.smoothstep(d, 18.0, 38.0);
    rotateSpeed = THREE.MathUtils.lerp(0.72, 0.88, t);
    dampingFactor = 0.06;
  }

  return { rotateSpeed, dampingFactor };
}

// Pointer Interaction Tracking (Distinguishes clicks from camera orbit drags)
let pointerDownX = 0;
let pointerDownY = 0;

function setManualCameraMode() {
  if (cameraMode !== 'MANUAL') {
    cameraMode = 'MANUAL';
    locateAnim = null;
    isTrackingAircraft = false;
    controls.target.set(0, 0, 0);
    controls.enabled = true;
  }
}
canvas.addEventListener('pointerdown', (e) => {
  pointerDownX = e.clientX;
  pointerDownY = e.clientY;
  setManualCameraMode();
});
canvas.addEventListener('wheel', setManualCameraMode, { passive: true });
canvas.addEventListener('touchstart', (e) => {
  if (e.touches[0]) {
    pointerDownX = e.touches[0].clientX;
    pointerDownY = e.touches[0].clientY;
  }
  setManualCameraMode();
}, { passive: true });

// Sparse Physical Starfield
const starCount = 1000;
const starGeometry = new THREE.BufferGeometry();
const starPositions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const r = 45 + Math.random() * 45;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  starPositions[i * 3 + 2] = r * Math.cos(phi);
}
starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMaterial = new THREE.PointsMaterial({
  color: 0xa8c4d4,
  size: 0.035,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
});
scene.add(new THREE.Points(starGeometry, starMaterial));

// Axial Tilt & Frame Hierarchy
const obliquity = THREE.MathUtils.degToRad(23.439);
const equatorialFrame = new THREE.Group();
equatorialFrame.rotation.z = -obliquity;
scene.add(equatorialFrame);

const earth = new THREE.Group();
equatorialFrame.add(earth);

// Refined Earth Core Sphere Shader (Uniform, subtle atmosphere limb)
const globeMaterial = new THREE.ShaderMaterial({
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vWorldPosition;
    void main() {
      vNormal = normalize(mat3(modelMatrix) * normal);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPosition = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    varying vec3 vNormal;
    varying vec3 vWorldPosition;
    uniform vec3 uSunDirection;
    void main() {
      vec3 normal = normalize(vNormal);
      vec3 sunDir = normalize(uSunDirection);
      vec3 viewDir = normalize(cameraPosition - vWorldPosition);

      float NdotL = max(0.0, dot(normal, sunDir));
      float dayFactor = smoothstep(-0.25, 0.30, dot(normal, sunDir));

      vec3 deepOcean = vec3(0.010, 0.028, 0.050);
      vec3 landGlow = vec3(0.032, 0.075, 0.110);
      vec3 baseColor = mix(deepOcean, landGlow, 0.22);

      vec3 dayColor = baseColor * (0.50 + 0.50 * NdotL);
      vec3 nightColor = deepOcean * 0.12;
      vec3 color = mix(nightColor, dayColor, dayFactor);

      // Subtle atmosphere limb
      float fresnel = pow(1.0 - max(0.0, dot(viewDir, normal)), 4.5);
      vec3 atmosphereGlow = vec3(0.25, 0.48, 0.65) * fresnel * (0.25 + 0.75 * dayFactor) * 0.28;

      gl_FragColor = vec4(color + atmosphereGlow, 1.0);
    }
  `,
  uniforms: {
    uSunDirection: { value: new THREE.Vector3(1, 0.3, 1).normalize() },
  },
});

const globeMesh = new THREE.Mesh(new THREE.SphereGeometry(earthRadius, 64, 64), globeMaterial);
earth.add(globeMesh);

// Geographic Vector Line Visual Hierarchy (Coastlines > Grid > Borders)
function latLonToVector3(latDeg: number, lonDeg: number, radius = earthRadius, target = new THREE.Vector3()) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const lon = THREE.MathUtils.degToRad(lonDeg);
  return target.set(
    radius * Math.cos(lat) * Math.sin(lon),
    radius * Math.sin(lat),
    radius * Math.cos(lat) * Math.cos(lon)
  );
}

// 1. Clear, Crisp Coastlines
const coastlineMaterial = new THREE.LineBasicMaterial({ color: 0x78aabd, transparent: true, opacity: 0.56, depthWrite: false });

// 2. Thinner, Dimmer Country Borders
const borderMaterial = new THREE.LineBasicMaterial({ color: 0x4b7284, transparent: true, opacity: 0.30, depthWrite: false });

function addGeoFeatures(geoJson: any, mat: THREE.LineBasicMaterial) {
  const points: number[] = [];
  for (const feature of geoJson.features) {
    const geom = feature.geometry;
    const coords = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
    for (const poly of coords) {
      const line = geom.type === 'MultiPolygon' ? poly[0] : poly;
      for (let i = 0; i < line.length - 1; i++) {
        const p1 = latLonToVector3(line[i][1], line[i][0], earthRadius + 0.003);
        const p2 = latLonToVector3(line[i + 1][1], line[i + 1][0], earthRadius + 0.003);
        points.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  earth.add(new THREE.LineSegments(geometry, mat));
}

addGeoFeatures(coastline, coastlineMaterial);
addGeoFeatures(borders, borderMaterial);
addGeoFeatures(disputedBorders, borderMaterial);

// 3. Subtle Latitude & Longitude Wireframe Grid Lines
const gridGroup = new THREE.Group();
const gridMat = new THREE.LineBasicMaterial({ color: 0x2f4c5b, transparent: true, opacity: 0.15, depthWrite: false });

for (let lat = -60; lat <= 60; lat += 30) {
  const pts: THREE.Vector3[] = [];
  for (let lon = 0; lon <= 360; lon += 6) {
    pts.push(latLonToVector3(lat, lon, earthRadius + 0.002));
  }
  gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
}

for (let lon = 0; lon < 360; lon += 30) {
  const pts: THREE.Vector3[] = [];
  for (let lat = -90; lat <= 90; lat += 6) {
    pts.push(latLonToVector3(lat, lon, earthRadius + 0.002));
  }
  gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
}
earth.add(gridGroup);

// Earth-fixed reference lines provide a quiet visual comparison against the
// inertial satellite field without altering sidereal truth.
const earthReferenceMat = new THREE.LineBasicMaterial({ color: 0x6d9caf, transparent: true, opacity: 0.28, depthWrite: false });
function earthReferenceCircle(latitude: number, longitude: number, isMeridian: boolean) {
  const points: THREE.Vector3[] = [];
  for (let step = 0; step <= 120; step++) {
    const value = -180 + step * 3;
    points.push(isMeridian
      ? latLonToVector3(value / 2, longitude, earthRadius + 0.005)
      : latLonToVector3(latitude, value, earthRadius + 0.005));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), earthReferenceMat);
}
earth.add(earthReferenceCircle(0, 0, false));
earth.add(earthReferenceCircle(0, 0, true));

// Restrained Astronomical Reference Instrument
const instrumentGroup = new THREE.Group();

// 1. Hairline Polar Rotation Axis with Clean Terminal Ticks
const axisSegments = [
  // Rotational axis shaft through Earth's geographic poles (Earth radius = 4.0, extent = 4.40)
  0, -4.40, 0,  0, 4.40, 0,
  // North pole terminal tick
  -0.03, 4.40, 0,  0.03, 4.40, 0,
  // South pole terminal tick
  -0.03, -4.40, 0,  0.03, -4.40, 0,
];
const axisGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(axisSegments, 3));
const axisMat = new THREE.LineBasicMaterial({ color: 0x7eb0c8, transparent: true, opacity: 0.24, depthWrite: false });
const axisLine = new THREE.LineSegments(axisGeo, axisMat);
instrumentGroup.add(axisLine);

// 2. Subtle Ecliptic Reference Plane Ring (Inertial Reference Ring)
const eclipticRingPts: THREE.Vector3[] = [];
for (let i = 0; i <= 128; i++) {
  const theta = (i / 128) * Math.PI * 2;
  const r = 4.28;
  const v = new THREE.Vector3(r * Math.cos(theta), 0, r * Math.sin(theta));
  v.applyAxisAngle(new THREE.Vector3(0, 0, 1), obliquity);
  eclipticRingPts.push(v);
}
const eclipticRingGeo = new THREE.BufferGeometry().setFromPoints(eclipticRingPts);
const eclipticRingMat = new THREE.LineDashedMaterial({
  color: 0x3d6377,
  transparent: true,
  opacity: 0.08,
  dashSize: 0.06,
  gapSize: 0.08,
  depthWrite: false,
});
const eclipticRingLine = new THREE.Line(eclipticRingGeo, eclipticRingMat);
eclipticRingLine.computeLineDistances();
instrumentGroup.add(eclipticRingLine);

// 3. Short Local Ecliptic Normal Guide & 23.44° Axial Tilt Arc
const eclipticNorm = new THREE.Vector3(-Math.sin(obliquity), Math.cos(obliquity), 0).normalize();
const eclNormStart = eclipticNorm.clone().multiplyScalar(4.12);
const eclNormEnd = eclipticNorm.clone().multiplyScalar(4.40);
const eclPerp = new THREE.Vector3(eclipticNorm.y, -eclipticNorm.x, 0).multiplyScalar(0.025);
const eclipticGuidePts = [
  eclNormStart.x, eclNormStart.y, eclNormStart.z,  eclNormEnd.x, eclNormEnd.y, eclNormEnd.z,
  eclNormEnd.x - eclPerp.x, eclNormEnd.y - eclPerp.y, eclNormEnd.z,  eclNormEnd.x + eclPerp.x, eclNormEnd.y + eclPerp.y, eclNormEnd.z,
];
const eclipticGuideGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(eclipticGuidePts, 3));
const eclipticNormalMat = new THREE.LineBasicMaterial({ color: 0x487085, transparent: true, opacity: 0.20, depthWrite: false });
const eclipticNormalLine = new THREE.LineSegments(eclipticGuideGeo, eclipticNormalMat);
instrumentGroup.add(eclipticNormalLine);

// Precision 23.44° Axial Tilt Arc
const tiltArcPts: THREE.Vector3[] = [];
const tiltRadius = 4.28;
for (let i = 0; i <= 24; i++) {
  const angle = (i / 24) * obliquity;
  tiltArcPts.push(new THREE.Vector3(-tiltRadius * Math.sin(angle), tiltRadius * Math.cos(angle), 0));
}
const tiltGeo = new THREE.BufferGeometry().setFromPoints(tiltArcPts);
const tiltMat = new THREE.LineBasicMaterial({ color: 0x7cb2cc, transparent: true, opacity: 0.28, depthWrite: false });
const tiltArcLine = new THREE.Line(tiltGeo, tiltMat);
instrumentGroup.add(tiltArcLine);

equatorialFrame.add(instrumentGroup);

// Satellite Layer State & Instanced Mesh Mappings
type OmmElement = Parameters<typeof satellite.json2satrec>[0];
type Orbiting = { name: string; objectId: string; satrec: satellite.SatRec; norad: string; epoch: Date };
let orbiters: Orbiting[] = [];
let selectedSatelliteIndex = -1;
// Selection is identity-based; render instance slots are rebuilt every frame.
let selectedSatelliteNorad: string | null = null;
let showSatellites = true;
let catalogCount = 0;
let elementsRetrievedAt = 0;

const isMobile = window.matchMedia('(max-width: 680px)').matches;
const maxSatellites = isMobile ? 1800 : 6000;

// Explicit Instance-to-Orbiter Mapping Array for 100% Precise Picking
const satInstanceToOrbiterIndex: number[] = [];
type ScreenCandidate = { index: number; id: string; x: number; y: number; distancePx: number };
let satelliteScreenCandidates: ScreenCandidate[] = [];

// Visible Satellite Instanced Glyph Mesh
const satGlyphsMesh = new THREE.InstancedMesh(
  createSatelliteGlyphGeometry(),
  new THREE.MeshBasicMaterial({ color: 0x79c6de, side: THREE.DoubleSide, transparent: true, opacity: 0.20, depthWrite: false }),
  maxSatellites
);
satGlyphsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
satGlyphsMesh.count = 0;
satGlyphsMesh.frustumCulled = false;
equatorialFrame.add(satGlyphsMesh);

const satelliteGlyphs = new THREE.Group();
equatorialFrame.add(satelliteGlyphs);

const selectedSatGlyph = createSatelliteGlyph();
selectedSatGlyph.scale.setScalar(0.40);
selectedSatGlyph.visible = false;
satelliteGlyphs.add(selectedSatGlyph);

// Compact four-corner selection brackets; no circular targeting treatment.
const selectedSatHalo = createSelectionBrackets();
selectedSatHalo.visible = false;
equatorialFrame.add(selectedSatHalo);

let orbitLine: THREE.Group | undefined;

function clearOrbit() {
  if (!orbitLine) return;
  orbitLine.traverse((child) => {
    if (child instanceof THREE.Line || child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else if (child.material) {
        child.material.dispose();
      }
    }
  });
  orbitLine.removeFromParent();
  orbitLine = undefined;
}

// Aircraft Layer State, Instanced Meshes & Explicit Picking Mappings
let showAircraft = true;
const maxAircraft = isMobile ? 500 : 1600;
let aircraftApiRawCount = 0;
type AircraftProvider = 'adsb.lol' | 'adsb.fi' | 'Airplanes.live' | 'OpenSky';
let aircraftProvider: AircraftProvider | null = null;

const aircraftProviderDetails: Record<AircraftProvider, { label: string; credit: string; url: string }> = {
  'adsb.lol': { label: 'ADSB.LOL', credit: 'adsb.lol · ODbL 1.0', url: 'https://adsb.lol/' },
  'adsb.fi': { label: 'ADSB.FI', credit: 'adsb.fi', url: 'https://adsb.fi/' },
  'Airplanes.live': { label: 'AIRPLANES.LIVE', credit: 'Airplanes.live', url: 'https://airplanes.live/' },
  OpenSky: { label: 'OPENSKY NETWORK', credit: 'OpenSky Network', url: 'https://opensky-network.org/' },
};

function aircraftProviderLabel() {
  return aircraftProvider ? aircraftProviderDetails[aircraftProvider].label : 'PUBLIC ADS-B';
}

function updateAircraftAttribution() {
  const credit = document.querySelector<HTMLAnchorElement>('#aircraft-source-credit');
  if (!credit || !aircraftProvider) return;
  const details = aircraftProviderDetails[aircraftProvider];
  credit.textContent = details.credit;
  credit.href = details.url;
}

const tierBInstanceToAircraftIndex: number[] = [];
const tierAInstanceToAircraftIndex: number[] = [];

// Visible Detailed Silhouette Aircraft Mesh (Tier B)
const aircraftMarkersTierB = new THREE.InstancedMesh(
  createAircraftMarkerGeometry(),
  new THREE.MeshBasicMaterial({ color: 0xe6f7fc, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }),
  maxAircraft
);
aircraftMarkersTierB.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
aircraftMarkersTierB.count = 0;
aircraftMarkersTierB.frustumCulled = false;
earth.add(aircraftMarkersTierB);

// Visible Micro Directional Wedge Aircraft Mesh (Tier A)
const aircraftMarkersTierA = new THREE.InstancedMesh(
  createAircraftMicroGlyphGeometry(),
  new THREE.MeshBasicMaterial({ color: 0x86abbc, side: THREE.DoubleSide, transparent: true, opacity: 0.48, depthWrite: false }),
  maxAircraft
);
aircraftMarkersTierA.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
aircraftMarkersTierA.count = 0;
aircraftMarkersTierA.frustumCulled = false;
earth.add(aircraftMarkersTierA);

// Refined trajectory history: fading technical points toward the aircraft.
const maxTrailSegments = maxAircraft * 45;
const aircraftTrailPositions = new Float32Array(maxTrailSegments * 6);
const aircraftTrailColors = new Float32Array(maxTrailSegments * 6);
const aircraftTrailGeometry = new THREE.BufferGeometry();
aircraftTrailGeometry.setAttribute('position', new THREE.BufferAttribute(aircraftTrailPositions, 3).setUsage(THREE.DynamicDrawUsage));
aircraftTrailGeometry.setAttribute('color', new THREE.BufferAttribute(aircraftTrailColors, 3).setUsage(THREE.DynamicDrawUsage));
aircraftTrailGeometry.setDrawRange(0, 0);

const aircraftTrails = new THREE.Points(
  aircraftTrailGeometry,
  new THREE.PointsMaterial({ vertexColors: true, transparent: true, opacity: 0.68, depthWrite: false, depthTest: true, size: 1.45, sizeAttenuation: false })
);
aircraftTrails.frustumCulled = false;
aircraftTrails.renderOrder = 1;
earth.add(aircraftTrails);

// Compact Aircraft Selection Overlays
const selectedAircraftGlyph = createAircraftGlyph();
selectedAircraftGlyph.visible = false;
earth.add(selectedAircraftGlyph);

const selectedAircraftHalo = createSelectionBrackets();
selectedAircraftHalo.visible = false;
earth.add(selectedAircraftHalo);

// Core Aircraft Motion State Store (Identity-based Map) & Derived Render Array
const aircraftStore = new Map<string, DisplayState>();
let aircraft: DisplayState[] = [];
let selectedAircraftIndex = -1;
let selectedAircraftIcao: string | null = null;
let isTrackingAircraft = false;
let hoveredIcao: string | null = null;
let hoveredSatelliteNorad: string | null = null;
let aircraftScreenCandidates: ScreenCandidate[] = [];
type MotionProbe = { id: string; startedAt: number; start: THREE.Vector2; deltaPx: number | null };
let aircraftMotionProbe: MotionProbe | null = null;
let satelliteMotionProbe: MotionProbe | null = null;
let aircraftObservedAt = 0;
let aircraftAvailable = false;

// Geographic Region Tile Cache & Request Queue
interface CachedRegion {
  key: string;
  lat: number;
  lon: number;
  radiusNm: number;
  lastFetchedAt: number;
  status: 'idle' | 'loading' | 'success' | 'error';
  aircraftCount: number;
}

const REGION_CACHE_TTL_MS = 28_000;
const REGION_RADIUS_NM = 250;
const MIN_REQUEST_INTERVAL_MS = 1100;
const MAX_ENQUEUED_REGIONS = 8;

const activeRegionsMap = new Map<string, CachedRegion>();
const requestQueue: string[] = [];
let isQueueProcessing = false;
let lastRequestTimeMs = 0;
let lastCheckedCamPos = { lat: 0, lon: 0, dist: 0 };
let cameraMoveDebounceTimer: number | null = null;

// Spatial & Label Managers
const spatialBucketingManager = new SpatialBucketingManager(24);
const labelCollisionManager = new LabelCollisionManager();
const domLabelPool: HTMLElement[] = [];

// Geolocation Observer State (Tiny Precise Instrument Light)
let observerGroup: THREE.Group | undefined;
let observerCoreMaterial: THREE.MeshBasicMaterial | undefined;
let observerPulse: THREE.Mesh | undefined;
let observerPulseMaterial: THREE.MeshBasicMaterial | undefined;
let observerPulseStartedAt = 0;
let observerLabelExpiresAt = 0;

// Scratch Math Matrices & Vectors
const aircraftNorthTemp = new THREE.Vector3();
const aircraftEastTemp = new THREE.Vector3();
const aircraftForwardTemp = new THREE.Vector3();
const aircraftRightTemp = new THREE.Vector3();
const aircraftBasisTemp = new THREE.Matrix4();
const aircraftMatrixTemp = new THREE.Matrix4();
const aircraftQuaternionTemp = new THREE.Quaternion();
const aircraftScaleTemp = new THREE.Vector3();
const aircraftColorTemp = new THREE.Color();
const aircraftLatestTemp = new THREE.Vector3();

type LandmarkProbe = { label: string; lat: number; lon: number; screen: THREE.Vector2; start: THREE.Vector2; deltaPx: number; visible: boolean };
const landmarkProbes: LandmarkProbe[] = [
  { label: 'GREENWICH', lat: 51.4779, lon: 0, screen: new THREE.Vector2(), start: new THREE.Vector2(), deltaPx: 0, visible: false },
  { label: 'INDIA', lat: 22.5726, lon: 88.3639, screen: new THREE.Vector2(), start: new THREE.Vector2(), deltaPx: 0, visible: false },
  { label: 'JAPAN', lat: 35.6762, lon: 139.6503, screen: new THREE.Vector2(), start: new THREE.Vector2(), deltaPx: 0, visible: false },
  { label: 'NORTH AMERICA', lat: 39.8283, lon: -98.5795, screen: new THREE.Vector2(), start: new THREE.Vector2(), deltaPx: 0, visible: false },
];
let landmarkProbeStartedAt = 0;
let gmstProbeStartDeg = 0;
let gmstDeltaDeg = 0;
let landmarkProbeElapsedSec = 0;
let landmarkProbeWarmupFrames = 0;

const satMatrixTemp = new THREE.Matrix4();
const satPosTemp = new THREE.Vector3();
const satLookTemp = new THREE.Object3D();

// Helper Utilities
const eciVector = (value: satellite.EciVec3<number>) => new THREE.Vector3(value.y * scale, value.z * scale, value.x * scale);
const altitudeForTruth = (item: TruthState) => item.geometricAltitude ?? item.barometricAltitude;
const formatAge = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
};
const utc = (date: Date) => `${date.toISOString().slice(11, 19)} UTC`;
const escapeHtml = (value: unknown) =>
  String(value ?? '—').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));

function aircraftOrientation(position: THREE.Vector3, heading: number | null, size: number, target: THREE.Matrix4) {
  const normal = aircraftLatestTemp.copy(position).normalize();
  const clampedY = THREE.MathUtils.clamp(normal.y, -1, 1);
  const latitude = Math.asin(clampedY);
  const longitude = Math.atan2(normal.x, normal.z);

  if (Math.abs(clampedY) > 0.9995) {
    // Polar region stability: avoid zero-length vector in tangent frame
    aircraftEastTemp.set(1, 0, 0).cross(normal).normalize();
    if (aircraftEastTemp.lengthSq() < 0.001) {
      aircraftEastTemp.set(0, 0, 1).cross(normal).normalize();
    }
    aircraftNorthTemp.crossVectors(normal, aircraftEastTemp).normalize();
  } else {
    aircraftNorthTemp
      .set(-Math.sin(latitude) * Math.sin(longitude), Math.cos(latitude), -Math.sin(latitude) * Math.cos(longitude))
      .normalize();
    aircraftEastTemp.set(Math.cos(longitude), 0, -Math.sin(longitude)).normalize();
  }

  const bearing = THREE.MathUtils.degToRad(heading ?? 0);
  aircraftForwardTemp
    .copy(aircraftNorthTemp)
    .multiplyScalar(Math.cos(bearing))
    .addScaledVector(aircraftEastTemp, Math.sin(bearing))
    .normalize();
  aircraftRightTemp.crossVectors(aircraftForwardTemp, normal).normalize();

  aircraftBasisTemp.makeBasis(aircraftRightTemp, aircraftForwardTemp, normal);
  aircraftQuaternionTemp.setFromRotationMatrix(aircraftBasisTemp);
  aircraftScaleTemp.setScalar(size);

  return target.compose(position, aircraftQuaternionTemp, aircraftScaleTemp);
}

function getSubCameraCoordinates(): { lat: number; lon: number; dist: number } {
  earth.updateWorldMatrix(true, false);
  const local = earth.worldToLocal(camera.position.clone()).normalize();
  const clampedY = THREE.MathUtils.clamp(local.y, -1, 1);
  const lat = THREE.MathUtils.radToDeg(Math.asin(clampedY));
  const lon = THREE.MathUtils.radToDeg(Math.atan2(local.x, local.z));
  const dist = camera.position.distanceTo(controls.target);
  return { lat, lon, dist };
}

function discoverVisibleRegions(): Array<{ key: string; lat: number; lon: number; distDeg: number }> {
  const { lat: centerLat, lon: centerLon, dist } = getSubCameraCoordinates();

  const altitude = Math.max(0.6, dist - earthRadius);
  const spanDeg = THREE.MathUtils.clamp(8.0 + (altitude / 10.0) * 45.0, 8.0, 60.0);

  const snappedCenterLat = Math.max(-80, Math.min(80, Math.round(centerLat / 5) * 5));
  const snappedCenterLon = Math.max(-175, Math.min(175, Math.round(centerLon / 5) * 5));

  const latStep = 5;
  const lonStep = 5;
  const latRange = Math.ceil(spanDeg / latStep) * latStep;
  const lonRange = Math.ceil(spanDeg / lonStep) * lonStep;

  const discovered: Array<{ key: string; lat: number; lon: number; distDeg: number }> = [];
  const seenKeys = new Set<string>();

  for (let dLat = -latRange; dLat <= latRange; dLat += latStep) {
    const lat = Math.max(-80, Math.min(80, snappedCenterLat + dLat));
    for (let dLon = -lonRange; dLon <= lonRange; dLon += lonStep) {
      let lon = snappedCenterLon + dLon;
      while (lon > 180) lon -= 360;
      while (lon < -180) lon += 360;
      lon = Math.max(-175, Math.min(175, Math.round(lon / 5) * 5));

      const key = `${lat}:${lon}:${REGION_RADIUS_NM}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const distDeg = greatCircleDistanceKm(centerLat, centerLon, lat, lon) / 111.12;
      if (distDeg <= spanDeg * 1.25) {
        discovered.push({ key, lat, lon, distDeg });
      }
    }
  }

  discovered.sort((a, b) => a.distDeg - b.distDeg);
  return discovered;
}

function updateAircraftTrails(nowSeconds: number, cameraDistance: number) {
  let segmentCount = 0;
  const maxTrailDurationSec = cameraDistance > 20.0 ? 35 : cameraDistance > 14.0 ? 75 : 160;

  for (let index = 0; index < aircraft.length && segmentCount < maxTrailSegments; index++) {
    const motion = aircraft[index];
    const history = motion.history;
    const isSelected = index === selectedAircraftIndex;
    // Keep trajectories meaningful: only the selected aircraft leaves a trace.
    if (motion.opacity <= 0 || !isSelected) continue;

    // Connect the trail directly to current display position for 0-gap precision
    let prevPos = motion.displayPosition;

    for (let point = history.length - 1; point >= 0 && segmentCount < maxTrailSegments; point--) {
      const histItem = history[point];
      const age = nowSeconds - histItem.time;
      if (age > maxTrailDurationSec) break;

      const life = THREE.MathUtils.clamp(1 - age / maxTrailDurationSec, 0, 1);
      const baseOpacity = cameraDistance > 20.0 ? 0.14 : cameraDistance > 14.0 ? 0.24 : 0.35;
      const brightness = Math.min(0.55, baseOpacity * life * motion.opacity);
      const offset = segmentCount * 6;

      prevPos.toArray(aircraftTrailPositions, offset);
      histItem.pos.toArray(aircraftTrailPositions, offset + 3);

      if (isSelected) {
        const selectedBrightness = 0.16 + life * 0.62;
        aircraftTrailColors.set(
          [selectedBrightness * 0.42, selectedBrightness * 0.84, selectedBrightness,
           selectedBrightness * 0.28, selectedBrightness * 0.66, selectedBrightness * 0.84],
          offset
        );
      } else {
        aircraftTrailColors.set(
          [brightness * 0.25, brightness * 0.55, brightness * 0.70, brightness * 0.40, brightness * 0.75, brightness * 0.90],
          offset
        );
      }
      prevPos = histItem.pos;
      segmentCount++;
    }
  }
  aircraftTrailGeometry.setDrawRange(0, segmentCount * 2);
  aircraftTrailGeometry.attributes.position.needsUpdate = true;
  aircraftTrailGeometry.attributes.color.needsUpdate = true;
}

let lastFrameTimeSec = Date.now() / 1000;

function resolveSelectionIndices() {
  selectedAircraftIndex = selectedAircraftIcao
    ? aircraft.findIndex((item) => item.truth.icao24 === selectedAircraftIcao)
    : -1;
  selectedSatelliteIndex = selectedSatelliteNorad
    ? orbiters.findIndex((item) => item.norad === selectedSatelliteNorad)
    : -1;
}

function projectWorldPosition(world: THREE.Vector3, target = new THREE.Vector2()) {
  const ndc = world.clone().project(camera);
  target.set((ndc.x * 0.5 + 0.5) * window.innerWidth, (-ndc.y * 0.5 + 0.5) * window.innerHeight);
  return { visible: ndc.z >= -1 && ndc.z <= 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1, ndc };
}

/** True when the segment from camera to a point passes through the globe. */
function isBehindEarth(world: THREE.Vector3) {
  const toPoint = world.clone().sub(camera.position);
  const length = toPoint.length();
  if (length <= 0) return true;
  const direction = toPoint.multiplyScalar(1 / length);
  const closestT = THREE.MathUtils.clamp(-camera.position.dot(direction), 0, length);
  return camera.position.clone().addScaledVector(direction, closestT).length() < earthRadius - 0.002;
}

function updateLandmarkProbes(nowSeconds: number) {
  landmarkProbeWarmupFrames++;
  for (const probe of landmarkProbes) {
    const world = latLonToVector3(probe.lat, probe.lon, earthRadius + 0.009).applyMatrix4(earth.matrixWorld);
    const result = projectWorldPosition(world, probe.screen);
    probe.visible = result.visible && !isBehindEarth(world);
    probe.deltaPx = probe.screen.distanceTo(probe.start);
  }
  if (!landmarkProbeStartedAt && landmarkProbeWarmupFrames >= 3) {
    landmarkProbeStartedAt = nowSeconds;
    gmstProbeStartDeg = currentEarthOrientation.rotAngleDeg;
    for (const probe of landmarkProbes) probe.start.copy(probe.screen);
  }
  landmarkProbeElapsedSec = landmarkProbeStartedAt ? nowSeconds - landmarkProbeStartedAt : 0;
  gmstDeltaDeg = THREE.MathUtils.euclideanModulo(currentEarthOrientation.rotAngleDeg - gmstProbeStartDeg, 360);
}

function updateMotionProbes(nowSeconds: number) {
  const update = (probe: MotionProbe | null, candidate: ScreenCandidate | undefined) => {
    if (!candidate) return probe;
    if (!probe || probe.id !== candidate.id || nowSeconds - probe.startedAt > 11) {
      return { id: candidate.id, startedAt: nowSeconds, start: new THREE.Vector2(candidate.x, candidate.y), deltaPx: null };
    }
    if (nowSeconds - probe.startedAt >= 5) probe.deltaPx = probe.start.distanceTo(new THREE.Vector2(candidate.x, candidate.y));
    return probe;
  };
  const air = aircraftScreenCandidates.find((candidate) => (aircraft[candidate.index]?.velocity ?? 0) > 150);
  aircraftMotionProbe = update(aircraftMotionProbe, air);
  satelliteMotionProbe = update(satelliteMotionProbe, satelliteScreenCandidates[0]);
}

function updateAircraftPositions() {
  if (!showAircraft) {
    aircraftMarkersTierB.count = 0;
    aircraftMarkersTierA.count = 0;
    aircraftTrailGeometry.setDrawRange(0, 0);
    return;
  }

  const nowSeconds = Date.now() / 1000;

  // Prune dead aircraft from store (age > 120s from getExtrapolationConfidence)
  const deadIcaos: string[] = [];
  for (const [icao, motion] of aircraftStore) {
    const age = Math.max(0, nowSeconds - motion.anchor.positionTime);
    const conf = getExtrapolationConfidence(age);
    motion.confidence = conf.confidence;
    motion.opacity = conf.opacity;

    if (conf.isDead || motion.opacity <= 0) {
      if (icao !== selectedAircraftIcao || age > 180) {
        deadIcaos.push(icao);
      }
    }
  }
  for (const icao of deadIcaos) {
    aircraftStore.delete(icao);
    if (selectedAircraftIcao === icao) {
      selectedAircraftIcao = null;
      selectedAircraftIndex = -1;
      isTrackingAircraft = false;
      $('#inspector').hidden = true;
      selectedAircraftGlyph.visible = false;
      selectedAircraftHalo.visible = false;
    }
  }

  aircraft = Array.from(aircraftStore.values());
  resolveSelectionIndices();
  const deltaSec = Math.min(0.1, Math.max(0.001, nowSeconds - lastFrameTimeSec));
  lastFrameTimeSec = nowSeconds;

  const cameraDistance = camera.position.distanceTo(controls.target);
  const viewportHeight = window.innerHeight;

  // Unified Responsive Zoom-Aware Screen-Space Sizing
  const overlaySizes = getUnifiedOverlaySizes(cameraDistance);

  let activeMotionMultiplier = 1.0;
  aircraftScreenCandidates = [];

  earth.updateWorldMatrix(true, false);

  for (let index = 0; index < aircraft.length; index++) {
    const motion = aircraft[index];
    const truth = motion.truth;
    const anchor = motion.anchor;
    const age = Math.max(0, nowSeconds - anchor.positionTime);
    const isSelected = index === selectedAircraftIndex;
    const isTracked = isSelected && isTrackingAircraft && cameraMode === 'TRACKING';

    const conf = getExtrapolationConfidence(age);
    motion.confidence = conf.confidence;
    motion.opacity = conf.opacity;

    if (conf.isDead || motion.opacity <= 0) {
      continue;
    }

    // 1. Smoothly converge visual heading, velocity, vertical rate, and altitude toward observed targets
    motion.visualHeading = interpolateHeading(motion.visualHeading, anchor.trueTrack, deltaSec, 20.0);
    motion.visualVelocity = interpolateScalar(motion.visualVelocity, anchor.velocity, deltaSec, 2.5);
    motion.visualVerticalRate = interpolateScalar(motion.visualVerticalRate, anchor.verticalRate, deltaSec, 2.5);
    motion.visualAltitude = interpolateScalar(motion.visualAltitude, anchor.altitude, deltaSec, 2.0);

    // 2. Analytic Physical Prediction (Authoritative physical dead reckoning)
    const physicalProp = greatCirclePropagate(
      anchor.latitude,
      anchor.longitude,
      anchor.velocity,
      anchor.trueTrack,
      age,
      1.0
    );
    const physicalAlt = Math.max(0, anchor.altitude + anchor.verticalRate * age);
    motion.physicalPosition = {
      latitude: physicalProp.latitude,
      longitude: physicalProp.longitude,
      altitude: physicalAlt,
    };

    // 3. World-space screen velocity using authoritative earth.matrixWorld
    const screenMetrics = calculateWorldScreenVelocity(
      camera,
      earth.matrixWorld,
      window.innerWidth,
      window.innerHeight,
      earthRadius,
      scale,
      motion.latitude,
      motion.longitude,
      motion.altitude,
      motion.visualVelocity,
      motion.visualHeading
    );

    motion.realScreenSpeedPxPerSec = screenMetrics.screenSpeedPxPerSec;
    motion.targetScreenSpeedPxSec = 1.3;
    motion.inFrustum = screenMetrics.isInFrustum;
    motion.facingCamera = screenMetrics.isFacingCamera;
    motion.screenPos.copy(screenMetrics.screenPos);

    // 4. Bounded Visual Clock Rate Calculation (dLead/dt = visualRate - 1.0)
    const clockMetrics = calculateVisualClockRate(
      motion.visualVelocity,
      cameraDistance,
      isSelected,
      isTracked,
      anchor.onGround,
      motion.confidence,
      motion.accumulatedVisualLead ?? 0
    );
    motion.visualRate = clockMetrics.effectiveRate;
    
    // Evolve visual lead smoothly; collapses towards 0 as bound or staleness approaches
    const leadDelta = (clockMetrics.effectiveRate - 1.0) * deltaSec;
    motion.accumulatedVisualLead = Math.max(0, Math.min(clockMetrics.maxLeadSec * 1.05, (motion.accumulatedVisualLead ?? 0) + leadDelta));
    motion.visualLeadSeconds = motion.accumulatedVisualLead;

    // 5. Analytic Display Prediction Target
    const displayElapsed = age + motion.visualLeadSeconds;
    const displayTarget = greatCirclePropagate(
      anchor.latitude,
      anchor.longitude,
      motion.visualVelocity,
      motion.visualHeading,
      displayElapsed,
      1.0
    );
    const displayAltTarget = Math.max(0, motion.visualAltitude + motion.visualVerticalRate * displayElapsed);

    // 6. Smooth Geodesic Reconciliation (if blending from a prior observation anchor)
    if (motion.reconciling && motion.reconcileDuration > 0) {
      const elapsedRec = nowSeconds - motion.reconcileStartedAt;
      const progress = elapsedRec / motion.reconcileDuration;
      if (progress < 1.0) {
        const weight = THREE.MathUtils.smoothstep(progress, 0, 1);
        const blended = geodesicSlerp(
          motion.blendFromLat,
          motion.blendFromLon,
          displayTarget.latitude,
          displayTarget.longitude,
          weight
        );
        motion.latitude = blended.latitude;
        motion.longitude = blended.longitude;
        motion.altitude = THREE.MathUtils.lerp(motion.blendFromAlt, displayAltTarget, weight);
      } else {
        motion.reconciling = false;
        motion.latitude = displayTarget.latitude;
        motion.longitude = displayTarget.longitude;
        motion.altitude = displayAltTarget;
      }
    } else {
      motion.latitude = displayTarget.latitude;
      motion.longitude = displayTarget.longitude;
      motion.altitude = displayAltTarget;
    }

    motion.trueTrack = motion.visualHeading;
    motion.velocity = motion.visualVelocity;
    motion.verticalRate = motion.visualVerticalRate;

    // 7. Truth Error & Screen Lead Monitoring
    motion.truthErrorKm = greatCircleDistanceKm(
      motion.latitude,
      motion.longitude,
      motion.physicalPosition.latitude,
      motion.physicalPosition.longitude
    );

    const effMult = motion.visualRate;
    motion.displayScreenSpeedPxPerSec = motion.realScreenSpeedPxPerSec * effMult;

    if (motion.inFrustum && motion.facingCamera && effMult > activeMotionMultiplier) {
      activeMotionMultiplier = effMult;
    }

    // 8. Compute 3D Earth-Local Display Position
    const r = earthRadius + (Math.max(0, motion.altitude) / 1000) * scale + 0.008;
    latLonToVector3(motion.latitude, motion.longitude, r, motion.displayPosition);

    // 9. All aircraft positions are Earth-local. Project their world position
    // after the authoritative GMST transform, never the unrotated local point.
    const worldPosition = motion.displayPosition.clone().applyMatrix4(earth.matrixWorld);
    const projected = projectWorldPosition(worldPosition, motion.screenPos);
    motion.inFrustum = projected.visible && !isBehindEarth(worldPosition);
    motion.facingCamera = !isBehindEarth(worldPosition);

    if (motion.inFrustum) {
      aircraftScreenCandidates.push({ index, id: truth.icao24, x: motion.screenPos.x, y: motion.screenPos.y, distancePx: 0 });
    }

    // Rolling history for trails
    if (nowSeconds - motion.lastHistorySampleTime >= 3.0) {
      motion.history.push({
        lat: motion.latitude,
        lon: motion.longitude,
        alt: motion.altitude,
        time: nowSeconds,
        pos: motion.displayPosition.clone(),
      });
      motion.lastHistorySampleTime = nowSeconds;
      while (motion.history.length > 0 && nowSeconds - motion.history[0].time > 240) {
        motion.history.shift();
      }
    }
  }

  // Decluttering cell bucket spacing tuned for traffic density (~30-38px regional)
  spatialBucketingManager.cellSizePx = THREE.MathUtils.clamp(24 + (10.0 - Math.min(10.0, cameraDistance)) * 3.2, 24, 40);

  const lodStats = spatialBucketingManager.processLOD(
    aircraft,
    window.innerWidth,
    window.innerHeight,
    selectedAircraftIndex,
    hoveredIcao
  );

  $('#lod-counts-val').textContent = `${lodStats.visibleRegion.toLocaleString()} REGION · ${lodStats.detailedGlyphs.toLocaleString()} GLYPHS`;
  const badgeBlock = $('#motion-badge-block');
  if (activeMotionMultiplier > 1.05) {
    badgeBlock.hidden = false;
    $('#motion-badge-val').textContent = `MOTION ×${activeMotionMultiplier.toFixed(1)}`;
  } else {
    badgeBlock.hidden = selectedAircraftIndex < 0;
    $('#motion-badge-val').textContent = `MOTION 1×`;
  }

  tierBInstanceToAircraftIndex.length = 0;
  tierAInstanceToAircraftIndex.length = 0;
  let countTierB = 0;
  let countTierA = 0;

  for (let index = 0; index < aircraft.length; index++) {
    const motion = aircraft[index];
    if (motion.opacity <= 0) continue;

    const isSel = selectedAircraftIndex === index;
    // Accurate Camera-to-Aircraft Euclidean distance in World Space
    const worldPos = motion.displayPosition.clone().applyMatrix4(earth.matrixWorld);
    const distToCam = camera.position.distanceTo(worldPos);

    const targetPx = isSel ? overlaySizes.aircraftSelected : (motion.lodTier === 'TIER_B' ? overlaySizes.aircraftTierB : overlaySizes.aircraftTierA);
    const worldScale = getWorldScaleForPixelSize(camera, distToCam, targetPx, viewportHeight);

    if (motion.lodTier === 'TIER_B' || isSel) {
      aircraftOrientation(motion.displayPosition, motion.trueTrack, worldScale, aircraftMatrixTemp);
      aircraftMarkersTierB.setMatrixAt(countTierB, aircraftMatrixTemp);

      aircraftColorTemp.setRGB(0.92 * motion.opacity, 0.98 * motion.opacity, motion.opacity);
      aircraftMarkersTierB.setColorAt(countTierB, aircraftColorTemp);

      tierBInstanceToAircraftIndex[countTierB] = index;
      countTierB++;
    } else {
      // Neutral micro-contact dot (isotropic, null heading)
      aircraftOrientation(motion.displayPosition, null, worldScale, aircraftMatrixTemp);
      aircraftMarkersTierA.setMatrixAt(countTierA, aircraftMatrixTemp);

      aircraftColorTemp.setRGB(0.55 * motion.opacity, 0.68 * motion.opacity, 0.78 * motion.opacity);
      aircraftMarkersTierA.setColorAt(countTierA, aircraftColorTemp);

      tierAInstanceToAircraftIndex[countTierA] = index;
      countTierA++;
    }

    if (isSel) {
      const airGlyphScale = getWorldScaleForPixelSize(camera, distToCam, overlaySizes.aircraftSelected, viewportHeight);
      const airHaloScale = getWorldScaleForPixelSize(camera, distToCam, overlaySizes.aircraftSelected * 1.35, viewportHeight);

      selectedAircraftGlyph.position.copy(motion.displayPosition);
      selectedAircraftHalo.position.copy(motion.displayPosition);
      aircraftOrientation(motion.displayPosition, motion.trueTrack, airGlyphScale, aircraftMatrixTemp);
      aircraftMatrixTemp.decompose(
        selectedAircraftGlyph.position,
        selectedAircraftGlyph.quaternion,
        selectedAircraftGlyph.scale
      );
      aircraftOrientation(motion.displayPosition, null, airHaloScale, aircraftMatrixTemp);
      aircraftMatrixTemp.decompose(
        selectedAircraftHalo.position,
        selectedAircraftHalo.quaternion,
        selectedAircraftHalo.scale
      );
    }
  }

  aircraftMarkersTierB.count = countTierB;
  aircraftMarkersTierB.instanceMatrix.needsUpdate = true;
  if (aircraftMarkersTierB.instanceColor) aircraftMarkersTierB.instanceColor.needsUpdate = true;
  aircraftMarkersTierA.count = countTierA;
  aircraftMarkersTierA.instanceMatrix.needsUpdate = true;
  if (aircraftMarkersTierA.instanceColor) aircraftMarkersTierA.instanceColor.needsUpdate = true;
  updateAircraftTrails(nowSeconds, cameraDistance);

  if (cameraMode === 'TRACKING' && isTrackingAircraft && selectedAircraftIndex >= 0 && aircraft[selectedAircraftIndex]) {
    const selectedMotion = aircraft[selectedAircraftIndex];
    if (selectedMotion.opacity > 0) {
      earth.updateWorldMatrix(true, false);
      const worldPos = selectedMotion.displayPosition.clone().applyMatrix4(earth.matrixWorld);
      const prevTarget = controls.target.clone();
      controls.target.lerp(worldPos, 0.08);
      const deltaTarget = controls.target.clone().sub(prevTarget);
      camera.position.add(deltaTarget);
    }
  }
}

// Callsign, Satellite Name & Cartographic Country DOM Label Manager
function updateDomLabels(cameraDistance: number) {
  labelCollisionManager.reset();
  let poolIdx = 0;
  const overlaySizes = getUnifiedOverlaySizes(cameraDistance);

  // Reduced callsign label density at regional and continental scales
  const maxPlacedAirLabels = cameraDistance > 16.0 ? 0 : cameraDistance > 9.0 ? 5 : cameraDistance > 5.5 ? 8 : 18;

  // 1. Aircraft Callsigns (Highest priority)
  if (showAircraft) {
    for (let index = 0; index < aircraft.length; index++) {
      const motion = aircraft[index];
      const isSelected = index === selectedAircraftIndex;
      const isHovered = motion.truth.icao24 === hoveredIcao;

      if (cameraDistance > 18.0 && !isSelected && !isHovered) continue;
      if (motion.opacity <= 0 || !motion.inFrustum || !motion.facingCamera) continue;
      // Micro-contacts (TIER_A) are NEVER labeled unless selected or hovered
      if (motion.lodTier !== 'TIER_B' && !isSelected && !isHovered) continue;
      // Limit total placed labels for clean cartographic look
      if (poolIdx >= maxPlacedAirLabels && !isSelected && !isHovered) continue;

      const callsign = (motion.truth.callsign || motion.truth.icao24).trim();
      const flAlt = `FL${Math.round(motion.altitude / 304.8)}`;
      const speedMps = `${Math.round(motion.velocity)} m/s`;

      const showSubtext = cameraDistance < 6.5 || isSelected || isHovered;
      const widthEstimate = callsign.length * 6.5 + 14;
      const heightEstimate = showSubtext ? 26 : 16;

      const canPlace = labelCollisionManager.tryPlaceLabel(
        motion.screenPos.x,
        motion.screenPos.y,
        widthEstimate,
        heightEstimate,
        isSelected || isHovered
      );

      if (canPlace) {
        let labelEl = domLabelPool[poolIdx];
        if (!labelEl) {
          labelEl = document.createElement('div');
          labelEl.className = 'aircraft-label';
          labelsContainer.appendChild(labelEl);
          domLabelPool.push(labelEl);
        }

        labelEl.className = `aircraft-label ${isSelected ? 'selected-label' : ''}`;
        labelEl.style.display = 'block';
        labelEl.style.left = `${motion.screenPos.x}px`;
        labelEl.style.top = `${motion.screenPos.y}px`;
        labelEl.style.opacity = String(Math.min(1.0, motion.opacity));

        labelEl.innerHTML = showSubtext
          ? `<div class="callsign">${escapeHtml(callsign)}</div><div class="subtext">${flAlt} · ${speedMps}</div>`
          : `<div class="callsign">${escapeHtml(callsign)}</div>`;

        poolIdx++;
      }
    }
  }

  // 2. Observer Geolocation Coordinates (Crisp DOM/CSS Overlay)
  let observerCoordEl = document.querySelector<HTMLElement>('#observer-coord-label');
  if (deviceLat !== null && deviceLon !== null && observerWorldPos) {
    const screenPos = new THREE.Vector2();
    const proj = projectWorldPosition(observerWorldPos, screenPos);
    const isVisible = proj.visible && !isBehindEarth(observerWorldPos);
    const isRecentlyLocated = Date.now() / 1000 < observerLabelExpiresAt;
    const showCoords = isVisible && (overlaySizes.observerCoordVisible || isRecentlyLocated);

    if (!observerCoordEl) {
      observerCoordEl = document.createElement('div');
      observerCoordEl.id = 'observer-coord-label';
      observerCoordEl.className = 'observer-coord-label';
      labelsContainer.appendChild(observerCoordEl);
    }

    if (showCoords) {
      observerCoordEl.style.display = 'block';
      const latText = `${Math.abs(deviceLat).toFixed(2)}°${deviceLat >= 0 ? 'N' : 'S'} · ${Math.abs(deviceLon).toFixed(2)}°${deviceLon >= 0 ? 'E' : 'W'}`;
      observerCoordEl.textContent = latText;
      observerCoordEl.style.fontSize = `${overlaySizes.observerCoordFontPx.toFixed(1)}px`;

      const widthEstimate = latText.length * 6.5 + 14;
      labelCollisionManager.tryPlaceLabel(screenPos.x, screenPos.y - 10, widthEstimate, 14, true);

      const offsetY = screenPos.y < 40 ? (overlaySizes.observerCore / 2 + 14) : -(overlaySizes.observerCore / 2 + 6);
      observerCoordEl.style.left = `${screenPos.x}px`;
      observerCoordEl.style.top = `${screenPos.y + offsetY}px`;
      observerCoordEl.style.opacity = isRecentlyLocated ? '1.0' : (cameraDistance > 16.0 ? '0.70' : '0.92');
    } else {
      observerCoordEl.style.display = 'none';
    }
  } else if (observerCoordEl) {
    observerCoordEl.style.display = 'none';
  }

  // 3. Priority Satellite Names
  if (showSatellites && poolIdx < maxPlacedAirLabels + 8) {
    const now = new Date();
    equatorialFrame.updateWorldMatrix(true, false);

    for (let index = 0; index < orbiters.length && poolIdx < maxPlacedAirLabels + 8; index++) {
      const orbiter = orbiters[index];
      const isSelected = index === selectedSatelliteIndex;
      const isHovered = orbiter.norad === hoveredSatelliteNorad;
      const allowSparse = cameraDistance < 13 && index % (cameraDistance < 9 ? 14 : 32) === 0;
      if (!isSelected && !isHovered && !allowSparse) continue;

      const propagated = satellite.propagate(orbiter.satrec, now);
      if (!propagated || !propagated.position) continue;

      const eciPos = eciVector(propagated.position as satellite.EciVec3<number>);
      const worldPos = eciPos.clone().applyMatrix4(equatorialFrame.matrixWorld);

      const screenVec = worldPos.clone().project(camera);
      if (screenVec.z > 1.0) continue;

      const screenX = (screenVec.x * 0.5 + 0.5) * window.innerWidth;
      const screenY = (-(screenVec.y * 0.5) + 0.5) * window.innerHeight;

      const camDir = camera.position.clone().sub(controls.target).normalize();
      if (worldPos.clone().normalize().dot(camDir) < 0.1) continue;

      const nameStr = orbiter.name.trim() || `NORAD ${orbiter.norad}`;
      const widthEstimate = nameStr.length * 6 + 14;
      const canPlace = labelCollisionManager.tryPlaceLabel(screenX, screenY, widthEstimate, 16, isSelected || isHovered);

      if (canPlace) {
        let labelEl = domLabelPool[poolIdx];
        if (!labelEl) {
          labelEl = document.createElement('div');
          labelEl.className = 'aircraft-label';
          labelsContainer.appendChild(labelEl);
          domLabelPool.push(labelEl);
        }

        labelEl.className = `aircraft-label ${isSelected ? 'selected-label' : ''}`;
        labelEl.style.display = 'block';
        labelEl.style.left = `${screenX}px`;
        labelEl.style.top = `${screenY}px`;
        labelEl.style.opacity = isSelected ? '1.0' : '0.80';
        labelEl.innerHTML = `<div class="callsign" style="color: #6acbfb;">${escapeHtml(nameStr)}</div>`;
        poolIdx++;
      }
    }
  }

  // 4. Natural Earth Geographic Country Labels (Cartographic / Restrained)
  const maxCountryLabels = cameraDistance > 20.0 ? 12 : cameraDistance > 13.0 ? 24 : cameraDistance > 8.0 ? 42 : 65;
  const maxCountryTier = cameraDistance > 19.0 ? 1 : cameraDistance > 10.5 ? 2 : 3;

  earth.updateWorldMatrix(true, false);
  const camDir = camera.position.clone().sub(controls.target).normalize();
  let countryPlacedCount = 0;

  for (let index = 0; index < COUNTRY_LABELS.length && countryPlacedCount < maxCountryLabels; index++) {
    const country = COUNTRY_LABELS[index];
    if (country.tier > maxCountryTier) continue;

    // Stable label position derived from Natural Earth / ISO geography
    const localPos = latLonToVector3(country.lat, country.lon, earthRadius + 0.005);
    const worldPos = localPos.clone().applyMatrix4(earth.matrixWorld);

    // Reject labels on far side of globe or behind the Earth
    const facing = worldPos.clone().normalize().dot(camDir);
    if (facing < 0.12) continue;
    if (isBehindEarth(worldPos)) continue;

    const screenVec = worldPos.clone().project(camera);
    if (screenVec.z > 1.0) continue;

    const screenX = (screenVec.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-(screenVec.y * 0.5) + 0.5) * window.innerHeight;

    if (screenX < -30 || screenX > window.innerWidth + 30 || screenY < -30 || screenY > window.innerHeight + 30) continue;

    // Subtle collision box to avoid visual clutter with aircraft, satellites, and other countries
    const widthEstimate = country.name.length * 6.0 + 8;
    const heightEstimate = 12;

    const canPlace = labelCollisionManager.tryPlaceLabel(screenX, screenY, widthEstimate, heightEstimate, false);
    if (!canPlace) continue;

    // Fade near limb smoothly
    const limbFactor = THREE.MathUtils.clamp((facing - 0.12) / 0.32, 0, 1);
    const baseOpacity = country.tier === 1 ? 0.72 : country.tier === 2 ? 0.58 : 0.46;
    const opacity = baseOpacity * limbFactor;
    if (opacity < 0.06) continue;

    let labelEl = domLabelPool[poolIdx];
    if (!labelEl) {
      labelEl = document.createElement('div');
      labelsContainer.appendChild(labelEl);
      domLabelPool.push(labelEl);
    }

    labelEl.className = 'country-label';
    labelEl.style.display = 'block';
    labelEl.style.left = `${screenX}px`;
    labelEl.style.top = `${screenY}px`;
    labelEl.style.opacity = opacity.toFixed(2);
    labelEl.textContent = country.name;

    poolIdx++;
    countryPlacedCount++;
  }

  for (let i = poolIdx; i < domLabelPool.length; i++) {
    domLabelPool[i].style.display = 'none';
  }

  // 5. Astronomical Reference DOM Labels (N, S, 23.44° Axial Tilt)
  const tiltZoomFactor = THREE.MathUtils.clamp((cameraDistance - 5.5) / (12.0 - 5.5), 0, 1);
  const axisLabelZoomFactor = THREE.MathUtils.clamp((cameraDistance - 5.0) / (10.0 - 5.0), 0, 1);

  let northLabelEl = document.querySelector<HTMLElement>('#ref-label-north');
  let southLabelEl = document.querySelector<HTMLElement>('#ref-label-south');
  let tiltLabelEl = document.querySelector<HTMLElement>('#ref-label-tilt');

  if (!northLabelEl) {
    northLabelEl = document.createElement('div');
    northLabelEl.id = 'ref-label-north';
    northLabelEl.className = 'ref-label';
    northLabelEl.textContent = 'N';
    labelsContainer.appendChild(northLabelEl);
  }
  if (!southLabelEl) {
    southLabelEl = document.createElement('div');
    southLabelEl.id = 'ref-label-south';
    southLabelEl.className = 'ref-label';
    southLabelEl.textContent = 'S';
    labelsContainer.appendChild(southLabelEl);
  }
  if (!tiltLabelEl) {
    tiltLabelEl = document.createElement('div');
    tiltLabelEl.id = 'ref-label-tilt';
    tiltLabelEl.className = 'ref-label tilt-angle';
    tiltLabelEl.textContent = '23.44°';
    labelsContainer.appendChild(tiltLabelEl);
  }

  equatorialFrame.updateWorldMatrix(true, false);

  // North Pole
  const northWorld = new THREE.Vector3(0, 4.46, 0).applyMatrix4(equatorialFrame.matrixWorld);
  const northScreen = new THREE.Vector2();
  const northProj = projectWorldPosition(northWorld, northScreen);
  if (northProj.visible && !isBehindEarth(northWorld) && axisLabelZoomFactor > 0.01) {
    northLabelEl.style.display = 'block';
    northLabelEl.style.left = `${northScreen.x}px`;
    northLabelEl.style.top = `${northScreen.y}px`;
    northLabelEl.style.opacity = (0.75 * axisLabelZoomFactor).toFixed(2);
  } else {
    northLabelEl.style.display = 'none';
  }

  // South Pole
  const southWorld = new THREE.Vector3(0, -4.46, 0).applyMatrix4(equatorialFrame.matrixWorld);
  const southScreen = new THREE.Vector2();
  const southProj = projectWorldPosition(southWorld, southScreen);
  if (southProj.visible && !isBehindEarth(southWorld) && axisLabelZoomFactor > 0.01) {
    southLabelEl.style.display = 'block';
    southLabelEl.style.left = `${southScreen.x}px`;
    southLabelEl.style.top = `${southScreen.y}px`;
    southLabelEl.style.opacity = (0.75 * axisLabelZoomFactor).toFixed(2);
  } else {
    southLabelEl.style.display = 'none';
  }

  // 23.44° Tilt Angle Label (midpoint of tilt arc)
  const halfAngle = obliquity * 0.5;
  const tiltWorld = new THREE.Vector3(-Math.sin(halfAngle) * 4.44, Math.cos(halfAngle) * 4.44, 0).applyMatrix4(equatorialFrame.matrixWorld);
  const tiltScreen = new THREE.Vector2();
  const tiltProj = projectWorldPosition(tiltWorld, tiltScreen);
  if (tiltProj.visible && !isBehindEarth(tiltWorld) && tiltZoomFactor > 0.01) {
    tiltLabelEl.style.display = 'block';
    tiltLabelEl.style.left = `${tiltScreen.x}px`;
    tiltLabelEl.style.top = `${tiltScreen.y}px`;
    tiltLabelEl.style.opacity = (0.75 * tiltZoomFactor).toFixed(2);
  } else {
    tiltLabelEl.style.display = 'none';
  }
}

function clearAircraftData() {
  aircraftStore.clear();
  aircraft = [];
  activeRegionsMap.clear();
  requestQueue.length = 0;
  selectedAircraftIndex = -1;
  selectedAircraftIcao = null;
  isTrackingAircraft = false;
  aircraftMarkersTierB.count = 0;
  aircraftMarkersTierA.count = 0;
  aircraftTrailGeometry.setDrawRange(0, 0);
  selectedAircraftGlyph.visible = false;
  selectedAircraftHalo.visible = false;
  for (const labelEl of domLabelPool) labelEl.style.display = 'none';
}

function selectAircraft(index: number) {
  selectedSatelliteIndex = -1;
  selectedSatelliteNorad = null;
  selectedSatHalo.visible = false;
  selectedSatGlyph.visible = false;
  clearOrbit();

  selectedAircraftIndex = index;
  selectedAircraftIcao = aircraft[index]?.truth.icao24 ?? null;
  isTrackingAircraft = false;
  cameraMode = 'MANUAL';
  selectedAircraftGlyph.visible = true;
  selectedAircraftHalo.visible = true;
  $('#status-drawer').style.opacity = '0';
  updateAircraftInspector();
}

function updateAircraftInspector() {
  const motion = aircraft[selectedAircraftIndex];
  if (!motion) return;
  const truth = motion.truth;

  $('#inspector').hidden = false;
  const callsign = (truth.callsign || truth.icao24).trim();
  const trackDeg = motion.trueTrack !== null ? `${Math.round(motion.trueTrack)}°` : '—';

  $('#inspector').innerHTML = `
    <div class="inspector-header">
      <div><span class="inspector-kicker">AIRCRAFT</span><h2>${escapeHtml(callsign)}</h2><span class="inspector-id">ICAO24 ${escapeHtml(truth.icao24.toUpperCase())}</span></div>
      <span class="type-badge">LIVE</span>
    </div>
    <dl class="inspector-grid">
      <dt>GEO ALTITUDE</dt><dd>${(motion.altitude / 1000).toFixed(2)} km</dd>
      <dt>GROUND SPEED</dt><dd>${Math.round(motion.velocity)} m/s</dd>
      <dt>TRACK</dt><dd>${trackDeg}</dd>
      <dt>VERTICAL RATE</dt><dd>${motion.verticalRate.toFixed(1)} m/s</dd>
      <dt>OBSERVED</dt><dd>${formatAge(Date.now() / 1000 - truth.positionTime)} ago</dd>
    </dl>
    <button id="track-aircraft-btn" class="track-btn ${isTrackingAircraft ? 'active' : ''}">
      ${isTrackingAircraft ? '✓ TRACKING AIRCRAFT' : 'TRACK AIRCRAFT'}
    </button>
  `;

  $('#track-aircraft-btn').addEventListener('click', () => {
    isTrackingAircraft = !isTrackingAircraft;
    cameraMode = isTrackingAircraft ? 'TRACKING' : 'MANUAL';
    updateAircraftInspector();
  });
}

function mergeAircraftPayload(payload: { provider: AircraftProvider; observedAt: number; states: TruthState[] }) {
  const receivedAt = Date.now() / 1000;
  aircraftObservedAt = Math.max(aircraftObservedAt, payload.observedAt);
  aircraftProvider = payload.provider;
  updateAircraftAttribution();
  aircraftAvailable = true;

  for (const item of payload.states) {
    const oldMotion = aircraftStore.get(item.icao24);
    const altMeters = altitudeForTruth(item) ?? 10000;
    const initialPos = latLonToVector3(item.latitude, item.longitude, earthRadius + (altMeters / 1000) * scale + 0.008);

    const anchor: ObservationAnchor = {
      latitude: item.latitude,
      longitude: item.longitude,
      altitude: altMeters,
      velocity: item.velocity ?? 0,
      trueTrack: item.trueTrack ?? 0,
      verticalRate: item.verticalRate ?? 0,
      positionTime: item.positionTime,
      onGround: item.onGround,
    };

    if (!oldMotion) {
      aircraftStore.set(item.icao24, {
        truth: item,
        anchor,
        visualHeading: item.trueTrack ?? 0,
        visualVelocity: item.velocity ?? 0,
        visualVerticalRate: item.verticalRate ?? 0,
        visualAltitude: altMeters,
        accumulatedVisualLead: 0,
        visualRate: 1.0,
        visualLeadSeconds: 0,
        latitude: item.latitude,
        longitude: item.longitude,
        altitude: altMeters,
        trueTrack: item.trueTrack ?? 0,
        velocity: item.velocity ?? 0,
        verticalRate: item.verticalRate ?? 0,
        displayPosition: initialPos,
        physicalPosition: { latitude: item.latitude, longitude: item.longitude, altitude: altMeters },
        confidence: 1.0,
        screenPos: new THREE.Vector2(),
        targetScreenSpeedPxSec: 1.3,
        realScreenSpeedPxPerSec: 0,
        displayScreenSpeedPxPerSec: 0,
        truthErrorKm: 0,
        screenLeadPx: 0,
        inFrustum: true,
        facingCamera: true,
        reconciling: false,
        blendFromLat: item.latitude,
        blendFromLon: item.longitude,
        blendFromAlt: altMeters,
        reconcileStartedAt: receivedAt,
        reconcileDuration: 0,
        history: [{ lat: item.latitude, lon: item.longitude, alt: altMeters, time: receivedAt, pos: initialPos.clone() }],
        lastHistorySampleTime: receivedAt,
        lodTier: 'TIER_B',
        showLabel: false,
        labelPosition: new THREE.Vector2(),
        phase: 'OBSERVED',
        opacity: 1.0,
      });
    } else if (item.positionTime > oldMotion.truth.positionTime) {
      const distKm = greatCircleDistanceKm(oldMotion.latitude, oldMotion.longitude, item.latitude, item.longitude);
      const isFarJump = distKm > 350.0;
      const corrDuration = isFarJump ? 0 : Math.min(3.5, Math.max(2.0, distKm / 25.0));
      const timeDelta = Math.max(0, item.positionTime - oldMotion.anchor.positionTime);
      const preservedLead = Math.max(0, (oldMotion.accumulatedVisualLead ?? 0) - timeDelta);

      oldMotion.truth = item;
      oldMotion.anchor = {
        ...anchor,
        velocity: item.velocity ?? oldMotion.anchor.velocity,
        trueTrack: item.trueTrack ?? oldMotion.anchor.trueTrack,
        verticalRate: item.verticalRate ?? oldMotion.anchor.verticalRate,
      };
      oldMotion.accumulatedVisualLead = preservedLead;
      oldMotion.visualLeadSeconds = preservedLead;
      oldMotion.reconciling = !isFarJump;
      oldMotion.blendFromLat = oldMotion.latitude;
      oldMotion.blendFromLon = oldMotion.longitude;
      oldMotion.blendFromAlt = oldMotion.altitude;
      oldMotion.reconcileStartedAt = receivedAt;
      oldMotion.reconcileDuration = corrDuration;
      oldMotion.confidence = 1.0;
      oldMotion.phase = 'OBSERVED';
      oldMotion.opacity = 1.0;
    } else if (item.positionTime === oldMotion.truth.positionTime) {
      oldMotion.truth = item;
    }
  }

  aircraft = Array.from(aircraftStore.values());
  resolveSelectionIndices();
}

async function processRequestQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  try {
    while (requestQueue.length > 0) {
      if (!showAircraft) {
        requestQueue.length = 0;
        break;
      }

      const key = requestQueue.shift()!;
      const region = activeRegionsMap.get(key);
      if (!region) continue;

      if (Date.now() - region.lastFetchedAt < REGION_CACHE_TTL_MS && region.status === 'success') {
        continue;
      }

      const elapsed = Date.now() - lastRequestTimeMs;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
      }

      region.status = 'loading';
      lastRequestTimeMs = Date.now();

      try {
        const bounds = {
          lamin: Math.max(-90, region.lat - 4.16),
          lamax: Math.min(90, region.lat + 4.16),
          lomin: Math.max(-180, region.lon - 4.16),
          lomax: Math.min(180, region.lon + 4.16),
        };
        const query = new URLSearchParams({
          lamin: bounds.lamin.toFixed(2),
          lamax: bounds.lamax.toFixed(2),
          lomin: bounds.lomin.toFixed(2),
          lomax: bounds.lomax.toFixed(2),
        });

        const response = await fetch(`/api/aircraft?${query.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as { provider: AircraftProvider; observedAt: number; states: TruthState[] };
        region.status = 'success';
        region.lastFetchedAt = Date.now();
        region.aircraftCount = payload.states.length;
        mergeAircraftPayload(payload);
      } catch (err) {
        region.status = 'error';
        region.lastFetchedAt = Date.now() - (REGION_CACHE_TTL_MS - 10000);
        console.warn('[VECTOR aircraft stream]', key, err);
      }
    }
  } finally {
    isQueueProcessing = false;
  }
}

function scheduleVisibleRegionFetches() {
  if (!showAircraft) return;
  const now = Date.now();
  const visibleRegions = discoverVisibleRegions();

  const needed: Array<{ key: string; lat: number; lon: number; distDeg: number }> = [];
  for (const reg of visibleRegions) {
    const cached = activeRegionsMap.get(reg.key);
    if (!cached || now - cached.lastFetchedAt >= REGION_CACHE_TTL_MS || cached.status === 'error') {
      needed.push(reg);
    }
  }

  const toEnqueue = needed.slice(0, MAX_ENQUEUED_REGIONS);
  const visibleKeySet = new Set(visibleRegions.map((r) => r.key));

  for (let i = requestQueue.length - 1; i >= 0; i--) {
    if (!visibleKeySet.has(requestQueue[i])) {
      requestQueue.splice(i, 1);
    }
  }

  for (const item of toEnqueue) {
    if (!activeRegionsMap.has(item.key)) {
      activeRegionsMap.set(item.key, {
        key: item.key,
        lat: item.lat,
        lon: item.lon,
        radiusNm: REGION_RADIUS_NM,
        lastFetchedAt: 0,
        status: 'idle',
        aircraftCount: 0,
      });
    }
    if (!requestQueue.includes(item.key)) {
      requestQueue.push(item.key);
    }
  }

  processRequestQueue();
}

function checkCameraMovement() {
  const current = getSubCameraCoordinates();
  const dLat = Math.abs(current.lat - lastCheckedCamPos.lat);
  let dLon = Math.abs(current.lon - lastCheckedCamPos.lon);
  if (dLon > 180) dLon = 360 - dLon;
  const dDistRatio = Math.abs(current.dist - lastCheckedCamPos.dist) / Math.max(1, lastCheckedCamPos.dist);

  if (dLat > 2.0 || dLon > 2.0 || dDistRatio > 0.10) {
    lastCheckedCamPos = current;
    if (cameraMoveDebounceTimer !== null) {
      clearTimeout(cameraMoveDebounceTimer);
    }
    cameraMoveDebounceTimer = window.setTimeout(() => {
      cameraMoveDebounceTimer = null;
      scheduleVisibleRegionFetches();
    }, 450);
  }
}

function clearSatelliteData() {
  orbiters = [];
  selectedSatelliteIndex = -1;
  selectedSatelliteNorad = null;
  satGlyphsMesh.count = 0;
  selectedSatHalo.visible = false;
  selectedSatGlyph.visible = false;
  clearOrbit();
}

async function loadSatellites() {
  try {
    const response = await fetch('/api/satellites?limit=6000');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = (await response.json()) as { catalogCount: number; retrievedAt: number; elements: OmmElement[] };
    catalogCount = payload.catalogCount;
    elementsRetrievedAt = payload.retrievedAt;

    orbiters = [];
    for (const element of payload.elements) {
      try {
        const epoch = new Date(element.EPOCH);
        const satrec = satellite.json2satrec(element);
        if (!Number.isFinite(epoch.getTime()) || satrec.error) continue;
        orbiters.push({ name: element.OBJECT_NAME, objectId: element.OBJECT_ID, norad: String(element.NORAD_CAT_ID), epoch, satrec });
      } catch {
        continue;
      }
    }
    resolveSelectionIndices();
    satGlyphsMesh.count = Math.min(orbiters.length, maxSatellites);
    $('#satellite-status').textContent = `${orbiters.length.toLocaleString()} RENDERED`;
    updateSatellites();
  } catch {
    clearSatelliteData();
    $('#satellite-status').textContent = 'UNAVAILABLE';
    $('#satellite-meta').textContent = 'CELESTRAK GP · NO CURRENT RESPONSE';
  }
}

// Continuous Frame-by-Frame Satellite Instanced Mesh Propagator
function updateSatellites() {
  if (!showSatellites) {
    satGlyphsMesh.count = 0;
    return;
  }

  const now = new Date();

  equatorialFrame.updateWorldMatrix(true, false);
  const camLocalPos = camera.position.clone().applyMatrix4(equatorialFrame.matrixWorld.clone().invert());
  const viewportHeight = window.innerHeight;
  const cameraDistance = camera.position.distanceTo(controls.target);
  const satelliteMaterial = satGlyphsMesh.material as THREE.MeshBasicMaterial;
  satelliteMaterial.opacity = THREE.MathUtils.clamp(0.12 + (20 - cameraDistance) * 0.012, 0.12, 0.30);

  satInstanceToOrbiterIndex.length = 0;
  satelliteScreenCandidates = [];
  let renderedCount = 0;

  for (let index = 0; index < orbiters.length && renderedCount < maxSatellites; index++) {
    const orbiter = orbiters[index];
    const propagated = satellite.propagate(orbiter.satrec, now);
    if (!propagated || !propagated.position) continue;

    const position = eciVector(propagated.position as satellite.EciVec3<number>);
    const isSel = selectedSatelliteIndex === index;
    const satDist = position.distanceTo(camLocalPos);

    // Subtle orbital field globally; full VECTOR silhouette only earns weight nearby.
    const globalPx = THREE.MathUtils.clamp(1.8 + (18 - cameraDistance) * 0.22, 1.8, 5.8);
    const desiredPx = isSel ? 9.5 : THREE.MathUtils.clamp(globalPx + (14 - satDist) * 0.05, 1.7, 6.5);
    const satScale = getWorldScaleForPixelSize(camera, satDist, desiredPx, viewportHeight);

    // Billboard orientation facing camera
    satPosTemp.copy(position);
    satLookTemp.position.copy(satPosTemp);
    satLookTemp.lookAt(camLocalPos);

    satMatrixTemp.makeTranslation(satPosTemp.x, satPosTemp.y, satPosTemp.z);
    satMatrixTemp.multiply(new THREE.Matrix4().makeRotationFromQuaternion(satLookTemp.quaternion));
    satMatrixTemp.scale(new THREE.Vector3(satScale, satScale, satScale));

    satGlyphsMesh.setMatrixAt(renderedCount, satMatrixTemp);

    satInstanceToOrbiterIndex[renderedCount] = index;
    const worldPosition = position.clone().applyMatrix4(equatorialFrame.matrixWorld);
    const screen = new THREE.Vector2();
    if (projectWorldPosition(worldPosition, screen).visible && !isBehindEarth(worldPosition)) {
      satelliteScreenCandidates.push({ index, id: orbiter.norad, x: screen.x, y: screen.y, distancePx: 0 });
    }
    renderedCount++;
  }

  satGlyphsMesh.count = renderedCount;
  satGlyphsMesh.instanceMatrix.needsUpdate = true;

  if (selectedSatelliteIndex >= 0 && orbiters[selectedSatelliteIndex]) {
    const selProp = satellite.propagate(orbiters[selectedSatelliteIndex].satrec, now);
    if (selProp && selProp.position) {
      const pos = eciVector(selProp.position as satellite.EciVec3<number>);
      selectedSatHalo.position.copy(pos);
      selectedSatGlyph.position.copy(pos);
      selectedSatHalo.lookAt(camera.position);
      selectedSatGlyph.lookAt(camera.position);

      const satDist = pos.distanceTo(camera.position);
      const bracketScale = getWorldScaleForPixelSize(camera, satDist, 16.0, viewportHeight);
      selectedSatHalo.scale.setScalar(bracketScale);
      const glyphScale = getWorldScaleForPixelSize(camera, satDist, 9.5, viewportHeight);
      selectedSatGlyph.scale.setScalar(glyphScale);
    }
  }
}

// Calculate Genuine Orbital Period from Satrec Mean Motion (rad/min)
function drawOrbit(index: number) {
  clearOrbit();
  const item = orbiters[index];
  if (!item) return;

  // satrec.no_kozai or satrec.no is mean motion in rad/min. 1 revolution = 2*PI radians.
  const satrecAny = item.satrec as unknown as Record<string, unknown>;
  const meanMotionRadMin = (typeof satrecAny.no_kozai === 'number' ? satrecAny.no_kozai : undefined) || item.satrec.no;
  let periodMinutes = 96.0;
  if (meanMotionRadMin && meanMotionRadMin > 0) {
    periodMinutes = (2 * Math.PI) / meanMotionRadMin;
  }
  // Sanity clamp period between 85 min (LEO) and 1440 min (GEO / 24 hr)
  periodMinutes = THREE.MathUtils.clamp(periodMinutes, 85, 1440);

  // Adaptive sampling strategy based on orbital regime and eccentricity
  const ecc = (item.satrec as unknown as Record<string, number>).ecco ?? (item.satrec as unknown as Record<string, number>).e ?? 0;
  let numSamples = 200; // LEO default (180–240)
  if (ecc > 0.25 || periodMinutes > 800) {
    numSamples = 380; // GEO / High Eccentricity (320–480)
  } else if (periodMinutes > 130) {
    numSamples = 280; // MEO (240–320)
  }
  if (numSamples % 2 !== 0) numSamples++;

  const points: THREE.Vector3[] = [];
  const now = Date.now();
  const stepMin = periodMinutes / numSamples;

  for (let i = -numSamples / 2; i <= numSamples / 2; i++) {
    const tMin = i * stepMin;
    const propagated = satellite.propagate(item.satrec, new Date(now + tMin * 60000));
    if (propagated && propagated.position) {
      points.push(eciVector(propagated.position as satellite.EciVec3<number>));
    }
  }

  if (points.length < 2) return;

  const orbitGroup = new THREE.Group();

  // LAYER A — OCCLUDED / CONTEXT ORBIT
  // Full propagated trajectory visible through the Earth with thin sparse dash treatment.
  // Provides complete orbital context without competing with geography.
  const fullGeometry = new THREE.BufferGeometry().setFromPoints(points);
  const contextOrbit = new THREE.Line(
    fullGeometry,
    new THREE.LineDashedMaterial({
      color: 0x5fa8c8,
      transparent: true,
      opacity: 0.07,
      dashSize: 0.012,
      gapSize: 0.050,
      depthWrite: false,
      depthTest: false,
    })
  );
  contextOrbit.computeLineDistances();
  orbitGroup.add(contextOrbit);

  // LAYER B — VISIBLE DEPTH-TESTED ORBIT
  // Camera-facing portion naturally dominates via depth testing.
  // Subtle past vs future split around current UTC (midpoint index).
  const midpoint = Math.floor(points.length / 2);
  const pastPoints = points.slice(0, midpoint + 1);
  const futurePoints = points.slice(midpoint);

  if (pastPoints.length >= 2) {
    const pastGeo = new THREE.BufferGeometry().setFromPoints(pastPoints);
    const pastOrbit = new THREE.Line(
      pastGeo,
      new THREE.LineDashedMaterial({
        color: 0x5a9ebf,
        transparent: true,
        opacity: 0.22,
        dashSize: 0.018,
        gapSize: 0.042,
        depthWrite: false,
        depthTest: true,
      })
    );
    pastOrbit.computeLineDistances();
    orbitGroup.add(pastOrbit);
  }

  if (futurePoints.length >= 2) {
    const futureGeo = new THREE.BufferGeometry().setFromPoints(futurePoints);
    const futureOrbit = new THREE.Line(
      futureGeo,
      new THREE.LineDashedMaterial({
        color: 0x75bdd8,
        transparent: true,
        opacity: 0.32,
        dashSize: 0.020,
        gapSize: 0.038,
        depthWrite: false,
        depthTest: true,
      })
    );
    futureOrbit.computeLineDistances();
    orbitGroup.add(futureOrbit);
  }

  // CURRENT-POSITION EMPHASIS
  // Restrained temporal window (±6% of orbital period around current UTC)
  const windowSamples = Math.max(3, Math.round(numSamples * 0.06));
  const nearStart = Math.max(0, midpoint - windowSamples);
  const nearEnd = Math.min(points.length, midpoint + windowSamples + 1);
  const nearPoints = points.slice(nearStart, nearEnd);

  if (nearPoints.length >= 2) {
    const nearGeo = new THREE.BufferGeometry().setFromPoints(nearPoints);
    const nearOrbit = new THREE.Line(
      nearGeo,
      new THREE.LineDashedMaterial({
        color: 0x9be0f7,
        transparent: true,
        opacity: 0.60,
        dashSize: 0.024,
        gapSize: 0.028,
        depthWrite: false,
        depthTest: true,
      })
    );
    nearOrbit.computeLineDistances();
    orbitGroup.add(nearOrbit);
  }

  orbitLine = orbitGroup;
  equatorialFrame.add(orbitLine);
}

function selectSatellite(index: number) {
  selectedAircraftIndex = -1;
  selectedAircraftIcao = null;
  isTrackingAircraft = false;
  cameraMode = 'MANUAL';
  selectedAircraftGlyph.visible = false;
  selectedAircraftHalo.visible = false;

  selectedSatelliteIndex = index;
  selectedSatelliteNorad = orbiters[index]?.norad ?? null;
  drawOrbit(index);
  selectedSatHalo.visible = true;
  selectedSatGlyph.visible = true;
  $('#status-drawer').style.opacity = '0';
  updateSatelliteInspector(new Date());
}

function updateSatelliteInspector(now: Date) {
  const item = orbiters[selectedSatelliteIndex];
  if (!item) return;
  const propagated = satellite.propagate(item.satrec, now);
  if (!propagated || !propagated.position || !propagated.velocity) return;

  const posVec = propagated.position as satellite.EciVec3<number>;
  const velVec = propagated.velocity as satellite.EciVec3<number>;
  const position = eciVector(posVec);

  selectedSatHalo.position.copy(position);
  selectedSatGlyph.position.copy(position);
  selectedSatHalo.lookAt(camera.position);
  selectedSatGlyph.lookAt(camera.position);

  const geodetic = satellite.eciToGeodetic(posVec, satellite.gstime(now));
  const spd = Math.sqrt(velVec.x * velVec.x + velVec.y * velVec.y + velVec.z * velVec.z);

  let periodMin = 96.0;
  if (item.satrec.no && item.satrec.no > 0) {
    periodMin = (2 * Math.PI) / item.satrec.no;
  }

  $('#inspector').hidden = false;
  $('#inspector').innerHTML = `
    <div class="inspector-header">
      <div><span class="inspector-kicker">SATELLITE</span><h2>${escapeHtml(item.name)}</h2><span class="inspector-id">NORAD ${escapeHtml(item.norad)}</span></div>
      <span class="type-badge">SGP4</span>
    </div>
    <dl class="inspector-grid">
      <dt>ALTITUDE</dt><dd>${Math.round(geodetic.height)} km</dd>
      <dt>VELOCITY</dt><dd>${spd.toFixed(2)} km/s</dd>
      <dt>INCLINATION</dt><dd>${THREE.MathUtils.radToDeg(item.satrec.inclo).toFixed(2)}°</dd>
      <dt>PERIOD</dt><dd>${periodMin.toFixed(1)} min</dd>
      <dt>ELEMENT EPOCH</dt><dd>${utc(item.epoch)}</dd>
      <dt>RETRIEVED</dt><dd>${formatAge((Date.now() - elementsRetrievedAt) / 1000)} ago</dd>
      <dt>SOURCE</dt><dd>CELESTRAK</dd>
    </dl>
  `;
}

function updateStatuses(now: Date) {
  const freshAircraftCount = aircraft.filter((item) => (now.getTime() / 1000) - item.truth.positionTime <= 120).length;
  const visibleAircraftCount = aircraft.filter((item) => item.inFrustum && item.facingCamera && item.opacity > 0).length;
  const activeLiveRegions = Array.from(activeRegionsMap.values()).filter(
    (r) => Date.now() - r.lastFetchedAt <= REGION_CACHE_TTL_MS * 2 && r.status === 'success'
  ).length;

  if (showAircraft) {
    if (aircraftAvailable) {
      $('#aircraft-status').textContent = `${visibleAircraftCount.toLocaleString()} VISIBLE`;
      $('#aircraft-meta').textContent = `${aircraftProviderLabel()} · ${activeLiveRegions} LIVE REGION${activeLiveRegions === 1 ? '' : 'S'}`;
    } else {
      $('#aircraft-status').textContent = 'UNAVAILABLE';
      $('#aircraft-meta').textContent = `${aircraftProviderLabel()} · NO RESPONSE`;
    }
  } else {
    $('#aircraft-status').textContent = 'LAYER HIDDEN';
  }

  $('#sat-count').textContent = showSatellites ? orbiters.length.toLocaleString() : '0';
  $('#air-count').textContent = showAircraft ? freshAircraftCount.toLocaleString() : '0';

  if (selectedSatelliteIndex >= 0) updateSatelliteInspector(now);
  else if (selectedAircraftIndex >= 0) updateAircraftInspector();
  updateMotionDebugPanel();
}

let lastHitSatName = 'NONE';
let lastHitSatInstanceId = 'NONE';
let lastHitAirCallsign = 'NONE';
let lastHitAirTier = 'NONE';
let lastHitAirInstanceId = 'NONE';

function updateMotionDebugPanel() {
  const panel = $('#motion-debug-panel');
  const metricsEl = $('#debug-metrics');
  if (!panel || panel.hidden || !metricsEl) return;

  const cameraDist = camera.position.distanceTo(controls.target);
  const activeAir = aircraft.filter((a) => a.opacity > 0);
  const detailedAir = activeAir.filter((a) => a.lodTier === 'TIER_B').length;
  const microAir = activeAir.filter((a) => a.lodTier === 'TIER_A').length;
  const visibleLabels = domLabelPool.filter((el) => el.style.display !== 'none').length;

  const selectedSatName = selectedSatelliteIndex >= 0 && orbiters[selectedSatelliteIndex] ? orbiters[selectedSatelliteIndex].name : 'NONE';
  const selectedMotion = selectedAircraftIndex >= 0 ? aircraft[selectedAircraftIndex] : null;
  const selectedAirIcao = selectedMotion ? selectedMotion.truth.icao24 : 'NONE';
  
  const airObsAgeStr = selectedMotion ? `${formatAge(Date.now() / 1000 - selectedMotion.anchor.positionTime)} (conf ${(selectedMotion.confidence * 100).toFixed(0)}%)` : '—';
  const airPhysPredStr = selectedMotion ? `${selectedMotion.physicalPosition.latitude.toFixed(3)}°, ${selectedMotion.physicalPosition.longitude.toFixed(3)}°` : '—';
  const airDispPredStr = selectedMotion ? `${selectedMotion.latitude.toFixed(3)}°, ${selectedMotion.longitude.toFixed(3)}°` : '—';
  const airLeadSecStr = selectedMotion ? `${selectedMotion.visualLeadSeconds.toFixed(1)}s (rate ${(selectedMotion.visualRate ?? 1.0).toFixed(1)}×)` : '—';
  const airTruthDistStr = selectedMotion ? `${selectedMotion.truthErrorKm.toFixed(2)} km (lead ${selectedMotion.screenLeadPx.toFixed(1)}px)` : '—';
  const airScreenSpeedStr = selectedMotion ? `${selectedMotion.realScreenSpeedPxPerSec.toFixed(2)} px/s (disp ${selectedMotion.displayScreenSpeedPxPerSec.toFixed(2)})` : '—';
  const airHeadingStr = selectedMotion ? `${selectedMotion.visualHeading.toFixed(1)}° (truth ${selectedMotion.anchor.trueTrack.toFixed(1)}°)` : '—';

  const devLatStr = deviceLat !== null ? `${deviceLat.toFixed(4)}°` : '—';
  const devLonStr = deviceLon !== null ? `${deviceLon.toFixed(4)}°` : '—';

  const q = currentEarthOrientation.quaternion;
  const qStr = `${q.x.toFixed(4)}, ${q.y.toFixed(4)}, ${q.z.toFixed(4)}, ${q.w.toFixed(4)}`;
  const cameraQ = camera.quaternion;
  const cameraQStr = `${cameraQ.x.toFixed(4)}, ${cameraQ.y.toFixed(4)}, ${cameraQ.z.toFixed(4)}, ${cameraQ.w.toFixed(4)}`;
  const probeText = (label: string) => {
    const probe = landmarkProbes.find((entry) => entry.label === label)!;
    return `${probe.screen.x.toFixed(1)}, ${probe.screen.y.toFixed(1)} · Δ${probe.deltaPx.toFixed(2)}px`;
  };

  metricsEl.innerHTML = `
    <dt>FPS</dt><dd>${currentFps}</dd>
    <dt>UTC</dt><dd>${utc(new Date())}</dd>
    <dt>EARTH VISUAL UTC</dt><dd>${utc(new Date(earthSimulationTimeMs(Date.now())))}</dd>
    <dt>EARTH RATE</dt><dd>${earthRealtimeReconciliation ? '1× · SYNCING' : `${earthTimeScale}×${earthTimeScale === 1 ? ' · REALTIME' : ' · VISUAL'}`}</dd>
    <dt>GMST</dt><dd>${currentEarthOrientation.gmstDeg.toFixed(4)}°</dd>
    <dt>GMST DELTA / ELAPSED</dt><dd>${gmstDeltaDeg.toFixed(5)}° / ${landmarkProbeElapsedSec.toFixed(1)}s</dd>
    <dt>EARTH ROT ANGLE</dt><dd>${currentEarthOrientation.rotAngleDeg.toFixed(4)}°</dd>
    <dt>EARTH FIXED QUAT</dt><dd>${qStr}</dd>
    <div class="debug-divider"></div>
    <dt>CAMERA MODE</dt><dd>${cameraMode}</dd>
    <dt>CAMERA DISTANCE</dt><dd>${cameraDist.toFixed(2)} Earth Radii</dd>
    <dt>CAMERA WORLD POS</dt><dd>(${camera.position.x.toFixed(3)}, ${camera.position.y.toFixed(3)}, ${camera.position.z.toFixed(3)})</dd>
    <dt>CAMERA QUAT</dt><dd>${cameraQStr}</dd>
    <dt>CONTROLS TARGET</dt><dd>(${controls.target.x.toFixed(1)}, ${controls.target.y.toFixed(1)}, ${controls.target.z.toFixed(1)})</dd>
    <dt>DEVICE LAT / LON</dt><dd>${devLatStr} / ${devLonStr}</dd>
    <dt>GREENWICH SCREEN X/Y</dt><dd>${probeText('GREENWICH')}</dd>
    <dt>INDIA SCREEN X/Y</dt><dd>${probeText('INDIA')}</dd>
    <dt>JAPAN SCREEN X/Y</dt><dd>${probeText('JAPAN')}</dd>
    <div class="debug-divider"></div>
    <dt>SAT CATALOG COUNT</dt><dd>${catalogCount.toLocaleString()}</dd>
    <dt>SAT VALID / PROPAGATED</dt><dd>${orbiters.length.toLocaleString()} / ${satGlyphsMesh.count.toLocaleString()}</dd>
    <dt>SAT GLYPHS</dt><dd>${showSatellites ? satGlyphsMesh.count.toLocaleString() : '0'}</dd>
    <dt>SAT LABELS</dt><dd>${visibleLabels.toLocaleString()} TOTAL</dd>
    <dt>SAT HIT</dt><dd>${escapeHtml(lastHitSatName)} [ID:${lastHitSatInstanceId}]</dd>
    <dt>SAT SELECTED ID</dt><dd>${escapeHtml(selectedSatName)}</dd>
    <div class="debug-divider"></div>
    <dt>AIR API STATES</dt><dd>${aircraftApiRawCount.toLocaleString()}</dd>
    <dt>AIR GLYPHS</dt><dd>${detailedAir} TIER-B · ${microAir} TIER-A</dd>
    <dt>AIR TRAILS</dt><dd>${Math.floor(aircraftTrailGeometry.drawRange.count / 2)}</dd>
    <dt>AIR 5S SCREEN DELTA</dt><dd>${aircraftMotionProbe?.deltaPx?.toFixed(2) ?? 'sampling'} px</dd>
    <dt>AIR HIT</dt><dd>${escapeHtml(lastHitAirCallsign)} [${lastHitAirTier}:${lastHitAirInstanceId}]</dd>
    <dt>AIR SELECTED ICAO24</dt><dd>${escapeHtml(selectedAirIcao.toUpperCase())}</dd>
    <dt>AIR OBS AGE</dt><dd>${airObsAgeStr}</dd>
    <dt>AIR PHYS PREDICTED</dt><dd>${airPhysPredStr}</dd>
    <dt>AIR DISP PREDICTED</dt><dd>${airDispPredStr}</dd>
    <dt>AIR VISUAL LEAD</dt><dd>${airLeadSecStr}</dd>
    <dt>AIR TRUTH/DISP DIST</dt><dd>${airTruthDistStr}</dd>
    <dt>AIR SCREEN VELOCITY</dt><dd>${airScreenSpeedStr}</dd>
    <dt>AIR HEADING</dt><dd>${airHeadingStr}</dd>
    <dt>AIR LABELS</dt><dd>${visibleLabels.toLocaleString()} PLACED</dd>
    <dt>HOVER TYPE / ID</dt><dd>${hoveredIcao ? `AIRCRAFT / ${escapeHtml(hoveredIcao)}` : hoveredSatelliteNorad ? `SATELLITE / ${escapeHtml(hoveredSatelliteNorad)}` : 'NONE'}</dd>
    <dt>SELECTED TYPE / ID</dt><dd>${selectedAircraftIcao ? `AIRCRAFT / ${escapeHtml(selectedAircraftIcao)}` : selectedSatelliteNorad ? `SATELLITE / ${escapeHtml(selectedSatelliteNorad)}` : 'NONE'}</dd>
    <dt>TRACKING</dt><dd>${cameraMode === 'TRACKING' ? 'YES' : 'NO'}</dd>
    <dt>LAST PICK DISTANCE</dt><dd>${lastPickDistancePx === null ? '—' : `${lastPickDistancePx.toFixed(1)} px`}</dd>
    <dt>SAT 5S SCREEN DELTA</dt><dd>${satelliteMotionProbe?.deltaPx?.toFixed(2) ?? 'sampling'} px</dd>
  `;
}

// Screen-space picking is deterministic for tiny glyphs and independent of
// temporary instanced-mesh slots. Candidates are rebuilt after every LOD pass.
let lastPickDistancePx: number | null = null;
function nearestCandidate(event: PointerEvent) {
  const candidates: Array<{ type: 'aircraft' | 'satellite'; value: ScreenCandidate; radius: number }> = [];
  if (showAircraft) aircraftScreenCandidates.forEach((value) => candidates.push({ type: 'aircraft', value, radius: 15 }));
  if (showSatellites) satelliteScreenCandidates.forEach((value) => candidates.push({ type: 'satellite', value, radius: 13 }));
  let best: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    const distancePx = Math.hypot(event.clientX - candidate.value.x, event.clientY - candidate.value.y);
    if (distancePx <= candidate.radius && (!best || distancePx < best.value.distancePx)) {
      candidate.value.distancePx = distancePx;
      best = candidate;
    }
  }
  lastPickDistancePx = best?.value.distancePx ?? null;
  return best;
}

function clearSelection() {
  selectedSatelliteIndex = -1;
  selectedSatelliteNorad = null;
  selectedAircraftIndex = -1;
  selectedAircraftIcao = null;
  isTrackingAircraft = false;
  cameraMode = 'MANUAL';
  selectedSatHalo.visible = selectedSatGlyph.visible = false;
  selectedAircraftGlyph.visible = selectedAircraftHalo.visible = false;
  clearOrbit();
  $('#inspector').hidden = true;
  $('#status-drawer').style.opacity = '1';
}

canvas.addEventListener('pointermove', (event) => {
  const hit = nearestCandidate(event);
  const tooltipEl = $('#hover-tooltip');
  hoveredIcao = null;
  hoveredSatelliteNorad = null;
  if (!hit) { tooltipEl.hidden = true; return; }
  tooltipEl.hidden = false;
  tooltipEl.style.left = `${event.clientX}px`;
  tooltipEl.style.top = `${event.clientY}px`;
  if (hit.type === 'aircraft') {
    const motion = aircraft[hit.value.index];
    if (!motion) return;
    hoveredIcao = motion.truth.icao24;
    lastHitAirCallsign = (motion.truth.callsign || motion.truth.icao24).trim();
    lastHitAirTier = motion.lodTier;
    lastHitAirInstanceId = motion.truth.icao24;
    tooltipEl.innerHTML = `<div class="title">${escapeHtml(lastHitAirCallsign)}</div><div class="meta">ALT ${(motion.altitude / 1000).toFixed(1)} km · SPEED ${Math.round(motion.velocity)} m/s</div>`;
  } else {
    const orbiter = orbiters[hit.value.index];
    if (!orbiter) return;
    hoveredSatelliteNorad = orbiter.norad;
    lastHitSatName = orbiter.name;
    lastHitSatInstanceId = orbiter.norad;
    tooltipEl.innerHTML = `<div class="title">${escapeHtml(orbiter.name)}</div><div class="meta">NORAD ${escapeHtml(orbiter.norad)}</div>`;
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) > 6) return;
  const hit = nearestCandidate(event);
  if (!hit) { clearSelection(); return; }
  $('#hover-tooltip').hidden = true;
  if (hit.type === 'aircraft') {
    hoveredIcao = null;
    selectAircraft(hit.value.index);
  } else {
    hoveredSatelliteNorad = null;
    selectSatellite(hit.value.index);
  }
});

// Control Handlers
document.querySelectorAll<HTMLButtonElement>('.earth-rate-btn').forEach((button) => {
  button.addEventListener('click', () => {
    const scaleValue = Number(button.dataset.earthRate);
    if (scaleValue === 1 || scaleValue === 60 || scaleValue === 240) {
      setEarthTimeScale(scaleValue);
    }
  });
});
updateEarthRateControl();

$('#locate').addEventListener('click', locate);

$('#toggle-satellites').addEventListener('click', (event) => {
  showSatellites = !showSatellites;
  satGlyphsMesh.visible = showSatellites;
  satelliteGlyphs.visible = showSatellites;
  const btn = event.currentTarget as HTMLButtonElement;
  btn.setAttribute('aria-pressed', String(showSatellites));
  btn.classList.toggle('active', showSatellites);
  if (!showSatellites && selectedSatelliteIndex >= 0) {
    selectedSatelliteIndex = -1;
    selectedSatelliteNorad = null;
    selectedSatHalo.visible = false;
    selectedSatGlyph.visible = false;
    clearOrbit();
    $('#inspector').hidden = true;
  }
  updateStatuses(new Date());
});

$('#toggle-aircraft').addEventListener('click', (event) => {
  showAircraft = !showAircraft;
  aircraftMarkersTierB.visible = showAircraft;
  aircraftMarkersTierA.visible = showAircraft;
  aircraftTrails.visible = showAircraft;
  const btn = event.currentTarget as HTMLButtonElement;
  btn.setAttribute('aria-pressed', String(showAircraft));
  btn.classList.toggle('active', showAircraft);
  if (!showAircraft) {
    clearAircraftData();
    if (selectedAircraftIndex >= 0) {
      selectedAircraftIndex = -1;
      isTrackingAircraft = false;
      cameraMode = 'MANUAL';
      selectedAircraftGlyph.visible = false;
      selectedAircraftHalo.visible = false;
      $('#inspector').hidden = true;
    }
  } else {
    scheduleVisibleRegionFetches();
  }
  updateStatuses(new Date());
});

$('#reset-view').addEventListener('click', () => {
  setManualCameraMode();
  camera.position.set(15.5, 10.0, 16.5);
  controls.target.set(0, 0, 0);
  controls.update();
});

$('#about').addEventListener('click', () => {
  $('#about-panel').hidden = false;
});

$('#close-about').addEventListener('click', () => {
  $('#about-panel').hidden = true;
});

$('#close-debug').addEventListener('click', () => {
  $('#motion-debug-panel').hidden = true;
});

// Keyboard Diagnostics Overlay ('M' or 'D' Key)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearSelection();
    return;
  }
  if (e.key.toLowerCase() === 'm' || e.key.toLowerCase() === 'd') {
    const panel = $('#motion-debug-panel');
    panel.hidden = !panel.hidden;
    updateMotionDebugPanel();
  }
});

// Geolocation Observer Logic
function locate() {
  if (!navigator.geolocation) {
    $('#observer-status').textContent = 'UNSUPPORTED';
    return;
  }
  $('#observer-status').textContent = 'GEOLOCATING...';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      deviceLat = lat;
      deviceLon = lon;

      const localPos = latLonToVector3(lat, lon, earthRadius + 0.008);

      if (!observerGroup) {
        observerGroup = new THREE.Group();
        // Normalized unit sphere (diameter 1.0, radius 0.5)
        const coreGeo = new THREE.SphereGeometry(0.5, 16, 16);
        observerCoreMaterial = new THREE.MeshBasicMaterial({ color: 0x6be0ff, depthWrite: false });
        observerGroup.add(new THREE.Mesh(coreGeo, observerCoreMaterial));

        // Normalized unit ring (diameter 1.0, radius 0.5)
        const pulseGeo = new THREE.RingGeometry(0.35, 0.5, 32);
        observerPulseMaterial = new THREE.MeshBasicMaterial({ color: 0x6be0ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
        observerPulse = new THREE.Mesh(pulseGeo, observerPulseMaterial);
        observerGroup.add(observerPulse);

        earth.add(observerGroup);
      }

      observerGroup.position.copy(localPos);
      observerPulseStartedAt = Date.now() / 1000;
      observerLabelExpiresAt = Date.now() / 1000 + 6.0;

      earth.updateWorldMatrix(true, false);
      observerWorldPos = localPos.clone().applyMatrix4(earth.matrixWorld);

      const surfaceNormal = observerWorldPos.clone().normalize();
      const targetCamPos = surfaceNormal.multiplyScalar(9.0);

      cameraMode = 'LOCATING';
      controls.enabled = false;
      locateAnim = {
        startCamPos: camera.position.clone(),
        targetCamPos,
        startTime: performance.now(),
        duration: 1800,
      };

      $('#observer-status').textContent = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
      $('#observer-meta').textContent = 'LOCAL BEACON ACTIVE';
    },
    () => {
      $('#observer-status').textContent = 'ACCESS DENIED';
    }
  );
}

function updateObserverBeacon(nowSeconds: number) {
  if (!observerGroup || !observerPulse || !observerPulseMaterial) return;

  const cameraDistance = camera.position.distanceTo(controls.target);
  const viewportHeight = window.innerHeight;
  const overlaySizes = getUnifiedOverlaySizes(cameraDistance);

  earth.updateWorldMatrix(true, false);
  const worldPos = observerGroup.position.clone().applyMatrix4(earth.matrixWorld);
  observerWorldPos = worldPos;
  const distToCam = camera.position.distanceTo(worldPos);

  // 1. Precise Core Scaling in Screen Space (Normalized geometry radius 0.5)
  const coreScale = getWorldScaleForPixelSize(camera, distToCam, overlaySizes.observerCore, viewportHeight);
  if (observerGroup.children[0]) {
    observerGroup.children[0].scale.setScalar(coreScale);
  }

  // 2. Precise Screen-Space Pulse Expansion (1.8x -> 2.3x core)
  const pulseAge = nowSeconds - observerPulseStartedAt;
  const cycle = (pulseAge % 2.4) / 2.4;
  const currentPulsePx = THREE.MathUtils.lerp(overlaySizes.observerPulseMin, overlaySizes.observerPulseMax, cycle);
  const pulseScale = getWorldScaleForPixelSize(camera, distToCam, currentPulsePx, viewportHeight);
  observerPulse.scale.setScalar(pulseScale);
  observerPulseMaterial.opacity = (1.0 - cycle) * 0.16;
  observerPulse.lookAt(camera.position);
}

// Master Animation Frame Loop
let lastStatusUpdate = 0;
let frameCount = 0;
let lastFpsTime = performance.now();
let currentFps = 60;

function render(now: number) {
  const nowDate = new Date();
  const nowSeconds = now / 1000;

  // Track FPS accurately
  frameCount++;
  if (now - lastFpsTime >= 1000) {
    currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    frameCount = 0;
    lastFpsTime = now;
  }

  // 1. Authoritative Earth Orientation Update at top of frame loop
  const earthOrientationDate = new Date(earthSimulationTimeMs(nowDate.getTime()));
  updateEarthOrientation(earthOrientationDate);

  // 2. Camera animation slerp (if locating)
  if (cameraMode === 'LOCATING' && locateAnim) {
    const elapsed = performance.now() - locateAnim.startTime;
    const progress = Math.min(1.0, elapsed / locateAnim.duration);
    const ease = 1 - Math.pow(1 - progress, 3);

    const startDir = locateAnim.startCamPos.clone().normalize();
    const targetDir = locateAnim.targetCamPos.clone().normalize();
    const startDist = locateAnim.startCamPos.length();
    const targetDist = locateAnim.targetCamPos.length();

    const qStart = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), startDir);
    const qTarget = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetDir);
    const currentQ = qStart.clone().slerp(qTarget, ease);
    const currentDir = new THREE.Vector3(0, 0, 1).applyQuaternion(currentQ);
    const currentDist = THREE.MathUtils.lerp(startDist, targetDist, ease);

    camera.position.copy(currentDir.multiplyScalar(currentDist));
    controls.target.set(0, 0, 0);

    if (progress >= 1.0) {
      cameraMode = 'MANUAL';
      locateAnim = null;
      controls.enabled = true;
    }
  }

  // 3. Object & Beacon Updates
  updateSatellites();
  updateAircraftPositions();
  updateLandmarkProbes(nowDate.getTime() / 1000);
  updateMotionProbes(nowDate.getTime() / 1000);
  updateObserverBeacon(nowSeconds);
  checkCameraMovement();

  // 4. Status & Telemetry Refresh
  if (now - lastStatusUpdate > 500) {
    updateStatuses(nowDate);
    lastStatusUpdate = now;
  }

  // 5. Selected Satellite Halo Alignment
  selectedSatHalo.lookAt(camera.position);
  selectedSatGlyph.lookAt(camera.position);

  // 6. Astronomical Reference Instrument Zoom Fading
  const cameraDist = camera.position.distanceTo(controls.target);
  const eclipticZoomFactor = THREE.MathUtils.clamp((cameraDist - 7.0) / (15.0 - 7.0), 0, 1);
  const tiltZoomFactor = THREE.MathUtils.clamp((cameraDist - 5.5) / (12.0 - 5.5), 0, 1);
  const axisZoomFactor = THREE.MathUtils.clamp((cameraDist - 4.5) / (10.0 - 4.5), 0.15, 1);

  eclipticRingMat.opacity = 0.08 * eclipticZoomFactor;
  eclipticRingLine.visible = eclipticRingMat.opacity > 0.005;

  eclipticNormalMat.opacity = 0.20 * tiltZoomFactor;
  tiltMat.opacity = 0.28 * tiltZoomFactor;
  tiltArcLine.visible = tiltMat.opacity > 0.005;
  eclipticNormalLine.visible = eclipticNormalMat.opacity > 0.005;

  axisMat.opacity = 0.24 * axisZoomFactor;
  axisLine.visible = axisMat.opacity > 0.005;

  // 7. Screen-Space DOM Label Overlay
  updateDomLabels(cameraDist);

  // 8. Adaptive sensitivity and controls update
  const { rotateSpeed, dampingFactor } = computeAdaptiveControlsSensitivity(cameraDist);
  controls.rotateSpeed = rotateSpeed;
  controls.dampingFactor = dampingFactor;
  controls.update();

  // 9. Master Render Call
  renderer.render(scene, camera);
  $('#utc').textContent = utc(nowDate);
}

// Initial Data Fetching & Polling
scheduleVisibleRegionFetches();
loadSatellites();

window.setInterval(scheduleVisibleRegionFetches, 25000);
window.setInterval(loadSatellites, 2 * 60 * 60 * 1000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
