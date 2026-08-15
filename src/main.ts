import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as satellite from 'satellite.js';
import { injectSpeedInsights } from '@vercel/speed-insights';
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
import { calculateSolarState, verifySolarEphemeris } from './scene/solarEphemeris';
import type { SolarState } from './scene/solarEphemeris';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import './style.css';
import './status.css';

// Initialize Vercel Speed Insights
injectSpeedInsights();

// Automated Kinematic Verification Check
const verificationResult = verifyMotionMath();
console.log('[VECTOR MOTION ENGINE VERIFICATION]', verificationResult.log.join(' | '));

// Automated Solar Ephemeris Astronomical Verification Check
const solarVerification = verifySolarEphemeris();
console.log(
  '[VECTOR SOLAR EPHEMERIS VERIFICATION]',
  solarVerification.passed ? 'PASSED (EQUINOX/SOLSTICE/LENGTH/BOUNDS)' : 'FAILED',
  solarVerification.results
);

// DOM Selectors & Scale Constants
const canvas = document.querySelector<HTMLCanvasElement>('#vector-canvas')!;
const labelsContainer = document.querySelector<HTMLElement>('#labels-container')!;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

type RenderQuality = 'DESKTOP_HIGH' | 'DESKTOP_BALANCED' | 'MOBILE';
const coarsePointerMedia = window.matchMedia('(pointer: coarse)');
function detectRenderQuality(): RenderQuality {
  const smallViewport = Math.min(window.innerWidth, window.innerHeight) < 680;
  const limitedCpu = (navigator.hardwareConcurrency ?? 8) <= 4;
  if (coarsePointerMedia.matches && (smallViewport || window.devicePixelRatio >= 2)) return 'MOBILE';
  return limitedCpu || window.devicePixelRatio > 1.8 ? 'DESKTOP_BALANCED' : 'DESKTOP_HIGH';
}
let renderQuality = detectRenderQuality();
const isCoarsePointer = () => coarsePointerMedia.matches;

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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderQuality === 'MOBILE' ? 1.35 : renderQuality === 'DESKTOP_BALANCED' ? 1.5 : 1.7));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setAnimationLoop(render);

// OrbitControls setup: minDistance = 4.6 allows regional/local zoom down to ~950 km altitude!
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 4.6;
controls.maxDistance = 38.0;
controls.target.set(0, 0, 0);
if (isCoarsePointer()) {
  controls.enablePan = false;
  controls.zoomSpeed = 0.72;
  controls.rotateSpeed = 0.48;
  canvas.style.touchAction = 'none';
}

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

  if (isCoarsePointer()) {
    return { rotateSpeed: rotateSpeed * 0.58, dampingFactor: Math.max(dampingFactor, 0.085) };
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
const starCount = renderQuality === 'MOBILE' ? 360 : renderQuality === 'DESKTOP_BALANCED' ? 650 : 1000;
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

// Refined Earth Core Sphere Shader (Physically tied to astronomical Sun direction, narrow terminator, subtle atmosphere limb)
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

      float NdotSun = dot(normal, sunDir);
      float dayFactor = smoothstep(-0.06, 0.08, NdotSun);

      vec3 deepOcean = vec3(0.011, 0.030, 0.054);
      vec3 landGlow = vec3(0.038, 0.082, 0.124);
      vec3 baseColor = mix(deepOcean, landGlow, 0.22);

      float NdotL = max(0.0, NdotSun);
      vec3 dayColor = baseColor * (0.58 + 0.62 * NdotL);
      vec3 nightColor = deepOcean * 0.09;
      vec3 color = mix(nightColor, dayColor, dayFactor);

      // Sun-aware atmosphere limb
      float fresnel = pow(1.0 - max(0.0, dot(viewDir, normal)), 4.5);
      float atmoSunFactor = smoothstep(-0.10, 0.12, NdotSun);
      vec3 atmosphereGlow = vec3(0.26, 0.48, 0.66) * fresnel * (0.04 + 0.26 * atmoSunFactor) * 0.95;

      gl_FragColor = vec4(color + atmosphereGlow, 1.0);
    }
  `,
  uniforms: {
    uSunDirection: { value: new THREE.Vector3(0, 0, 1) },
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

// Fat-Line Material Registry for Responsive Viewport Updates
const fatLineMaterials: LineMaterial[] = [];
function registerFatLineMaterial<T extends LineMaterial>(mat: T): T {
  mat.resolution.set(window.innerWidth, window.innerHeight);
  fatLineMaterials.push(mat);
  return mat;
}

// Quiet day/night boundary. Illumination is the primary day/night explanation;
// this line is intentionally too subdued to read as a trajectory.
const TERMINATOR_SAMPLES = 96;
const terminatorPositions = new Float32Array((TERMINATOR_SAMPLES + 1) * 3);
const terminatorGeo = new LineGeometry();
terminatorGeo.setPositions(terminatorPositions);
const terminatorMat = registerFatLineMaterial(
  new LineMaterial({
    color: 0x9dc4d8,
    linewidth: 1.0,
    transparent: true,
    opacity: 0.075,
    depthTest: true,
    depthWrite: false,
    dashed: false,
  })
);
const terminatorLine = new Line2(terminatorGeo, terminatorMat);
earth.add(terminatorLine);

// Real UTC subsolar ground track: geographic samples from the solar ephemeris,
// not a latitude circle.  It is Earth-fixed only while the Earth display is real-time.
const SOLAR_TRACK_STEP_MS = 10 * 60 * 1000;
const SOLAR_TRACK_HALF_WINDOW_MS = 6 * 60 * 60 * 1000;
const SOLAR_TRACK_SAMPLE_COUNT = (SOLAR_TRACK_HALF_WINDOW_MS * 2) / SOLAR_TRACK_STEP_MS + 1;
const solarTrackPositions = new Float32Array(SOLAR_TRACK_SAMPLE_COUNT * 3);
const solarTrackColors = new Float32Array(SOLAR_TRACK_SAMPLE_COUNT * 3);
const solarTrackGeo = new THREE.BufferGeometry();
solarTrackGeo.setAttribute('position', new THREE.BufferAttribute(solarTrackPositions, 3));
solarTrackGeo.setAttribute('color', new THREE.BufferAttribute(solarTrackColors, 3));
const solarTrackPoints = new THREE.Points(
  solarTrackGeo,
  new THREE.PointsMaterial({
    size: 3.0,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    depthTest: true,
  })
);
solarTrackPoints.renderOrder = 2;
earth.add(solarTrackPoints);

const solarTrackCurrentPositions = new Float32Array(5 * 3);
const solarTrackCurrentGeo = new LineGeometry();
solarTrackCurrentGeo.setPositions(solarTrackCurrentPositions);
const solarTrackCurrentMat = registerFatLineMaterial(
  new LineMaterial({
    color: 0xc3effa,
    linewidth: 1.45,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    depthTest: true,
    dashed: false,
  })
);
const solarTrackCurrentLine = new Line2(solarTrackCurrentGeo, solarTrackCurrentMat);
earth.add(solarTrackCurrentLine);
const solarTrackGroup = new THREE.Group();
solarTrackGroup.add(solarTrackPoints, solarTrackCurrentLine);
earth.add(solarTrackGroup);

// A deliberately small point: the Sun is directly overhead here now.
const subsolarMarkerGeo = new THREE.BufferGeometry();
subsolarMarkerGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
const subsolarMarkerMat = new THREE.PointsMaterial({
  color: 0xd6f7ff,
  size: 4.5,
  sizeAttenuation: false,
  transparent: true,
  opacity: 0.88,
  depthTest: true,
  depthWrite: false,
});
const subsolarMarker = new THREE.Points(subsolarMarkerGeo, subsolarMarkerMat);
subsolarMarker.renderOrder = 3;
earth.add(subsolarMarker);

// Authoritative Solar State Manager
let currentSolarState: SolarState = calculateSolarState(Date.now());
const currentSunWorldDirection = new THREE.Vector3(0, 0, 1);
let lastSolarEphemerisUpdateMs = 0;
let lastSolarTrackUpdateMs = 0;

const solarEarthInv = new THREE.Matrix4();
const solarLocalSun = new THREE.Vector3();
const solarBasisU = new THREE.Vector3();
const solarBasisV = new THREE.Vector3();
const solarRefAxis = new THREE.Vector3();
const solarTrackScratch = new THREE.Vector3();

function updateSolarGroundTrack(realUtcMs: number) {
  if (realUtcMs - lastSolarTrackUpdateMs < 5 * 60 * 1000 && lastSolarTrackUpdateMs !== 0) return;
  lastSolarTrackUpdateMs = realUtcMs;

  for (let index = 0; index < SOLAR_TRACK_SAMPLE_COUNT; index++) {
    const offsetMs = index * SOLAR_TRACK_STEP_MS - SOLAR_TRACK_HALF_WINDOW_MS;
    const state = calculateSolarState(realUtcMs + offsetMs);
    latLonToVector3(state.subsolarLatitudeDeg, state.subsolarLongitudeDeg, earthRadius + 0.012, solarTrackScratch);
    const offset = index * 3;
    solarTrackPositions[offset] = solarTrackScratch.x;
    solarTrackPositions[offset + 1] = solarTrackScratch.y;
    solarTrackPositions[offset + 2] = solarTrackScratch.z;

    const currentWeight = Math.max(0, 1 - Math.abs(offsetMs) / (2 * SOLAR_TRACK_STEP_MS));
    const future = offsetMs > 0;
    solarTrackColors[offset] = future ? 0.31 : 0.38;
    solarTrackColors[offset + 1] = future ? 0.59 : 0.67;
    solarTrackColors[offset + 2] = future ? 0.67 : 0.76;
    solarTrackColors[offset] += currentWeight * 0.42;
    solarTrackColors[offset + 1] += currentWeight * 0.31;
    solarTrackColors[offset + 2] += currentWeight * 0.22;
  }
  solarTrackGeo.attributes.position.needsUpdate = true;
  solarTrackGeo.attributes.color.needsUpdate = true;

  for (let index = 0; index < 5; index++) {
    const offsetMs = (index - 2) * SOLAR_TRACK_STEP_MS;
    const state = calculateSolarState(realUtcMs + offsetMs);
    latLonToVector3(state.subsolarLatitudeDeg, state.subsolarLongitudeDeg, earthRadius + 0.015, solarTrackScratch);
    solarTrackCurrentPositions[index * 3] = solarTrackScratch.x;
    solarTrackCurrentPositions[index * 3 + 1] = solarTrackScratch.y;
    solarTrackCurrentPositions[index * 3 + 2] = solarTrackScratch.z;
  }
  solarTrackCurrentGeo.setPositions(solarTrackCurrentPositions);
}

function updateSolarSystem(realUtcDate: Date, cameraDist: number) {
  const realUtcMs = realUtcDate.getTime();
  if (realUtcMs - lastSolarEphemerisUpdateMs >= 2000 || lastSolarEphemerisUpdateMs === 0) {
    currentSolarState = calculateSolarState(realUtcMs);
    lastSolarEphemerisUpdateMs = realUtcMs;
  }

  // 1. Map equatorial solar vector to world coordinates via equatorialFrame
  equatorialFrame.updateWorldMatrix(true, false);
  currentSunWorldDirection
    .copy(currentSolarState.directionEquatorial)
    .transformDirection(equatorialFrame.matrixWorld)
    .normalize();
  (globeMaterial.uniforms.uSunDirection.value as THREE.Vector3).copy(currentSunWorldDirection);

  // 2. Update geometric terminator great circle in Earth-local coordinates
  solarEarthInv.copy(earth.matrixWorld).invert();
  solarLocalSun.copy(currentSunWorldDirection).transformDirection(solarEarthInv).normalize();

  if (Math.abs(solarLocalSun.y) < 0.99) {
    solarRefAxis.set(0, 1, 0);
  } else {
    solarRefAxis.set(1, 0, 0);
  }
  solarBasisU.crossVectors(solarRefAxis, solarLocalSun).normalize();
  solarBasisV.crossVectors(solarLocalSun, solarBasisU).normalize();

  const r = earthRadius + 0.004;
  for (let i = 0; i <= TERMINATOR_SAMPLES; i++) {
    const theta = (i / TERMINATOR_SAMPLES) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    terminatorPositions[i * 3] = (solarBasisU.x * cosT + solarBasisV.x * sinT) * r;
    terminatorPositions[i * 3 + 1] = (solarBasisU.y * cosT + solarBasisV.y * sinT) * r;
    terminatorPositions[i * 3 + 2] = (solarBasisU.z * cosT + solarBasisV.z * sinT) * r;
  }
  terminatorGeo.setPositions(terminatorPositions);

  // Zoom-aware terminator line opacity reduction at close zoom
  const terminatorZoomFactor = THREE.MathUtils.clamp((cameraDist - 4.6) / (7.0 - 4.6), 0.70, 1.0);
  terminatorMat.opacity = 0.075 * terminatorZoomFactor;

  // 3. Update subsolar marker position & zoom-adaptive fading directly from solarLocalSun
  subsolarMarker.position.copy(solarLocalSun).multiplyScalar(earthRadius + 0.014);
  const subsolarZoomFactor = THREE.MathUtils.clamp((cameraDist - 4.8) / (7.0 - 4.8), 0.35, 1);
  subsolarMarkerMat.opacity = (0.76 + Math.sin(realUtcMs / 2200) * 0.12) * subsolarZoomFactor;
  subsolarMarker.visible = subsolarMarkerMat.opacity > 0.01;

  // Geographic longitude/latitude truth is only registered with geography at 1×.
  // At accelerated visual Earth rates the marker remains correctly aligned with
  // the displayed illumination, while the Earth-fixed historical/future track hides.
  const geographicTrackIsTruthfullyRegistered = earthTimeScale === 1 && !earthRealtimeReconciliation;
  solarTrackGroup.visible = geographicTrackIsTruthfullyRegistered;
  if (geographicTrackIsTruthfullyRegistered) updateSolarGroundTrack(realUtcMs);
}

// Restrained Astronomical Reference Instrument
const instrumentGroup = new THREE.Group();

// 1. Hairline Polar Rotation Axis with Clean Terminal Ticks (Reference Axis Language: Solid Line, 1.6 px)
const axisMat = registerFatLineMaterial(
  new LineMaterial({
    color: 0x9ad0ea,
    linewidth: 1.6,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    dashed: false,
  })
);
const axisShaftGeo = new LineGeometry();
axisShaftGeo.setPositions([0, -4.40, 0, 0, 4.40, 0]);
const axisNorthGeo = new LineGeometry();
axisNorthGeo.setPositions([-0.03, 4.40, 0, 0.03, 4.40, 0]);
const axisSouthGeo = new LineGeometry();
axisSouthGeo.setPositions([-0.03, -4.40, 0, 0.03, -4.40, 0]);

const axisLine = new THREE.Group();
axisLine.add(new Line2(axisShaftGeo, axisMat));
axisLine.add(new Line2(axisNorthGeo, axisMat));
axisLine.add(new Line2(axisSouthGeo, axisMat));
instrumentGroup.add(axisLine);

// 2. Subtle Ecliptic Reference Plane Ring (Construction/Plane Language: Very Long Dash + Large Gap, 0.9 px)
const eclipticRingFlatPtsFull: number[] = [];
for (let i = 0; i <= 128; i++) {
  const theta = (i / 128) * Math.PI * 2;
  const r = 4.28;
  const v = new THREE.Vector3(r * Math.cos(theta), 0, r * Math.sin(theta));
  v.applyAxisAngle(new THREE.Vector3(0, 0, 1), obliquity);
  eclipticRingFlatPtsFull.push(v.x, v.y, v.z);
}
const eclipticRingGeo = new LineGeometry();
eclipticRingGeo.setPositions(eclipticRingFlatPtsFull);
const eclipticRingMat = registerFatLineMaterial(
  new LineMaterial({
    color: 0x325262,
    linewidth: 0.9,
    transparent: true,
    opacity: 0.09,
    dashed: true,
    dashScale: 1.0,
    dashSize: 0.60,
    gapSize: 0.40,
    depthWrite: false,
  })
);
const eclipticRingLine = new Line2(eclipticRingGeo, eclipticRingMat);
eclipticRingLine.computeLineDistances();
instrumentGroup.add(eclipticRingLine);

// 3. Short Local Ecliptic Normal Guide & 23.44° Axial Tilt Arc
const eclipticNorm = new THREE.Vector3(-Math.sin(obliquity), Math.cos(obliquity), 0).normalize();
const eclNormStart = eclipticNorm.clone().multiplyScalar(4.12);
const eclNormEnd = eclipticNorm.clone().multiplyScalar(4.40);
const eclPerp = new THREE.Vector3(eclipticNorm.y, -eclipticNorm.x, 0).multiplyScalar(0.025);

const eclipticNormalMat = registerFatLineMaterial(
  new LineMaterial({
    color: 0x527e94,
    linewidth: 1.1,
    transparent: true,
    opacity: 0.22,
    dashed: true,
    dashScale: 1.0,
    dashSize: 0.05,
    gapSize: 0.04,
    depthWrite: false,
  })
);
const eclNormGeo = new LineGeometry();
eclNormGeo.setPositions([
  eclNormStart.x, eclNormStart.y, eclNormStart.z,
  eclNormEnd.x, eclNormEnd.y, eclNormEnd.z,
]);
const eclNormTickGeo = new LineGeometry();
eclNormTickGeo.setPositions([
  eclNormEnd.x - eclPerp.x, eclNormEnd.y - eclPerp.y, eclNormEnd.z,
  eclNormEnd.x + eclPerp.x, eclNormEnd.y + eclPerp.y, eclNormEnd.z,
]);
const eclNormShaftLine = new Line2(eclNormGeo, eclipticNormalMat);
eclNormShaftLine.computeLineDistances();
const eclNormTickLine = new Line2(eclNormTickGeo, eclipticNormalMat);
eclNormTickLine.computeLineDistances();

const eclipticNormalLine = new THREE.Group();
eclipticNormalLine.add(eclNormShaftLine);
eclipticNormalLine.add(eclNormTickLine);
instrumentGroup.add(eclipticNormalLine);

// Precision 23.44° Axial Tilt Arc (Measurement Language: Short Dot / Micro-dash Arc, 1.6 px)
const tiltArcFlatPtsFull: number[] = [];
const tiltRadius = 4.28;
for (let i = 0; i <= 24; i++) {
  const angle = (i / 24) * obliquity;
  const x = -tiltRadius * Math.sin(angle);
  const y = tiltRadius * Math.cos(angle);
  tiltArcFlatPtsFull.push(x, y, 0);
}
const tiltGeoFull = new LineGeometry();
tiltGeoFull.setPositions(tiltArcFlatPtsFull);

const tiltMat = registerFatLineMaterial(
  new LineMaterial({
    color: 0xa6e2fc,
    linewidth: 1.6,
    transparent: true,
    opacity: 0.50,
    dashed: true,
    dashScale: 1.0,
    dashSize: 0.035,
    gapSize: 0.045,
    depthWrite: false,
  })
);
const tiltArcLine = new Line2(tiltGeoFull, tiltMat);
tiltArcLine.computeLineDistances();
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

const maxSatellites = 6000;
const satelliteRenderLimit = () => renderQuality === 'MOBILE' ? 1800 : renderQuality === 'DESKTOP_BALANCED' ? 3600 : maxSatellites;

// Explicit Instance-to-Orbiter Mapping Array for 100% Precise Picking
const satInstanceToOrbiterIndex: number[] = [];
type ScreenCandidate = { index: number; id: string; x: number; y: number; distancePx: number };
let satelliteScreenCandidates: ScreenCandidate[] = [];
const satelliteScreenCandidatePool: ScreenCandidate[] = [];

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
let currentSelectedOrbitPoints: THREE.Vector3[] = [];

const _sciVecA = new THREE.Vector3();
const _sciVecB = new THREE.Vector3();
const _sciVecC = new THREE.Vector3();

function toFlatPoints(pts: THREE.Vector3[]): Float32Array {
  const arr = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    arr[i * 3] = pts[i].x;
    arr[i * 3 + 1] = pts[i].y;
    arr[i * 3 + 2] = pts[i].z;
  }
  return arr;
}

function clearOrbit() {
  currentSelectedOrbitPoints = [];
  const orbitLabelEl = document.querySelector<HTMLElement>('#sci-label-orbit');
  if (orbitLabelEl) orbitLabelEl.style.display = 'none';

  if (!orbitLine) return;
  orbitLine.traverse((child) => {
    if (child instanceof Line2 || child instanceof THREE.Line || child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (m instanceof LineMaterial) {
          const idx = fatLineMaterials.indexOf(m);
          if (idx !== -1) fatLineMaterials.splice(idx, 1);
        }
        m?.dispose();
      });
    }
  });
  orbitLine.removeFromParent();
  orbitLine = undefined;
}

// Aircraft Layer State, Instanced Meshes & Explicit Picking Mappings
let showAircraft = true;
const maxAircraft = 1600;
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
const aircraftScreenCandidatePool: ScreenCandidate[] = [];
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
let aircraftFetchController: AbortController | null = null;
let satelliteFetchController: AbortController | null = null;

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
const aircraftWorldTemp = new THREE.Vector3();

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
const satWorldTemp = new THREE.Vector3();
const satCamLocalTemp = new THREE.Vector3();
const satFrameInverseTemp = new THREE.Matrix4();
const satScaleTemp = new THREE.Vector3();
const satScreenTemp = new THREE.Vector2();
const projectionTemp = new THREE.Vector3();
const occlusionDirectionTemp = new THREE.Vector3();
const occlusionClosestTemp = new THREE.Vector3();
const localCameraTemp = new THREE.Vector3();
const subsolarMarkerWorldTemp = new THREE.Vector3();

// Helper Utilities
const eciVector = (value: satellite.EciVec3<number>, target = new THREE.Vector3()) => target.set(value.y * scale, value.z * scale, value.x * scale);
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
  const local = localCameraTemp.copy(camera.position);
  earth.worldToLocal(local).normalize();
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
  const ndc = projectionTemp.copy(world).project(camera);
  target.set((ndc.x * 0.5 + 0.5) * window.innerWidth, (-ndc.y * 0.5 + 0.5) * window.innerHeight);
  return { visible: ndc.z >= -1 && ndc.z <= 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1, ndc };
}

/** True when the segment from camera to a point passes through the globe. */
function isBehindEarth(world: THREE.Vector3) {
  const toPoint = occlusionDirectionTemp.copy(world).sub(camera.position);
  const length = toPoint.length();
  if (length <= 0) return true;
  const direction = toPoint.multiplyScalar(1 / length);
  const closestT = THREE.MathUtils.clamp(-camera.position.dot(direction), 0, length);
  return occlusionClosestTemp.copy(camera.position).addScaledVector(direction, closestT).length() < earthRadius - 0.002;
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
  aircraftScreenCandidates.length = 0;

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
      motion.visualHeading,
      motion.screenPos
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
    const worldPosition = aircraftWorldTemp.copy(motion.displayPosition).applyMatrix4(earth.matrixWorld);
    const projected = projectWorldPosition(worldPosition, motion.screenPos);
    motion.inFrustum = projected.visible && !isBehindEarth(worldPosition);
    motion.facingCamera = !isBehindEarth(worldPosition);

    if (motion.inFrustum) {
      const candidate = aircraftScreenCandidatePool[aircraftScreenCandidates.length] ?? { index, id: truth.icao24, x: 0, y: 0, distancePx: 0 };
      candidate.index = index;
      candidate.id = truth.icao24;
      candidate.x = motion.screenPos.x;
      candidate.y = motion.screenPos.y;
      candidate.distancePx = 0;
      if (!aircraftScreenCandidatePool[aircraftScreenCandidates.length]) aircraftScreenCandidatePool.push(candidate);
      aircraftScreenCandidates.push(candidate);
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
    const worldPos = aircraftWorldTemp.copy(motion.displayPosition).applyMatrix4(earth.matrixWorld);
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

let lastDomLabelUpdateMs = 0;
// Callsign, Satellite Name, Cartographic Country & Scientific Line Annotation DOM Manager
function updateDomLabels(cameraDistance: number) {
  const nowMs = performance.now();
  const cadenceMs = renderQuality === 'MOBILE' ? 180 : renderQuality === 'DESKTOP_BALANCED' ? 120 : 80;
  if (nowMs - lastDomLabelUpdateMs < cadenceMs) return;
  lastDomLabelUpdateMs = nowMs;
  labelCollisionManager.reset();
  let poolIdx = 0;
  const overlaySizes = getUnifiedOverlaySizes(cameraDistance);
  const camDir = camera.position.clone().sub(controls.target).normalize();
  equatorialFrame.updateWorldMatrix(true, false);
  earth.updateWorldMatrix(true, false);

  // =========================================================================
  // PRIORITY 1: Selected Aircraft & Selected Satellite Primary Labels
  // =========================================================================

  // 1A. Selected/Hovered Aircraft Callsign
  if (showAircraft && selectedAircraftIndex >= 0 && aircraft[selectedAircraftIndex]) {
    const motion = aircraft[selectedAircraftIndex];
    if (motion.opacity > 0 && motion.inFrustum && motion.facingCamera) {
      const callsign = (motion.truth.callsign || motion.truth.icao24).trim();
      const flAlt = `FL${Math.round(motion.altitude / 304.8)}`;
      const speedMps = `${Math.round(motion.velocity)} m/s`;
      const widthEstimate = callsign.length * 6.5 + 14;
      const heightEstimate = 26;

      if (labelCollisionManager.tryPlaceLabel(motion.screenPos.x, motion.screenPos.y, widthEstimate, heightEstimate, true)) {
        let labelEl = domLabelPool[poolIdx];
        if (!labelEl) {
          labelEl = document.createElement('div');
          labelEl.className = 'aircraft-label selected-label';
          labelsContainer.appendChild(labelEl);
          domLabelPool.push(labelEl);
        }
        labelEl.className = 'aircraft-label selected-label';
        labelEl.style.display = 'block';
        labelEl.style.left = `${motion.screenPos.x}px`;
        labelEl.style.top = `${motion.screenPos.y}px`;
        labelEl.style.opacity = '1.0';
        labelEl.innerHTML = `<div class="callsign">${escapeHtml(callsign)}</div><div class="subtext">${flAlt} · ${speedMps}</div>`;
        poolIdx++;
      }
    }
  }

  // 1B. Selected Satellite Name
  if (showSatellites && selectedSatelliteIndex >= 0 && orbiters[selectedSatelliteIndex]) {
    const orbiter = orbiters[selectedSatelliteIndex];
    const propagated = satellite.propagate(orbiter.satrec, new Date());
    if (propagated && propagated.position) {
      const eciPos = eciVector(propagated.position as satellite.EciVec3<number>);
      const worldPos = eciPos.clone().applyMatrix4(equatorialFrame.matrixWorld);
      const screenVec = worldPos.clone().project(camera);
      if (screenVec.z <= 1.0 && worldPos.clone().normalize().dot(camDir) >= 0.1) {
        const screenX = (screenVec.x * 0.5 + 0.5) * window.innerWidth;
        const screenY = (-(screenVec.y * 0.5) + 0.5) * window.innerHeight;
        const nameStr = orbiter.name.trim() || `NORAD ${orbiter.norad}`;
        const widthEstimate = nameStr.length * 6 + 14;

        if (labelCollisionManager.tryPlaceLabel(screenX, screenY, widthEstimate, 16, true)) {
          let labelEl = domLabelPool[poolIdx];
          if (!labelEl) {
            labelEl = document.createElement('div');
            labelEl.className = 'aircraft-label selected-label';
            labelsContainer.appendChild(labelEl);
            domLabelPool.push(labelEl);
          }
          labelEl.className = 'aircraft-label selected-label';
          labelEl.style.display = 'block';
          labelEl.style.left = `${screenX}px`;
          labelEl.style.top = `${screenY}px`;
          labelEl.style.opacity = '1.0';
          labelEl.innerHTML = `<div class="callsign" style="color: #6acbfb;">${escapeHtml(nameStr)}</div>`;
          poolIdx++;
        }
      }
    }
  }

  // =========================================================================
  // PRIORITY 2: Selected Satellite Orbit Annotation (ORBIT · PROPAGATED)
  // =========================================================================
  let orbitLabelEl = document.querySelector<HTMLElement>('#sci-label-orbit');
  if (selectedSatelliteIndex >= 0 && currentSelectedOrbitPoints.length >= 10 && cameraDistance >= 4.6) {
    if (!orbitLabelEl) {
      orbitLabelEl = document.createElement('div');
      orbitLabelEl.id = 'sci-label-orbit';
      orbitLabelEl.className = 'sci-line-label orbit-label';
      orbitLabelEl.textContent = 'ORBIT · PROPAGATED';
      labelsContainer.appendChild(orbitLabelEl);
    }

    const numPoints = currentSelectedOrbitPoints.length;
    const midpoint = Math.floor(numPoints / 2);
    const futureLen = numPoints - 1 - midpoint;
    const fixedIdx = midpoint + Math.max(3, Math.round(futureLen * 0.28));

    const ptA = _sciVecA.copy(currentSelectedOrbitPoints[fixedIdx]).applyMatrix4(equatorialFrame.matrixWorld);
    const isFacing = ptA.clone().normalize().dot(camDir) >= 0.12;
    const isUnoccluded = !isBehindEarth(ptA);

    if (isFacing && isUnoccluded) {
      const sA = new THREE.Vector2();
      const projA = projectWorldPosition(ptA, sA);
      if (projA.visible && sA.x >= 24 && sA.x <= window.innerWidth - 24 && sA.y >= 24 && sA.y <= window.innerHeight - 24) {
        if (labelCollisionManager.tryPlaceLabel(sA.x, sA.y, 115, 13, true)) {
          orbitLabelEl.style.display = 'block';
          orbitLabelEl.style.left = `${sA.x.toFixed(1)}px`;
          orbitLabelEl.style.top = `${sA.y.toFixed(1)}px`;
          orbitLabelEl.style.transform = 'translate(-50%, -50%)';
        } else {
          orbitLabelEl.style.display = 'none';
        }
      } else {
        orbitLabelEl.style.display = 'none';
      }
    } else {
      orbitLabelEl.style.display = 'none';
    }
  } else if (orbitLabelEl) {
    orbitLabelEl.style.display = 'none';
  }

  // =========================================================================
  // PRIORITY 3: Observer Geolocation Coordinates Readout
  // =========================================================================
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

  // =========================================================================
  // PRIORITY 4: 23.44° Axial Tilt Measurement (23.44° TILT)
  // =========================================================================
  let tiltLabelEl = document.querySelector<HTMLElement>('#ref-label-tilt');
  if (cameraDistance >= 8.5) {
    if (!tiltLabelEl) {
      tiltLabelEl = document.createElement('div');
      tiltLabelEl.id = 'ref-label-tilt';
      labelsContainer.appendChild(tiltLabelEl);
    }
    tiltLabelEl.className = 'sci-line-label tilt-label';
    tiltLabelEl.textContent = '23.44° TILT';

    const halfAngle = obliquity * 0.5;
    const tiltWorld = _sciVecA.set(-Math.sin(halfAngle) * 4.46, Math.cos(halfAngle) * 4.46, 0).applyMatrix4(equatorialFrame.matrixWorld);

    if (!isBehindEarth(tiltWorld) && tiltWorld.clone().normalize().dot(camDir) > 0.05) {
      const sPos = new THREE.Vector2();
      const proj = projectWorldPosition(tiltWorld, sPos);
      if (proj.visible && sPos.x > 20 && sPos.x < window.innerWidth - 20 && sPos.y > 20 && sPos.y < window.innerHeight - 20) {
        if (labelCollisionManager.tryPlaceLabel(sPos.x, sPos.y, 68, 12, false)) {
          tiltLabelEl.style.display = 'block';
          tiltLabelEl.style.left = `${sPos.x.toFixed(1)}px`;
          tiltLabelEl.style.top = `${sPos.y.toFixed(1)}px`;
          tiltLabelEl.style.transform = 'translate(-50%, -50%)';
        } else {
          tiltLabelEl.style.display = 'none';
        }
      } else {
        tiltLabelEl.style.display = 'none';
      }
    } else {
      tiltLabelEl.style.display = 'none';
    }
  } else if (tiltLabelEl) {
    tiltLabelEl.style.display = 'none';
  }

  // =========================================================================
  // PRIORITY 5: Rotational Axis Annotation (ROTATION AXIS & N/S Indicators)
  // =========================================================================
  let axisLabelEl = document.querySelector<HTMLElement>('#sci-label-axis');
  let northLabelEl = document.querySelector<HTMLElement>('#ref-label-north');
  let southLabelEl = document.querySelector<HTMLElement>('#ref-label-south');
  if (cameraDistance >= 9.5) {
    if (!axisLabelEl) {
      axisLabelEl = document.createElement('div');
      axisLabelEl.id = 'sci-label-axis';
      axisLabelEl.className = 'sci-line-label axis-label';
      axisLabelEl.textContent = 'ROTATION AXIS';
      labelsContainer.appendChild(axisLabelEl);
    }
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

    const northWorld = _sciVecA.set(0, 4.46, 0).applyMatrix4(equatorialFrame.matrixWorld);
    const northScreen = new THREE.Vector2();
    const northProj = projectWorldPosition(northWorld, northScreen);
    if (northProj.visible && !isBehindEarth(northWorld) && northWorld.clone().normalize().dot(camDir) > 0.05) {
      northLabelEl.style.display = 'block';
      northLabelEl.style.left = `${northScreen.x.toFixed(1)}px`;
      northLabelEl.style.top = `${northScreen.y.toFixed(1)}px`;
      northLabelEl.style.opacity = '0.75';
    } else {
      northLabelEl.style.display = 'none';
    }

    const southWorld = _sciVecB.set(0, -4.46, 0).applyMatrix4(equatorialFrame.matrixWorld);
    const southScreen = new THREE.Vector2();
    const southProj = projectWorldPosition(southWorld, southScreen);
    if (southProj.visible && !isBehindEarth(southWorld) && southWorld.clone().normalize().dot(camDir) > 0.05) {
      southLabelEl.style.display = 'block';
      southLabelEl.style.left = `${southScreen.x.toFixed(1)}px`;
      southLabelEl.style.top = `${southScreen.y.toFixed(1)}px`;
      southLabelEl.style.opacity = '0.75';
    } else {
      southLabelEl.style.display = 'none';
    }

    const shaftTip = !isBehindEarth(northWorld) && northWorld.clone().normalize().dot(camDir) > 0.05 ? northWorld : southWorld;
    const isNorth = shaftTip === northWorld;

    if (!isBehindEarth(shaftTip) && shaftTip.clone().normalize().dot(camDir) > 0.05) {
      const sPos = new THREE.Vector2();
      const proj = projectWorldPosition(shaftTip, sPos);
      if (proj.visible && sPos.x > 20 && sPos.x < window.innerWidth - 20 && sPos.y > 20 && sPos.y < window.innerHeight - 20) {
        const rootWorld = _sciVecC.set(0, isNorth ? 4.0 : -4.0, 0).applyMatrix4(equatorialFrame.matrixWorld);
        const sRoot = new THREE.Vector2();
        projectWorldPosition(rootWorld, sRoot);

        const dx = sPos.x - sRoot.x;
        const dy = sPos.y - sRoot.y;
        const len = Math.hypot(dx, dy) || 1;
        const perpX = -dy / len;
        const perpY = dx / len;

        const offsetX = perpX * 18;
        const offsetY = perpY * 18;

        if (labelCollisionManager.tryPlaceLabel(sPos.x + offsetX, sPos.y + offsetY, 85, 12, false)) {
          axisLabelEl.style.display = 'block';
          axisLabelEl.style.left = `${(sPos.x + offsetX).toFixed(1)}px`;
          axisLabelEl.style.top = `${(sPos.y + offsetY).toFixed(1)}px`;
          axisLabelEl.style.transform = 'translate(-50%, -50%)';
        } else {
          axisLabelEl.style.display = 'none';
        }
      } else {
        axisLabelEl.style.display = 'none';
      }
    } else {
      axisLabelEl.style.display = 'none';
    }
  } else {
    if (axisLabelEl) axisLabelEl.style.display = 'none';
    if (northLabelEl) northLabelEl.style.display = 'none';
    if (southLabelEl) southLabelEl.style.display = 'none';
  }

  // =========================================================================
  // PRIORITY 6: Real-time Subsolar Point Annotation
  // =========================================================================
  let subsolarLabelEl = document.querySelector<HTMLElement>('#sci-label-subsolar');
  const subsolarGeographicLabelIsTruthful = earthTimeScale === 1 && !earthRealtimeReconciliation;
  if (cameraDistance >= 8.5 && !isCoarsePointer() && subsolarGeographicLabelIsTruthful) {
    if (!subsolarLabelEl) {
      subsolarLabelEl = document.createElement('div');
      subsolarLabelEl.id = 'sci-label-subsolar';
      subsolarLabelEl.className = 'sci-line-label subsolar-label';
      subsolarLabelEl.textContent = 'SUN · SUBSOLAR';
      labelsContainer.appendChild(subsolarLabelEl);
    }
    subsolarMarker.getWorldPosition(subsolarMarkerWorldTemp);
    const projected = projectWorldPosition(subsolarMarkerWorldTemp, satScreenTemp);
    if (projected.visible && !isBehindEarth(subsolarMarkerWorldTemp) && labelCollisionManager.tryPlaceLabel(satScreenTemp.x, satScreenTemp.y, 96, 12, false)) {
      subsolarLabelEl.style.display = 'block';
      subsolarLabelEl.style.left = `${satScreenTemp.x.toFixed(1)}px`;
      subsolarLabelEl.style.top = `${(satScreenTemp.y - 12).toFixed(1)}px`;
      subsolarLabelEl.style.transform = 'translate(-50%, -100%)';
    } else {
      subsolarLabelEl.style.display = 'none';
    }
  } else if (subsolarLabelEl) {
    subsolarLabelEl.style.display = 'none';
  }

  // =========================================================================
  // PRIORITY 7: Unselected Traffic & Cartographic Country Labels
  // =========================================================================

  // 7A. Unselected Aircraft
  const maxPlacedAirLabels = renderQuality === 'MOBILE' ? (cameraDistance > 9.0 ? 0 : 3) : cameraDistance > 16.0 ? 0 : cameraDistance > 9.0 ? 5 : cameraDistance > 5.5 ? 8 : 18;
  if (showAircraft) {
    for (let index = 0; index < aircraft.length; index++) {
      if (index === selectedAircraftIndex) continue;
      const motion = aircraft[index];
      const isHovered = motion.truth.icao24 === hoveredIcao;

      if (cameraDistance > 18.0 && !isHovered) continue;
      if (motion.opacity <= 0 || !motion.inFrustum || !motion.facingCamera) continue;
      if (motion.lodTier !== 'TIER_B' && !isHovered) continue;
      if (poolIdx >= maxPlacedAirLabels && !isHovered) continue;

      const callsign = (motion.truth.callsign || motion.truth.icao24).trim();
      const flAlt = `FL${Math.round(motion.altitude / 304.8)}`;
      const speedMps = `${Math.round(motion.velocity)} m/s`;
      const showSubtext = cameraDistance < 6.5 || isHovered;
      const widthEstimate = callsign.length * 6.5 + 14;
      const heightEstimate = showSubtext ? 26 : 16;

      if (labelCollisionManager.tryPlaceLabel(motion.screenPos.x, motion.screenPos.y, widthEstimate, heightEstimate, isHovered)) {
        let labelEl = domLabelPool[poolIdx];
        if (!labelEl) {
          labelEl = document.createElement('div');
          labelEl.className = 'aircraft-label';
          labelsContainer.appendChild(labelEl);
          domLabelPool.push(labelEl);
        }

        labelEl.className = 'aircraft-label';
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

  // 7B. Unselected Satellites
  if (showSatellites && poolIdx < maxPlacedAirLabels + 8) {
    const now = new Date();
    for (let index = 0; index < orbiters.length && poolIdx < maxPlacedAirLabels + 8; index++) {
      if (index === selectedSatelliteIndex) continue;
      const orbiter = orbiters[index];
      const isHovered = orbiter.norad === hoveredSatelliteNorad;
      const allowSparse = cameraDistance < 13 && index % (cameraDistance < 9 ? 14 : 32) === 0;
      if (!isHovered && !allowSparse) continue;

      const propagated = satellite.propagate(orbiter.satrec, now);
      if (!propagated || !propagated.position) continue;

      const eciPos = eciVector(propagated.position as satellite.EciVec3<number>);
      const worldPos = eciPos.clone().applyMatrix4(equatorialFrame.matrixWorld);
      const screenVec = worldPos.clone().project(camera);
      if (screenVec.z > 1.0 || worldPos.clone().normalize().dot(camDir) < 0.1) continue;

      const screenX = (screenVec.x * 0.5 + 0.5) * window.innerWidth;
      const screenY = (-(screenVec.y * 0.5) + 0.5) * window.innerHeight;
      const nameStr = orbiter.name.trim() || `NORAD ${orbiter.norad}`;
      const widthEstimate = nameStr.length * 6 + 14;

      if (labelCollisionManager.tryPlaceLabel(screenX, screenY, widthEstimate, 16, isHovered)) {
        let labelEl = domLabelPool[poolIdx];
        if (!labelEl) {
          labelEl = document.createElement('div');
          labelEl.className = 'aircraft-label';
          labelsContainer.appendChild(labelEl);
          domLabelPool.push(labelEl);
        }

        labelEl.className = 'aircraft-label';
        labelEl.style.display = 'block';
        labelEl.style.left = `${screenX}px`;
        labelEl.style.top = `${screenY}px`;
        labelEl.style.opacity = '0.80';
        labelEl.innerHTML = `<div class="callsign" style="color: #6acbfb;">${escapeHtml(nameStr)}</div>`;
        poolIdx++;
      }
    }
  }

  // 7C. Cartographic Country Labels
  const maxCountryLabels = renderQuality === 'MOBILE' ? (cameraDistance > 12 ? 8 : 16) : cameraDistance > 20.0 ? 12 : cameraDistance > 13.0 ? 24 : cameraDistance > 8.0 ? 42 : 65;
  const maxCountryTier = renderQuality === 'MOBILE' ? 1 : cameraDistance > 19.0 ? 1 : cameraDistance > 10.5 ? 2 : 3;
  let countryPlacedCount = 0;

  for (let index = 0; index < COUNTRY_LABELS.length && countryPlacedCount < maxCountryLabels; index++) {
    const country = COUNTRY_LABELS[index];
    if (country.tier > maxCountryTier) continue;

    const localPos = latLonToVector3(country.lat, country.lon, earthRadius + 0.005);
    const worldPos = localPos.clone().applyMatrix4(earth.matrixWorld);
    const facing = worldPos.clone().normalize().dot(camDir);
    if (facing < 0.12 || isBehindEarth(worldPos)) continue;

    const screenVec = worldPos.clone().project(camera);
    if (screenVec.z > 1.0) continue;

    const screenX = (screenVec.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-(screenVec.y * 0.5) + 0.5) * window.innerHeight;
    if (screenX < -30 || screenX > window.innerWidth + 30 || screenY < -30 || screenY > window.innerHeight + 30) continue;

    const widthEstimate = country.name.length * 6.0 + 8;
    const heightEstimate = 12;
    if (!labelCollisionManager.tryPlaceLabel(screenX, screenY, widthEstimate, heightEstimate, false)) continue;

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

  // =========================================================================
  // PRIORITY 8: Ecliptic Reference Plane Annotation (ECLIPTIC)
  // =========================================================================
  let eclipticLabelEl = document.querySelector<HTMLElement>('#sci-label-ecliptic');
  // Visible ONLY at Full Earth / 3/4 Earth scale (cameraDistance >= 10.0)
  if (cameraDistance >= 10.0) {
    if (!eclipticLabelEl) {
      eclipticLabelEl = document.createElement('div');
      eclipticLabelEl.id = 'sci-label-ecliptic';
      eclipticLabelEl.className = 'sci-line-label ecliptic-label';
      eclipticLabelEl.textContent = 'ECLIPTIC';
      labelsContainer.appendChild(eclipticLabelEl);
    }

    const r = 4.28;
    _sciVecA.set(r, 0, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), obliquity).applyMatrix4(equatorialFrame.matrixWorld);

    if (!isBehindEarth(_sciVecA) && _sciVecA.clone().normalize().dot(camDir) >= 0.15) {
      const sA = new THREE.Vector2();
      const projA = projectWorldPosition(_sciVecA, sA);
      if (projA.visible && sA.x >= 28 && sA.x <= window.innerWidth - 28 && sA.y >= 28 && sA.y <= window.innerHeight - 28) {
        if (labelCollisionManager.tryPlaceLabel(sA.x, sA.y, 52, 12, false)) {
          eclipticLabelEl.style.display = 'block';
          eclipticLabelEl.style.left = `${sA.x.toFixed(1)}px`;
          eclipticLabelEl.style.top = `${sA.y.toFixed(1)}px`;
          eclipticLabelEl.style.transform = 'translate(-50%, -50%)';
        } else {
          eclipticLabelEl.style.display = 'none';
        }
      } else {
        eclipticLabelEl.style.display = 'none';
      }
    } else {
      eclipticLabelEl.style.display = 'none';
    }
  } else if (eclipticLabelEl) {
    eclipticLabelEl.style.display = 'none';
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
      if (!showAircraft || document.hidden) {
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

        aircraftFetchController?.abort();
        const controller = new AbortController();
        aircraftFetchController = controller;
        const timeoutId = window.setTimeout(() => controller.abort(), 7_000);
        const response = await fetch(`/api/aircraft?${query.toString()}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (aircraftFetchController === controller) aircraftFetchController = null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as { provider: AircraftProvider; observedAt: number; states: TruthState[] };
        region.status = 'success';
        region.lastFetchedAt = Date.now();
        region.aircraftCount = payload.states.length;
        mergeAircraftPayload(payload);
      } catch (err) {
        if (aircraftFetchController?.signal.aborted) aircraftFetchController = null;
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
  if (document.hidden) return;
  satelliteFetchController?.abort();
  const controller = new AbortController();
  satelliteFetchController = controller;
  const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('/api/satellites?limit=6000', { signal: controller.signal });
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
    updateSatellites(true);
  } catch {
    // Preserve the last valid catalogue across a transient refresh failure.
    if (orbiters.length === 0) clearSatelliteData();
    $('#satellite-status').textContent = 'UNAVAILABLE';
    $('#satellite-meta').textContent = orbiters.length ? 'CELESTRAK GP · STALE CATALOGUE' : 'CELESTRAK GP · NO CURRENT RESPONSE';
  } finally {
    clearTimeout(timeoutId);
    if (satelliteFetchController === controller) satelliteFetchController = null;
  }
}

let lastSatelliteFieldUpdateMs = 0;
function updateSelectedSatelliteVisual(now: Date, viewportHeight = window.innerHeight) {
  if (selectedSatelliteIndex < 0 || !orbiters[selectedSatelliteIndex]) return;
  const selProp = satellite.propagate(orbiters[selectedSatelliteIndex].satrec, now);
  if (!selProp || !selProp.position) return;
  const pos = eciVector(selProp.position as satellite.EciVec3<number>, satPosTemp);
  selectedSatHalo.position.copy(pos);
  selectedSatGlyph.position.copy(pos);
  selectedSatHalo.lookAt(camera.position);
  selectedSatGlyph.lookAt(camera.position);

  const satDist = pos.distanceTo(camera.position);
  selectedSatHalo.scale.setScalar(getWorldScaleForPixelSize(camera, satDist, 16.0, viewportHeight));
  selectedSatGlyph.scale.setScalar(getWorldScaleForPixelSize(camera, satDist, 9.5, viewportHeight));
}

// The full catalog is a presentation field, so it refreshes at a bounded visual
// cadence. A selected satellite is still propagated every animation frame.
function updateSatellites(force = false) {
  if (!showSatellites) {
    satGlyphsMesh.count = 0;
    return;
  }

  const now = new Date();
  const intervalMs = renderQuality === 'MOBILE' ? 165 : renderQuality === 'DESKTOP_BALANCED' ? 115 : 80;
  if (!force && now.getTime() - lastSatelliteFieldUpdateMs < intervalMs) {
    updateSelectedSatelliteVisual(now);
    return;
  }
  lastSatelliteFieldUpdateMs = now.getTime();

  equatorialFrame.updateWorldMatrix(true, false);
  const camLocalPos = satCamLocalTemp.copy(camera.position).applyMatrix4(satFrameInverseTemp.copy(equatorialFrame.matrixWorld).invert());
  const viewportHeight = window.innerHeight;
  const cameraDistance = camera.position.distanceTo(controls.target);
  const satelliteMaterial = satGlyphsMesh.material as THREE.MeshBasicMaterial;
  satelliteMaterial.opacity = THREE.MathUtils.clamp(0.12 + (20 - cameraDistance) * 0.012, 0.12, 0.30);

  satInstanceToOrbiterIndex.length = 0;
  satelliteScreenCandidates.length = 0;
  let renderedCount = 0;

  for (let index = 0; index < orbiters.length && renderedCount < satelliteRenderLimit(); index++) {
    const orbiter = orbiters[index];
    const propagated = satellite.propagate(orbiter.satrec, now);
    if (!propagated || !propagated.position) continue;

    const position = eciVector(propagated.position as satellite.EciVec3<number>, satPosTemp);
    const isSel = selectedSatelliteIndex === index;
    const satDist = position.distanceTo(camLocalPos);

    // Subtle orbital field globally; full VECTOR silhouette only earns weight nearby.
    const globalPx = THREE.MathUtils.clamp(1.8 + (18 - cameraDistance) * 0.22, 1.8, 5.8);
    const desiredPx = isSel ? 9.5 : THREE.MathUtils.clamp(globalPx + (14 - satDist) * 0.05, 1.7, 6.5);
    const satScale = getWorldScaleForPixelSize(camera, satDist, desiredPx, viewportHeight);

    // Billboard orientation facing camera
    satLookTemp.position.copy(position);
    satLookTemp.lookAt(camLocalPos);

    satMatrixTemp.makeTranslation(position.x, position.y, position.z);
    satMatrixTemp.multiply(satFrameInverseTemp.makeRotationFromQuaternion(satLookTemp.quaternion));
    satMatrixTemp.scale(satScaleTemp.setScalar(satScale));

    satGlyphsMesh.setMatrixAt(renderedCount, satMatrixTemp);

    satInstanceToOrbiterIndex[renderedCount] = index;
    const worldPosition = satWorldTemp.copy(position).applyMatrix4(equatorialFrame.matrixWorld);
    const screen = satScreenTemp;
    if (projectWorldPosition(worldPosition, screen).visible && !isBehindEarth(worldPosition)) {
      const candidate = satelliteScreenCandidatePool[satelliteScreenCandidates.length] ?? { index, id: orbiter.norad, x: 0, y: 0, distancePx: 0 };
      candidate.index = index;
      candidate.id = orbiter.norad;
      candidate.x = screen.x;
      candidate.y = screen.y;
      candidate.distancePx = 0;
      if (!satelliteScreenCandidatePool[satelliteScreenCandidates.length]) satelliteScreenCandidatePool.push(candidate);
      satelliteScreenCandidates.push(candidate);
    }
    renderedCount++;
  }

  satGlyphsMesh.count = renderedCount;
  satGlyphsMesh.instanceMatrix.needsUpdate = true;

  updateSelectedSatelliteVisual(now, viewportHeight);
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
  currentSelectedOrbitPoints = points.slice();

  const orbitGroup = new THREE.Group();

  // LAYER A — OCCLUDED / CONTEXT ORBIT (Screen-space 0.85 px)
  // Full propagated trajectory visible through the Earth with thin sparse dash treatment.
  // Provides complete orbital context without competing with geography.
  const fullGeometry = new LineGeometry();
  fullGeometry.setPositions(toFlatPoints(points));
  const contextOrbitMat = registerFatLineMaterial(
    new LineMaterial({
      color: 0x488ca8,
      linewidth: 0.85,
      transparent: true,
      opacity: 0.06,
      dashed: true,
      dashScale: 1.0,
      dashSize: 0.06,
      gapSize: 0.09,
      depthWrite: false,
      depthTest: false,
    })
  );
  const contextOrbit = new Line2(fullGeometry, contextOrbitMat);
  contextOrbit.computeLineDistances();
  orbitGroup.add(contextOrbit);

  // LAYER B — VISIBLE DEPTH-TESTED ORBIT (Trajectory Language: Technical Regular Dashes)
  // Camera-facing portion naturally dominates via depth testing.
  // Subtle past vs future split around current UTC (midpoint index).
  const midpoint = Math.floor(points.length / 2);
  const pastPoints = points.slice(0, midpoint + 1);
  const futurePoints = points.slice(midpoint);

  if (pastPoints.length >= 2) {
    const pastGeo = new LineGeometry();
    pastGeo.setPositions(toFlatPoints(pastPoints));
    const pastOrbitMat = registerFatLineMaterial(
      new LineMaterial({
        color: 0x68badc,
        linewidth: 1.4,
        transparent: true,
        opacity: 0.32,
        dashed: true,
        dashScale: 1.0,
        dashSize: 0.06,
        gapSize: 0.07,
        depthWrite: false,
        depthTest: true,
      })
    );
    const pastOrbit = new Line2(pastGeo, pastOrbitMat);
    pastOrbit.computeLineDistances();
    orbitGroup.add(pastOrbit);
  }

  if (futurePoints.length >= 2) {
    const futureGeo = new LineGeometry();
    futureGeo.setPositions(toFlatPoints(futurePoints));
    const futureOrbitMat = registerFatLineMaterial(
      new LineMaterial({
        color: 0x8ee0ff,
        linewidth: 1.5,
        transparent: true,
        opacity: 0.48,
        dashed: true,
        dashScale: 1.0,
        dashSize: 0.07,
        gapSize: 0.06,
        depthWrite: false,
        depthTest: true,
      })
    );
    const futureOrbitLine = new Line2(futureGeo, futureOrbitMat);
    futureOrbitLine.computeLineDistances();
    orbitGroup.add(futureOrbitLine);
  }

  // CURRENT-POSITION EMPHASIS (Trajectory Language: Prominent Technical Dashes, 2.0 px)
  // Restrained temporal window (±6% of orbital period around current UTC)
  const windowSamples = Math.max(3, Math.round(numSamples * 0.06));
  const nearStart = Math.max(0, midpoint - windowSamples);
  const nearEnd = Math.min(points.length, midpoint + windowSamples + 1);
  const nearPoints = points.slice(nearStart, nearEnd);

  if (nearPoints.length >= 2) {
    const nearGeo = new LineGeometry();
    nearGeo.setPositions(toFlatPoints(nearPoints));
    const nearOrbitMat = registerFatLineMaterial(
      new LineMaterial({
        color: 0xb6f0ff,
        linewidth: 2.0,
        transparent: true,
        opacity: 0.85,
        dashed: true,
        dashScale: 1.0,
        dashSize: 0.08,
        gapSize: 0.04,
        depthWrite: false,
        depthTest: true,
      })
    );
    const nearOrbit = new Line2(nearGeo, nearOrbitMat);
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
    <dt>SOLAR STATE</dt><dd>CALCULATED · UTC</dd>
    <dt>SUBSOLAR POINT</dt><dd>${currentSolarState.subsolarLatitudeDeg >= 0 ? '+' : ''}${currentSolarState.subsolarLatitudeDeg.toFixed(2)}°, ${currentSolarState.subsolarLongitudeDeg >= 0 ? '+' : ''}${currentSolarState.subsolarLongitudeDeg.toFixed(2)}°</dd>
    <dt>SOLAR RA / DEC</dt><dd>${(THREE.MathUtils.radToDeg(currentSolarState.rightAscensionRad) / 15).toFixed(2)}h / ${currentSolarState.declinationRad >= 0 ? '+' : ''}${THREE.MathUtils.radToDeg(currentSolarState.declinationRad).toFixed(2)}°</dd>
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
  const aircraftRadius = isCoarsePointer() ? 26 : 15;
  const satelliteRadius = isCoarsePointer() ? 24 : 13;
  let best: { type: 'aircraft' | 'satellite'; value: ScreenCandidate; distancePx: number } | undefined;
  const test = (type: 'aircraft' | 'satellite', values: ScreenCandidate[], radius: number) => {
    for (const value of values) {
      const distancePx = Math.hypot(event.clientX - value.x, event.clientY - value.y);
      if (distancePx <= radius && (!best || distancePx < best.distancePx)) best = { type, value, distancePx };
    }
  };
  if (showAircraft) test('aircraft', aircraftScreenCandidates, aircraftRadius);
  if (showSatellites) test('satellite', satelliteScreenCandidates, satelliteRadius);
  lastPickDistancePx = best?.distancePx ?? null;
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
  if (isCoarsePointer()) return;
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

  const cameraDist = camera.position.distanceTo(controls.target);

  // Authoritative Astronomical Solar Ephemeris & Day/Night Terminator Update (Real UTC)
  updateSolarSystem(nowDate, cameraDist);

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
  const eclipticZoomFactor = THREE.MathUtils.clamp((cameraDist - 7.0) / (15.0 - 7.0), 0, 1);
  const tiltZoomFactor = THREE.MathUtils.clamp((cameraDist - 5.5) / (12.0 - 5.5), 0, 1);
  const axisZoomFactor = THREE.MathUtils.clamp((cameraDist - 4.5) / (10.0 - 4.5), 0.20, 1);

  eclipticRingMat.opacity = 0.09 * eclipticZoomFactor;
  eclipticRingLine.visible = eclipticRingMat.opacity > 0.005;

  eclipticNormalMat.opacity = 0.22 * tiltZoomFactor;
  tiltMat.opacity = 0.50 * tiltZoomFactor;
  tiltArcLine.visible = tiltMat.opacity > 0.005;
  eclipticNormalLine.visible = eclipticNormalMat.opacity > 0.005;

  axisMat.opacity = 0.38 * axisZoomFactor;
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

window.setInterval(() => {
  if (!document.hidden) scheduleVisibleRegionFetches();
}, 25000);
window.setInterval(() => {
  if (!document.hidden) loadSatellites();
}, 2 * 60 * 60 * 1000);

function setRuntimeStatus(message: string | null) {
  const status = $('#runtime-status');
  status.hidden = !message;
  status.textContent = message ?? '';
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    aircraftFetchController?.abort();
    satelliteFetchController?.abort();
    renderer.setAnimationLoop(null);
    return;
  }

  // Resume from fresh real UTC without presenting a giant simulation delta.
  lastFrameTimeSec = Date.now() / 1000;
  lastSolarEphemerisUpdateMs = 0;
  lastSolarTrackUpdateMs = 0;
  lastSatelliteFieldUpdateMs = 0;
  lastDomLabelUpdateMs = 0;
  renderer.setAnimationLoop(render);
  scheduleVisibleRegionFetches();
  loadSatellites();
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  renderer.setAnimationLoop(null);
  setRuntimeStatus('Graphics context lost · waiting to restore');
});

canvas.addEventListener('webglcontextrestored', () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderQuality === 'MOBILE' ? 1.35 : renderQuality === 'DESKTOP_BALANCED' ? 1.5 : 1.7));
  renderer.setSize(window.innerWidth, window.innerHeight);
  for (const mat of fatLineMaterials) mat.resolution.set(window.innerWidth, window.innerHeight);
  lastSatelliteFieldUpdateMs = 0;
  lastSolarEphemerisUpdateMs = 0;
  setRuntimeStatus(null);
  if (!document.hidden) renderer.setAnimationLoop(render);
});

window.addEventListener('resize', () => {
  renderQuality = detectRenderQuality();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderQuality === 'MOBILE' ? 1.35 : renderQuality === 'DESKTOP_BALANCED' ? 1.5 : 1.7));
  renderer.setSize(window.innerWidth, window.innerHeight);
  for (const mat of fatLineMaterials) {
    mat.resolution.set(window.innerWidth, window.innerHeight);
  }
});
