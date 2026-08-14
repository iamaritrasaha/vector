import * as THREE from 'three';

const sharedLineMaterial = new THREE.LineBasicMaterial({
  color: 0xd8f3fb,
  transparent: true,
  opacity: 0.88,
  depthWrite: false,
});

const selectionBracketMaterial = new THREE.LineBasicMaterial({
  color: 0x9be8ff,
  transparent: true,
  opacity: 0.62,
  depthWrite: false,
});

function segments(points: number[]) {
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(points, 3)
  );
}

/**
 * Original VECTOR Commercial Jet Tracking Geometry (Top-Down View).
 * Features sharp pointed nose (+Y direction), swept wings, slender fuselage, and rear tailplane.
 * Bounding box is normalized to approximately 1.0 unit for exact screen-space scaling.
 */
export function createAircraftMarkerGeometry() {
  const shape = new THREE.Shape();
  // Pointed Nose
  shape.moveTo(0, 0.50);
  shape.lineTo(-0.06, 0.26);
  shape.lineTo(-0.07, 0.08);

  // Swept Main Wing Left
  shape.lineTo(-0.50, -0.14);
  shape.lineTo(-0.50, -0.22);
  shape.lineTo(-0.07, -0.10);

  // Rear Fuselage Left
  shape.lineTo(-0.06, -0.38);

  // Tailplane Left
  shape.lineTo(-0.22, -0.48);
  shape.lineTo(-0.20, -0.50);
  shape.lineTo(0, -0.44);

  // Tailplane Right
  shape.lineTo(0.20, -0.50);
  shape.lineTo(0.22, -0.48);
  shape.lineTo(0.06, -0.38);

  // Swept Main Wing Right
  shape.lineTo(0.07, -0.10);
  shape.lineTo(0.50, -0.22);
  shape.lineTo(0.50, -0.14);
  shape.lineTo(0.07, 0.08);

  // Cockpit Transition Right
  shape.lineTo(0.06, 0.26);
  shape.closePath();

  return new THREE.ShapeGeometry(shape);
}

/**
 * Neutral micro-contact geometry for Tier A aircraft in dense views.
 * Symmetrical 8-sided compact disc / diamond (normalized diameter 1.0, bounds -0.5 to +0.5).
 * Completely isotropic: communicates NO fake directional trajectory and creates no arrow noise.
 */
export function createAircraftMicroGlyphGeometry() {
  const shape = new THREE.Shape();
  const radius = 0.5;
  const segments = 8;
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

/**
 * Original VECTOR Technical Spacecraft Satellite Geometry.
 * Compact central bus, two solar-array wings, and antenna dish hint.
 * Normalized to 1.0 unit total width (-0.50 to +0.50) for precise 1:1 pixel sizing.
 */
export function createSatelliteGlyphGeometry() {
  const positions: number[] = [
    // Central Spacecraft Bus (2 triangles)
    -0.10, -0.10, 0,   0.10, -0.10, 0,   0.10,  0.10, 0,
    -0.10, -0.10, 0,   0.10,  0.10, 0,  -0.10,  0.10, 0,

    // Left Solar-Array Wing (2 triangles)
    -0.50, -0.09, 0,  -0.14, -0.09, 0,  -0.14,  0.09, 0,
    -0.50, -0.09, 0,  -0.14,  0.09, 0,  -0.50,  0.09, 0,

    // Right Solar-Array Wing (2 triangles)
     0.14, -0.09, 0,   0.50, -0.09, 0,   0.50,  0.09, 0,
     0.14, -0.09, 0,   0.50,  0.09, 0,   0.14,  0.09, 0,

    // Left Solar Panel Arm Attachment (2 triangles)
    -0.14, -0.03, 0, -0.10, -0.03, 0, -0.10, 0.03, 0,
    -0.14, -0.03, 0, -0.10,  0.03, 0, -0.14, 0.03, 0,

    // Right Solar Panel Arm Attachment (2 triangles)
     0.10, -0.03, 0,  0.14, -0.03, 0,  0.14, 0.03, 0,
     0.10, -0.03, 0,  0.14,  0.03, 0,  0.10, 0.03, 0,

    // Top Dish Antenna Feed Horn (2 triangles)
    -0.03,  0.10, 0,   0.03,  0.10, 0,   0.03,  0.18, 0,
    -0.03,  0.10, 0,   0.03,  0.18, 0,  -0.03,  0.18, 0,

    // Antenna Parabolic Dish Rim (2 triangles)
    -0.08, 0.18, 0,   0.08, 0.18, 0,   0.08, 0.23, 0,
    -0.08, 0.18, 0,   0.08, 0.23, 0,  -0.08, 0.23, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Lightweight top-down satellite selection glyph line object.
 */
export function createSatelliteGlyph() {
  const glyph = new THREE.LineSegments(
    segments([
      // Solar Panel Frame
      -0.50, 0, 0, -0.14, 0, 0,
      0.14, 0, 0, 0.50, 0, 0,
      -0.50, -0.10, 0, -0.50, 0.10, 0,
      0.50, -0.10, 0, 0.50, 0.10, 0,
      // Main Body Box
      -0.10, -0.10, 0, 0.10, -0.10, 0,
      0.10, -0.10, 0, 0.10, 0.10, 0,
      0.10, 0.10, 0, -0.10, 0.10, 0,
      -0.10, 0.10, 0, -0.10, -0.10, 0,
      // Antenna Dish
      0, 0.10, 0, 0, 0.18, 0,
      -0.08, 0.18, 0, 0.08, 0.18, 0
    ]),
    sharedLineMaterial
  );
  glyph.renderOrder = 2;
  return glyph;
}

/**
 * Screen-facing avionics selection glyph for selected aircraft.
 */
export function createAircraftGlyph() {
  const glyph = new THREE.LineSegments(
    segments([
      0, 0.45, 0, 0, -0.40, 0,
      -0.45, -0.04, 0, 0.45, -0.04, 0,
      0, 0.12, 0, -0.28, -0.16, 0,
      0, 0.12, 0, 0.28, -0.16, 0,
      0, -0.40, 0, -0.12, -0.24, 0,
      0, -0.40, 0, 0.12, -0.24, 0
    ]),
    sharedLineMaterial
  );
  glyph.renderOrder = 2;
  return glyph;
}

/** Compact four-corner aerospace selection brackets, normalized to one unit. */
export function createSelectionBrackets() {
  const bracket = new THREE.LineSegments(
    segments([
      -0.50, 0.32, 0, -0.50, 0.50, 0, -0.50, 0.50, 0, -0.32, 0.50, 0,
       0.32, 0.50, 0,  0.50, 0.50, 0,  0.50, 0.50, 0,  0.50, 0.32, 0,
      -0.50,-0.32, 0, -0.50,-0.50, 0, -0.50,-0.50, 0, -0.32,-0.50, 0,
       0.32,-0.50, 0,  0.50,-0.50, 0,  0.50,-0.50, 0,  0.50,-0.32, 0,
    ]),
    selectionBracketMaterial
  );
  bracket.renderOrder = 3;
  return bracket;
}
