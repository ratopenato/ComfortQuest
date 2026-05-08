import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  getState,
  reportOccupantOverride,
  setShadeCmd,
  setSetpointCmd,
  setLightsCmd,
  getCommands,
  applyOccupantOverride,
  endOverride,
} from './dataSource.js';

/* -----------------------------------------------------------------
 * Main Three.js simulation for the office environment.  This file
 * builds a low‑poly room with a roller shade, an air‑conditioner/
 * thermostat, and a light switch.  Clicking each device triggers
 * a sequence: the RL agent changes the device state, then the
 * occupant stands, walks to the device, overrides it back and
 * returns to the desk.  The animation system uses a queue of
 * tasks; states guard sequences so that only one runs at once.
 * The camera is locked via OrbitControls by disabling rotation,
 * panning and zooming.
 * ----------------------------------------------------------------- */

// Scene globals
let scene, camera, renderer;
let controls;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// Devices and click targets
let shadeGroup, shadeFabric, shadeBottomBar, shadeHandle, shadeClickTarget;
let acUnitMesh, thermMesh, thermDisplay, thermClickTarget;
let switchPlateMesh, switchLeverMesh, switchClickTarget;
let switchOn = true;

// Additional references for lighting and AC control.  The hemisphere and
// room fill lights need to be toggled when the ceiling light is
// switched off.  The ceiling fixture mesh is saved so its emissive
// colour can be adjusted.  The AC LED and grille group support
// animation when the AC is running.
let hemisphereLight, roomFillLight, ceilingFixtureMesh, sunbeamMesh;
let acLedMesh, acGrilleGroup, acAirflowGroup;
let acRunning = false;

// Pointer to the ceiling light so its intensity can be toggled with the light
// switch.  Assigned during init() when lights are created.
let ceilingLight;

// Occupant
let occupant;
// Annoyance / Misalignment level (0..1) — rises on each override, slowly decays.
let annoyance = 0;
const ANNOYANCE_PER_OVERRIDE = 0.18;
const ANNOYANCE_DECAY_PER_FRAME = 0.00015;

// Additional environmental references
let sunLight;
let skyMesh;

// HUD and control element references.  These will be assigned in init()
let narrativeEl, modeBadgeEl;
let valShadeEl, valThermEl, valLightsEl, valAcEl;
let valPmvEl, valTempEl, valCo2El, valLuxEl, valHumEl, valTimeEl;
let valAnnoyanceEl, annoyanceBarEl;
let shadeBtnEl, thermBtnEl, lightBtnEl;

// Simulation state and animation queue
let state = 'idle';
const animations = [];

// Room dimensions and window geometry
const ROOM = { w: 8.0, d: 7.5, h: 3.6 };
const WINDOW = {
  width: 3.6,
  height: 2.05,
  bottom: 1.05,
  z: -ROOM.d / 2 + 0.06
};
const SHADE = {
  maxDrop: WINDOW.height,
  barHeight: 0.07
};

// Path waypoints for occupant navigation.  Values are chosen to
// follow the natural aisle around the desk to each device.
// Occupant pelvis heights: STAND_Y = standing, SEAT_Y = sitting on chair.
const STAND_Y = 0.92;
const SEAT_Y  = 0.59;

const POS = {
  // Raise the occupant so they sit above the chair surface and avoid
  // clipping the desk.  Shift the occupant to the right (-0.20 x) so they
  // clear the desk completely.  The seated and standing heights are
  // increased by 0.08m.
  seated:         new THREE.Vector3(-0.20, 0.84, -1.90),
  standDesk:      new THREE.Vector3(-0.20, 1.07, -1.90),
  aisle:          new THREE.Vector3( 0.85, 0.95, -1.90),
  windowApproach: new THREE.Vector3( 0.85, 0.95, WINDOW.z + 0.70),
  window:         new THREE.Vector3( 0.0,  0.95, WINDOW.z + 0.58),
  thermAisle:     new THREE.Vector3( 2.20, 0.95, -1.50),
  thermApproach:  new THREE.Vector3( 3.28, 0.95, -1.50),
  switchAisle:    new THREE.Vector3( 2.20, 0.95,  1.00),
  switchApproach: new THREE.Vector3( 3.28, 0.95,  1.00),
};

// DOM references
const statusEl = document.getElementById('status');


// Initialise the scene
init();
animate();

function init() {
  // Create scene and camera
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfe1ef);

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  // Position the camera to look directly at the window
  camera.position.set(0, 2.5, 7.5);
  camera.lookAt(0, 1.5, WINDOW.z);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // OrbitControls locked (no rotation, pan or zoom).  The camera
  // target remains slightly below eye level to centre the view.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.4, -2.1);
  controls.enableRotate = false;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.update();

  // Lighting: simulate natural daylight entering from the south (back) window.
  // Replace the default hemispheric and directional lights with a sky fill,
  // a sun far behind the back wall, a soft room fill and a ceiling light.
  // Save references to the sky and room lights so they can be dimmed when
  // the user turns off the light switch.  Without saving these, the room
  // remains partially lit when the switch is off.
  // Hemisphere acts as ambient skylight; intensity is driven by daylight +
  // shade position in updateDaylight.
  hemisphereLight = new THREE.HemisphereLight(0xddeeff, 0x6a7a5a, 0.30);
  scene.add(hemisphereLight);
  // Direct sun light (south-facing window). Stronger so the room is
  // visibly brighter when shade is up vs. down.
  sunLight = new THREE.DirectionalLight(0xfffbe8, 2.4);
  sunLight.position.set(-1.5, 7.0, -14.0);
  sunLight.target.position.set(0, 0.5, 1.5); // bias light into the room
  scene.add(sunLight.target);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -8;
  sunLight.shadow.camera.right = 8;
  sunLight.shadow.camera.top = 8;
  sunLight.shadow.camera.bottom = -8;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 30;
  sunLight.shadow.bias = -0.0008;
  sunLight.shadow.normalBias = 0.02;
  sunLight.shadow.radius = 4;
  scene.add(sunLight);
  // Warm fill near the inside of the window — represents sunlight bouncing
  // off interior surfaces. Modulated by shade position.
  roomFillLight = new THREE.PointLight(0xfff4dd, 0.0, 9);
  roomFillLight.position.set(0, 1.6, WINDOW.z + 1.5);
  scene.add(roomFillLight);
  // Artificial ceiling light: only contributes when the switch is on.
  ceilingLight = new THREE.PointLight(0xfff4dd, 0.85, 7);
  ceilingLight.position.set(0, ROOM.h - 0.35, -0.5);
  scene.add(ceilingLight);

  // Sunbeam pool: a soft glowing rectangle on the floor where direct sun
  // would project through the window.  Its position drifts with time of
  // day; opacity scales with sun intensity * (1 - shade position).
  const beamGeom = new THREE.PlaneGeometry(WINDOW.width + 1.2, 4.0);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffe8a8,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  sunbeamMesh = new THREE.Mesh(beamGeom, beamMat);
  sunbeamMesh.rotation.x = -Math.PI / 2;
  sunbeamMesh.position.set(0, 0.005, -1.2);
  scene.add(sunbeamMesh);

  // Build environment
  buildRoom();
  buildOutdoorView();
  buildWindowAndShade();
  buildFurniture();
  buildACAndThermostat();
  buildLightSwitch();
  buildPlant();
  buildBookshelf();
  buildOccupant();
  // Ensure the AC LED and louvres are initialised to the off state
  updateACVisual(false);

  // Event listeners
  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  // Assign HUD and control elements after DOM is loaded
  narrativeEl = document.getElementById('narrative');
  modeBadgeEl = document.getElementById('mode-badge');
  valShadeEl  = document.getElementById('val-shade');
  valThermEl  = document.getElementById('val-therm');
  valLightsEl = document.getElementById('val-lights');
  valAcEl     = document.getElementById('val-ac');
  valPmvEl    = document.getElementById('val-pmv');
  valTempEl   = document.getElementById('val-temp');
  valCo2El    = document.getElementById('val-co2');
  valLuxEl    = document.getElementById('val-lux');
  valHumEl    = document.getElementById('val-hum');
  valAnnoyanceEl = document.getElementById('val-annoyance');
  annoyanceBarEl = document.getElementById('annoyance-bar');
  valTimeEl   = document.getElementById('val-time');
  shadeBtnEl  = document.getElementById('shadeBtn');
  thermBtnEl  = document.getElementById('thermBtn');
  lightBtnEl  = document.getElementById('lightBtn');
  // Hook up button handlers.  Each issues a command to the simulation;
  // the occupant FSM decides when to override.
  if (shadeBtnEl) shadeBtnEl.addEventListener('click', commandShadeToggle);
  if (thermBtnEl) thermBtnEl.addEventListener('click', commandThermCycle);
  if (lightBtnEl) lightBtnEl.addEventListener('click', commandLightsToggle);

  setStatus('waiting for interaction');
  setButtons(true);
  // Initialise HUD with current simulation state and daylight
  const initialState = getState();
  updateHUD(initialState);
  updateDaylight(initialState);
  // Debug hook — fire an override animation manually for testing.
  window.__sim = {
    forceOverride: (target) => { if (state === 'idle') startOverrideAnim(target); },
    snapshot: () => getState(),
    airflow: () => acAirflowGroup?.children?.map(c => ({
      color: '#' + c.material.color.getHexString(),
      opacity: c.material.opacity.toFixed(3),
    })),
  };
}

/* -----------------------------------------------------------------
 * Scene construction functions
 * ----------------------------------------------------------------- */

// Builds the floor and walls.  Only left, right and front walls are
// constructed; the back wall is open where the window sits.
function buildRoom() {
  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xc5b8a5 });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    floorMat
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling: a simple plane closing the room overhead.  Colour is a
  // warm off‑white to match the walls.  It faces downward into the room.
  const ceilingMat = new THREE.MeshStandardMaterial({ color: 0xf0eeea, roughness: 0.9 });
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.d),
    ceilingMat
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, ROOM.h, 0);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  // Walls
  const wallThickness = 0.08;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe6edf2 });
  // Left wall
  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(wallThickness, ROOM.h, ROOM.d),
    wallMat
  );
  leftWall.position.set(-ROOM.w / 2 + wallThickness / 2, ROOM.h / 2, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);
  // Right wall
  const rightWall = leftWall.clone();
  rightWall.position.set(ROOM.w / 2 - wallThickness / 2, ROOM.h / 2, 0);
  scene.add(rightWall);
  // Front wall removed: dollhouse view — camera looks into the room from
  // the open front side, with the window/sun at the back wall.

  // Back wall built as 4 segments framing the window opening so the
  // outdoor landscape only shows through the window, not the whole wall.
  const backZ = -ROOM.d / 2 + wallThickness / 2;
  const winLeft   = -WINDOW.width / 2;
  const winRight  =  WINDOW.width / 2;
  const winBottom =  WINDOW.bottom;
  const winTop    =  WINDOW.bottom + WINDOW.height;
  const sideW = (ROOM.w - WINDOW.width) / 2;
  // Left jamb
  const backLeft = new THREE.Mesh(
    new THREE.BoxGeometry(sideW, ROOM.h, wallThickness), wallMat
  );
  backLeft.position.set(-ROOM.w / 2 + sideW / 2, ROOM.h / 2, backZ);
  backLeft.receiveShadow = true;
  scene.add(backLeft);
  // Right jamb
  const backRight = new THREE.Mesh(
    new THREE.BoxGeometry(sideW, ROOM.h, wallThickness), wallMat
  );
  backRight.position.set(ROOM.w / 2 - sideW / 2, ROOM.h / 2, backZ);
  backRight.receiveShadow = true;
  scene.add(backRight);
  // Header (above the window)
  const headerH = ROOM.h - winTop;
  const backHeader = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width, headerH, wallThickness), wallMat
  );
  backHeader.position.set(0, winTop + headerH / 2, backZ);
  backHeader.receiveShadow = true;
  scene.add(backHeader);
  // Sill (below the window)
  const backSill = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width, winBottom, wallThickness), wallMat
  );
  backSill.position.set(0, winBottom / 2, backZ);
  backSill.receiveShadow = true;
  scene.add(backSill);

  // Ceiling light fixture (simple box with emissive top)
  const fixture = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.05, 0.35),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 })
  );
  fixture.position.set(0, ROOM.h - 0.05, -0.4);
  scene.add(fixture);
  // Note: the overhead light fixture geometry is kept for visual appeal, but
  // lighting itself is handled by the global ceiling light in init().

  // Save the fixture mesh reference so its emissive properties can be
  // controlled when toggling the light switch.  Without this, the
  // fixture would continue to glow even when the lights are off.
  ceilingFixtureMesh = fixture;
}

// Builds a low‑poly outdoor view behind the window to give depth.
function buildOutdoorView() {
  const group = new THREE.Group();
  group.position.set(0, 0, WINDOW.z - 0.55);
  scene.add(group);
  // Sky
  // Sky plane.  Save a reference so its colour can be updated with time of day.
  skyMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 5),
    new THREE.MeshBasicMaterial({ color: 0x9bd4f0 })
  );
  skyMesh.position.set(0, 2.2, -0.02);
  group.add(skyMesh);
  // Sun
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(0.28, 24),
    new THREE.MeshBasicMaterial({ color: 0xffe89a })
  );
  sun.position.set(1.25, 2.75, 0.02);
  group.add(sun);
  // Hills
  function makeHill(width, height, baseY, color) {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, baseY);
    shape.lineTo(-width * 0.35, baseY + height * 0.55);
    shape.lineTo(-width * 0.1, baseY + height);
    shape.lineTo(width * 0.2, baseY + height * 0.58);
    shape.lineTo(width / 2, baseY);
    return new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color }));
  }
  const hill1 = makeHill(5.8, 1.15, 0.2, 0x4d7f67);
  hill1.position.set(-2.1, 1.05, 0.03);
  group.add(hill1);
  const hill2 = makeHill(6.2, 1.0, 0.12, 0x6ba07b);
  hill2.position.set(1.1, 1.0, 0.04);
  group.add(hill2);
  const hill3 = makeHill(5.0, 0.8, 0.05, 0x89b989);
  hill3.position.set(0, 0.85, 0.05);
  group.add(hill3);
  // Lake and grass
  const lake = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 0.75),
    new THREE.MeshBasicMaterial({ color: 0x6fb3c5 })
  );
  lake.position.set(0, 0.75, 0.06);
  group.add(lake);
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(8.5, 1.0),
    new THREE.MeshBasicMaterial({ color: 0x7aaa55 })
  );
  grass.position.set(0, 0.25, 0.07);
  group.add(grass);
  // Trees
  function makeTree(x, y, z, scale) {
    const tree = new THREE.Group();
    tree.position.set(x, y, z);
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(scale * 0.18, scale * 0.55, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x6b4d2e })
    );
    trunk.position.y = scale * 0.25;
    tree.add(trunk);
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(scale * 0.55, scale * 1.1, 7),
      new THREE.MeshBasicMaterial({ color: 0x2f6c45 })
    );
    crown.position.y = scale * 0.8;
    tree.add(crown);
    return tree;
  }
  for (let i = 0; i < 14; i++) {
    const x = -3.6 + i * 0.55;
    const y = 0.55 + Math.sin(i * 1.7) * 0.08;
    group.add(makeTree(x, y, 0.08, 0.25 + (i % 3) * 0.04));
  }
}

// Builds the window frame, glass, roller tube and shade components.
function buildWindowAndShade() {
  // Frame material
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.35 });

  // Window top and bottom frame
  const frameThickness = 0.10;
  const frameDepth = 0.11;
  function addFrame(w, h, x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, frameDepth),
      frameMat
    );
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  addFrame(WINDOW.width + 0.25, frameThickness, 0, WINDOW.bottom + WINDOW.height + frameThickness / 2, WINDOW.z + 0.015);
  addFrame(WINDOW.width + 0.25, frameThickness, 0, WINDOW.bottom - frameThickness / 2, WINDOW.z + 0.015);
  // Sides
  addFrame(frameThickness, WINDOW.height + 0.2, -WINDOW.width / 2 - frameThickness / 2, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.015);
  addFrame(frameThickness, WINDOW.height + 0.2, WINDOW.width / 2 + frameThickness / 2, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.015);
  // Mullion
  addFrame(0.07, WINDOW.height + 0.05, 0, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.018);

  // Glass pane
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(WINDOW.width, WINDOW.height),
    new THREE.MeshPhysicalMaterial({
      color: 0xd8f2ff,
      roughness: 0.05,
      metalness: 0,
      transparent: true,
      opacity: 0.26,
      transmission: 0.18
    })
  );
  glass.position.set(0, WINDOW.bottom + WINDOW.height / 2, WINDOW.z + 0.035);
  scene.add(glass);

  // Roller tube
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, WINDOW.width + 0.25, 20),
    new THREE.MeshStandardMaterial({ color: 0x6d7783, roughness: 0.4 })
  );
  tube.rotation.z = Math.PI / 2;
  tube.position.set(0, WINDOW.bottom + WINDOW.height + 0.17, WINDOW.z + 0.08);
  scene.add(tube);

  // Shade group
  shadeGroup = new THREE.Group();
  shadeGroup.position.set(0, WINDOW.bottom + WINDOW.height, WINDOW.z + 0.095);
  scene.add(shadeGroup);

  // Shade fabric: pivot at top edge (translate geometry)
  const fabricGeom = new THREE.PlaneGeometry(WINDOW.width, SHADE.maxDrop);
  fabricGeom.translate(0, -SHADE.maxDrop / 2, 0);
  // Opaque shade material so it casts a solid shadow (transparent meshes
  // produce binary, less reliable shadow maps).
  shadeFabric = new THREE.Mesh(fabricGeom, new THREE.MeshStandardMaterial({
    color: 0xe7e0d2,
    roughness: 0.95,
    side: THREE.DoubleSide
  }));
  shadeFabric.scale.y = 0.03;
  shadeFabric.castShadow = true;
  shadeFabric.receiveShadow = true;
  shadeGroup.add(shadeFabric);

  // Bottom bar of shade
  shadeBottomBar = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width + 0.12, SHADE.barHeight, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2c333a, roughness: 0.45 })
  );
  shadeBottomBar.castShadow = true;
  shadeBottomBar.receiveShadow = true;
  shadeGroup.add(shadeBottomBar);

  // Visible handle for user (orange bar)
  shadeHandle = new THREE.Mesh(
    new THREE.BoxGeometry(WINDOW.width + 0.18, SHADE.barHeight * 1.2, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xee9955, roughness: 0.5 })
  );
  shadeHandle.position.y = -SHADE.maxDrop * shadeFabric.scale.y - SHADE.barHeight * 1.5;
  shadeGroup.add(shadeHandle);

  // Invisible click target covering shade bottom region
  shadeClickTarget = new THREE.Mesh(
    new THREE.PlaneGeometry(WINDOW.width + 0.4, SHADE.barHeight * 5),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  shadeClickTarget.position.y = -SHADE.maxDrop * shadeFabric.scale.y - SHADE.barHeight * 2.5;
  shadeClickTarget.userData.clickable = 'shade';
  shadeClickTarget.rotation.x = -Math.PI / 2;
  shadeGroup.add(shadeClickTarget);

  updateShadeBar();
}

// Update bottom bar and handle positions whenever shade scale changes.
function updateShadeBar() {
  const drop = SHADE.maxDrop * shadeFabric.scale.y;
  shadeBottomBar.position.y = -drop - SHADE.barHeight / 2;
  shadeHandle.position.y = -drop - SHADE.barHeight * 1.5;
  shadeClickTarget.position.y = -drop - SHADE.barHeight * 2.5;
}

// Builds the desk, chair and laptop.  Colours are muted so that
// interactive devices stand out.
function buildFurniture() {
  // Desk surface.  Rotate the desk 90° so its long axis runs along
  // Z (front‑to‑back).  The top is narrower along X (1.05 m) and
  // deeper along Z (2.65 m).  Place the desk centre at x = -1.40.
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.13, 2.65),
    new THREE.MeshStandardMaterial({ color: 0x9b6b43, roughness: 0.55 })
  );
  top.position.set(-1.40, 0.78, -1.90);
  top.castShadow = true;
  top.receiveShadow = true;
  scene.add(top);
  // Desk legs: reposition to match the rotated desk footprint.  Legs are
  // set at the four corners of the new desk footprint.  Use the same
  // leg material and geometry as before.
  const legGeom = new THREE.BoxGeometry(0.09, 0.76, 0.09);
  const legMat  = new THREE.MeshStandardMaterial({ color: 0x654326, roughness: 0.65 });
  const legPositions = [
    [-1.83, 0.38, -3.12], // back left
    [-0.97, 0.38, -3.12], // back right
    [-1.83, 0.38, -0.68], // front left
    [-0.97, 0.38, -0.68], // front right
  ];
  for (const [x, y, z] of legPositions) {
    const leg = new THREE.Mesh(legGeom, legMat);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    leg.receiveShadow = true;
    scene.add(leg);
  }
  // Chair
  const chair = new THREE.Group();
  // Seat: narrower and centred on the new occupant position.  A low
  // profile helps avoid leg clipping.  The seat aligns with
  // POS.seated.x and POS.seated.z so the occupant sits squarely on it.
  const seat = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.10, 0.62),
    new THREE.MeshStandardMaterial({ color: 0x2f3945, roughness: 0.66 })
  );
  seat.position.set(POS.seated.x, 0.54, POS.seated.z);
  seat.castShadow = true;
  seat.receiveShadow = true;
  chair.add(seat);
  // Backrest: taller and thinner, placed behind the occupant on the
  // +X side (since the occupant faces –X).  A slight lean back gives
  // visual comfort.  The back has the same material as the seat.
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.65, 0.62),
    seat.material
  );
  back.position.set(POS.seated.x + 0.32, 0.89, POS.seated.z);
  back.castShadow = true;
  back.receiveShadow = true;
  chair.add(back);
  // Chair legs: four slender legs.  Positions are chosen so the legs
  // support the seat corners but leave space for the occupant's feet.
  const chairLegGeom = new THREE.BoxGeometry(0.05, 0.44, 0.05);
  const chairLegMat  = new THREE.MeshStandardMaterial({ color: 0x555e6a, roughness: 0.6 });
  const legCoords = [
    [-0.48, -2.18],
    [ 0.08, -2.18],
    [-0.48, -1.62],
    [ 0.08, -1.62],
  ];
  for (const [lx, lz] of legCoords) {
    const leg = new THREE.Mesh(chairLegGeom, chairLegMat);
    leg.position.set(lx, 0.27, lz);
    leg.castShadow = true;
    leg.receiveShadow = true;
    chair.add(leg);
  }
  scene.add(chair);

  // Laptop prop on the desk.  When the desk is rotated, position the
  // laptop near the occupant side (along +Z direction) on the desk.
  const laptopBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.025, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: 0.4 })
  );
  laptopBase.position.set(-1.20, 0.845, -2.10);
  laptopBase.castShadow = true;
  laptopBase.receiveShadow = true;
  scene.add(laptopBase);
  const laptopScreen = new THREE.Mesh(
    new THREE.BoxGeometry(0.025, 0.28, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.35, emissive: 0x0a1520, emissiveIntensity: 0.4 })
  );
  laptopScreen.position.set(-1.42, 1.00, -2.10);
  laptopScreen.castShadow = true;
  laptopScreen.receiveShadow = true;
  scene.add(laptopScreen);
}

// Builds the occupant out of simple primitives.  Arms are stored in
// userData for animation.
function buildOccupant() {
  occupant = new THREE.Group();
  const skinMat  = new THREE.MeshStandardMaterial({ color: 0xf4c29a, roughness: 0.6 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: 0x3572b3, roughness: 0.6 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: 0x2a3548, roughness: 0.7 });
  const shoeMat  = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });

  // Torso: extends up from pelvis (origin)
  const torsoH = 0.55;
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.40, torsoH, 0.22), shirtMat
  );
  torso.position.set(0, torsoH / 2, 0);
  torso.castShadow = true;
  occupant.add(torso);

  // Neck + head
  const headR = 0.15;
  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 16, 16), skinMat);
  head.position.set(0, torsoH + 0.06 + headR, 0);
  head.castShadow = true;
  occupant.add(head);

  // Build a jointed arm: shoulder pivot → upper arm → elbow pivot → forearm.
  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.22, torsoH - 0.05, 0);
    const upper = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.26, 0.09), shirtMat
    );
    upper.position.set(0, -0.13, 0); // hangs down from shoulder
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.26, 0);
    const fore = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.26, 0.08), skinMat
    );
    fore.position.set(0, -0.13, 0);
    fore.castShadow = true;
    elbow.add(fore);
    shoulder.add(elbow);
    occupant.add(shoulder);
    return { shoulder, elbow };
  }

  // Build a jointed leg: hip pivot → thigh → knee pivot → shin + shoe.
  function makeLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.10, 0, 0);
    const thigh = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.40, 0.13), pantsMat
    );
    thigh.position.set(0, -0.20, 0);
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.set(0, -0.40, 0);
    const shin = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.40, 0.11), pantsMat
    );
    shin.position.set(0, -0.20, 0);
    shin.castShadow = true;
    knee.add(shin);
    const shoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.06, 0.22), shoeMat
    );
    shoe.position.set(0, -0.43, -0.05);
    shoe.castShadow = true;
    knee.add(shoe);
    hip.add(knee);
    occupant.add(hip);
    return { hip, knee };
  }

  const lArm = makeArm(-1);
  const rArm = makeArm( 1);
  const lLeg = makeLeg(-1);
  const rLeg = makeLeg( 1);

  // Apply posture: 0 = seated (hips & knees bent ~90°), 1 = standing.
  // Local forward is -Z (away from camera in occupant frame).  Hip rotates
  // +π/2 around X to swing thighs forward; knee rotates -π/2 to swing shins
  // back down to the floor. While standing, an additional stride swing is
  // overlaid for walking.
  function applyPosture(p) {
    const stride = (occupant.userData && occupant.userData.stride) || 0;
    const seatHip  = (1 - p) * ( Math.PI / 2);
    const seatKnee = (1 - p) * (-Math.PI / 2);
    // Stride scales with how upright we are (no leg swing while seated)
    const sw = stride * p;
    lLeg.hip.rotation.x  = seatHip + sw;
    rLeg.hip.rotation.x  = seatHip - sw;
    lLeg.knee.rotation.x = seatKnee - Math.max(0,  sw) * 0.6;
    rLeg.knee.rotation.x = seatKnee - Math.max(0, -sw) * 0.6;
    // Arms: when seated reach forward to the laptop; when walking swing
    // opposite to the legs for balance.
    const seatShoulder = (1 - p) * ( Math.PI / 4);
    const seatElbow    = (1 - p) * ( Math.PI / 2.5);
    const armSwing = -sw * 0.6;
    lArm.shoulder.rotation.x = seatShoulder + armSwing;
    rArm.shoulder.rotation.x = seatShoulder - armSwing;
    lArm.elbow.rotation.x    = seatElbow;
    rArm.elbow.rotation.x    = seatElbow;
  }
  applyPosture(0);

  // Annoyance indicator above the head: a yellow anger burst with a red "!".
  // Hidden by default; faded in while the occupant overrides automation.
  const angryCanvas = document.createElement('canvas');
  angryCanvas.width = 256; angryCanvas.height = 256;
  const actx = angryCanvas.getContext('2d');
  actx.fillStyle = '#ffd23f';
  actx.beginPath();
  const cx = 128, cy = 128, spikes = 10;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? 110 : 60;
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) actx.moveTo(x, y); else actx.lineTo(x, y);
  }
  actx.closePath();
  actx.fill();
  actx.strokeStyle = '#c9302c'; actx.lineWidth = 8; actx.stroke();
  actx.fillStyle = '#c9302c';
  actx.font = 'bold 130px sans-serif';
  actx.textAlign = 'center';
  actx.textBaseline = 'middle';
  actx.fillText('!', cx, cy + 8);
  const angryTex = new THREE.CanvasTexture(angryCanvas);
  const angrySprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: angryTex, transparent: true, opacity: 0, depthTest: false
  }));
  angrySprite.scale.set(0.45, 0.45, 1);
  angrySprite.position.set(0, torsoH + 0.06 + headR * 2 + 0.25, 0);
  angrySprite.renderOrder = 999;
  occupant.add(angrySprite);

  occupant.userData = {
    leftArm:  lArm.shoulder,
    rightArm: rArm.shoulder,
    leftElbow:  lArm.elbow,
    rightElbow: rArm.elbow,
    leftHip:   lLeg.hip,
    rightHip:  rLeg.hip,
    leftKnee:  lLeg.knee,
    rightKnee: rLeg.knee,
    posture: 0,
    reach: 0,
    basePos: new THREE.Vector3().copy(POS.seated),
    applyPosture,
    angrySprite,
    angryBaseY: torsoH + 0.06 + headR * 2 + 0.25
  };

  // Sit on the chair, facing the desk: desk is at world -X, so rotate +π/2
  // so the body's forward direction (-Z local) maps to world -X.  Legs and
  // arms swing forward in local -Z, also mapping to world -X (toward desk).
  occupant.position.set(POS.seated.x, SEAT_Y, POS.seated.z);
  occupant.rotation.y = Math.PI / 2;
  scene.add(occupant);
}

// Build the AC split unit and thermostat on the right wall.
function buildACAndThermostat() {
  const wallX = ROOM.w / 2;
  const unitZ = -1.50;
  const wallInner = wallX - 0.04; // inner face of right wall
  const acLen = 1.35; // along Z (parallel to wall)
  const acH = 0.36;
  const acDepth = 0.28; // sticks into room along -X

  // AC main body — horizontal split unit hanging on the right wall, sticking
  // into the room.  No Y rotation; geometry uses world axes directly.
  const acBody = new THREE.Mesh(
    new THREE.BoxGeometry(acDepth, acH, acLen),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.4 })
  );
  acBody.position.set(wallInner - acDepth / 2, 2.85, unitZ);
  acBody.castShadow = true;
  scene.add(acBody);
  acUnitMesh = acBody;

  // Front face (camera side): slightly darker top trim with intake slits
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(acDepth + 0.005, 0.04, acLen + 0.005),
    new THREE.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.5 })
  );
  trim.position.set(wallInner - acDepth / 2, 2.85 + acH / 2 - 0.02, unitZ);
  scene.add(trim);

  // Bottom louvre opening: a dark recessed slot beneath the body
  const louvreCavity = new THREE.Mesh(
    new THREE.BoxGeometry(acDepth - 0.06, 0.06, acLen - 0.10),
    new THREE.MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.9 })
  );
  louvreCavity.position.set(wallInner - acDepth / 2, 2.85 - acH / 2 - 0.005, unitZ);
  scene.add(louvreCavity);

  // Animated louvre slats inside the cavity.  These tilt while the AC runs.
  acGrilleGroup = new THREE.Group();
  scene.add(acGrilleGroup);
  const numSlats = 5;
  for (let i = 0; i < numSlats; i++) {
    const slat = new THREE.Mesh(
      new THREE.BoxGeometry(acDepth - 0.08, 0.012, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xc8d0d8, roughness: 0.5 })
    );
    const slatZ = unitZ - (acLen - 0.20) / 2 + (i + 0.5) * (acLen - 0.20) / numSlats;
    slat.position.set(wallInner - acDepth / 2, 2.85 - acH / 2 - 0.01, slatZ);
    acGrilleGroup.add(slat);
  }

  // LED indicator on the front-bottom-right of the body — pulses while running
  acLedMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x00bfff, emissive: 0x00bfff, emissiveIntensity: 1.4, roughness: 0.2 })
  );
  acLedMesh.position.set(wallInner - acDepth - 0.005, 2.85 - acH / 2 + 0.06, unitZ + acLen / 2 - 0.10);
  scene.add(acLedMesh);

  // Airflow streams: thin cyan ribbons that descend from the louvre when the AC runs
  acAirflowGroup = new THREE.Group();
  scene.add(acAirflowGroup);
  for (let i = 0; i < 6; i++) {
    const stream = new THREE.Mesh(
      new THREE.PlaneGeometry(0.10, 0.55),
      new THREE.MeshBasicMaterial({
        color: 0x9fdcff, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    const sZ = unitZ - (acLen - 0.30) / 2 + i * (acLen - 0.30) / 5;
    stream.position.set(wallInner - acDepth / 2, 2.85 - acH / 2 - 0.35, sZ);
    stream.rotation.y = Math.PI / 2;
    stream.userData.baseZ = sZ;
    stream.userData.phase = i * 0.6;
    acAirflowGroup.add(stream);
  }

  // Thermostat housing — larger and offset from wall so it is visible
  thermMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.30, 0.22),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.3 })
  );
  thermMesh.position.set(wallX - 0.13, 1.28, unitZ);
  thermMesh.rotation.y = -Math.PI / 2;
  scene.add(thermMesh);

  // Thermostat display canvas
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  drawThermDisplay(ctx, 22.0, 'COOL');
  thermDisplay = new THREE.CanvasTexture(canvas);
  thermDisplay.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.20, 0.26),
    new THREE.MeshBasicMaterial({ map: thermDisplay })
  );
  screen.position.set(wallX - 0.17, 1.28, unitZ);
  screen.rotation.y = -Math.PI / 2;
  scene.add(screen);

  // Thermostat click target — generous plane facing the user
  const tGeo = new THREE.PlaneGeometry(0.70, 0.80);
  thermClickTarget = new THREE.Mesh(
    tGeo,
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  thermClickTarget.position.set(wallX - 0.25, 1.28, unitZ);
  thermClickTarget.rotation.y = -Math.PI / 2;
  thermClickTarget.userData.clickable = 'therm';
  scene.add(thermClickTarget);
}

// Draws the thermostat screen.  Called whenever the RL agent or
// occupant changes the setpoint.  Mode should be 'COOL' or 'HEAT'.
function drawThermDisplay(ctx, temp, mode) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, 256, 320);
  const modeColor = mode === 'COOL' ? '#00bfff'
                  : mode === 'HEAT' ? '#ff6b35'
                  : '#bbbbbb';
  ctx.fillStyle = modeColor;
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(temp == null ? 'OFF' : `${temp.toFixed(1)}°C`, 128, 120);
  ctx.fillStyle = '#aaaaaa';
  ctx.font = '28px monospace';
  ctx.fillText(mode, 128, 180);
  ctx.fillText('AUTO', 128, 230);
}

// Build the light switch on the right wall near the front of the room.
function buildLightSwitch() {
  const wallX = ROOM.w / 2;
  const z = 1.00;
  const y = 1.20;
  // Switch plate — protrudes clearly from the wall surface
  switchPlateMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.20, 0.14),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  );
  switchPlateMesh.position.set(wallX - 0.10, y, z);
  switchPlateMesh.rotation.y = -Math.PI / 2;
  scene.add(switchPlateMesh);
  // Rocker/lever — small box that tilts up/down
  switchLeverMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.045, 0.10, 0.07),
    new THREE.MeshStandardMaterial({ color: 0xfffde7, roughness: 0.35 })
  );
  switchLeverMesh.position.set(wallX - 0.155, y, z);
  switchLeverMesh.rotation.y = -Math.PI / 2;
  switchLeverMesh.rotation.z = -0.25;
  scene.add(switchLeverMesh);
  // Click target — generous area to make clicking easier
  const sGeo = new THREE.PlaneGeometry(0.55, 0.55);
  switchClickTarget = new THREE.Mesh(
    sGeo,
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  switchClickTarget.position.set(wallX - 0.22, y, z);
  switchClickTarget.rotation.y = -Math.PI / 2;
  switchClickTarget.userData.clickable = 'switch';
  scene.add(switchClickTarget);
  // Add a small label above the switch
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 128;
  labelCanvas.height = 48;
  const lctx = labelCanvas.getContext('2d');
  lctx.fillStyle = '#ffffff';
  lctx.font = 'bold 18px monospace';
  lctx.textAlign = 'center';
  lctx.fillText('LIGHTS', 64, 32);
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.08),
    new THREE.MeshBasicMaterial({ map: labelTex, transparent: true })
  );
  label.position.set(wallX - 0.155, y + 0.18, z);
  label.rotation.y = -Math.PI / 2;
  scene.add(label);
}

// Build a potted plant in the back‑left corner.  The pot consists of a
// base, rim and soil.  Several stems rise from the soil and support
// layered foliage.  Colours are earthy greens and browns to contrast
// with the room.
function buildPlant() {
  const cornerX = -ROOM.w / 2 + 0.55;
  const cornerZ = -ROOM.d / 2 + 0.55;
  // Pot base
  const potBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.32, 0.36),
    new THREE.MeshStandardMaterial({ color: 0x8b5e3c, roughness: 0.85 })
  );
  potBase.position.set(cornerX, 0.16, cornerZ);
  potBase.castShadow = potBase.receiveShadow = true;
  scene.add(potBase);
  // Pot rim
  const potRim = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.06, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8 })
  );
  potRim.position.set(cornerX, 0.34, cornerZ);
  potRim.castShadow = potRim.receiveShadow = true;
  scene.add(potRim);
  // Soil surface
  const soil = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.02, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.95 })
  );
  soil.position.set(cornerX, 0.38, cornerZ);
  soil.castShadow = soil.receiveShadow = true;
  scene.add(soil);
  // Stems
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a6741, roughness: 0.8 });
  const stems = [
    [0, 0, 1.1],
    [-0.08, 0.06, 0.9],
    [0.07, -0.05, 1.0],
  ];
  stems.forEach(([ox, oz, h]) => {
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.03, h, 7),
      stemMat
    );
    stem.position.set(cornerX + ox, 0.38 + h / 2, cornerZ + oz);
    stem.castShadow = true;
    scene.add(stem);
  });
  // Foliage
  const leafColors = [0x3a7d44, 0x4a9055, 0x2d6b38];
  const foliageDefs = [
    [0,     1.45, 0,     0.38, 0],
    [-0.12, 1.20, 0.08,  0.28, 1],
    [0.10,  1.30, -0.06, 0.30, 2],
    [0,     0.85, 0,     0.22, 1],
  ];
  foliageDefs.forEach(([ox, oy, oz, r, ci]) => {
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(r, 9, 7),
      new THREE.MeshStandardMaterial({ color: leafColors[ci], roughness: 0.85 })
    );
    leaf.position.set(cornerX + ox, oy, cornerZ + oz);
    leaf.castShadow = true;
    scene.add(leaf);
  });
}

// Build a bookshelf against the left wall.  The unit has a back panel,
// three shelves, side panels and an assortment of colourful books.  A
// small ornament sits on the top shelf.
function buildBookshelf() {
  const wallX = -ROOM.w / 2 + 0.14;
  const shelfZ = 1.20;
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3a, roughness: 0.75 });
  // Back panel
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 1.80, 1.10),
    shelfMat
  );
  back.position.set(wallX - 0.02, 1.10, shelfZ);
  back.castShadow = back.receiveShadow = true;
  scene.add(back);
  // Shelves
  const shelfYs = [0.30, 0.85, 1.40];
  shelfYs.forEach((y) => {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.04, 1.10),
      shelfMat
    );
    board.position.set(wallX + 0.08, y, shelfZ);
    board.castShadow = board.receiveShadow = true;
    scene.add(board);
  });
  // Side panels
  const sideGeom = new THREE.BoxGeometry(0.22, 1.80, 0.06);
  const leftSide = new THREE.Mesh(sideGeom, shelfMat);
  leftSide.position.set(wallX + 0.08, 1.10, shelfZ - 0.52);
  leftSide.castShadow = leftSide.receiveShadow = true;
  scene.add(leftSide);
  const rightSide = leftSide.clone();
  rightSide.position.set(wallX + 0.08, 1.10, shelfZ + 0.52);
  scene.add(rightSide);
  // Books
  const bookColors = [
    0xc0392b, 0x2980b9, 0x27ae60, 0xe67e22, 0x8e44ad,
    0x16a085, 0xd35400, 0x2c3e50, 0xf39c12, 0x1abc9c,
    0x6c3483, 0x117a65, 0xcb4335, 0x1f618d, 0x239b56,
  ];
  let bookIndex = 0;
  shelfYs.forEach((y) => {
    let zOffset = -0.45;
    while (zOffset < 0.42) {
      const w  = 0.055 + Math.random() * 0.04;
      const h  = 0.18  + Math.random() * 0.12;
      const color = bookColors[bookIndex % bookColors.length];
      bookIndex++;
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, h, w),
        new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
      );
      book.position.set(wallX + 0.13, y + h / 2 + 0.02, shelfZ + zOffset + w / 2);
      book.castShadow = book.receiveShadow = true;
      scene.add(book);
      zOffset += w + 0.008;
    }
  });
  // Ornament on the top shelf
  const ornament = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.3, metalness: 0.6 })
  );
  ornament.position.set(wallX + 0.13, 1.40 + 0.04 + 0.07 + 0.04, shelfZ + 0.38);
  ornament.castShadow = true;
  scene.add(ornament);
}

// Update the lever orientation and colour based on switchOn boolean.
function updateSwitchVisual() {
  if (!switchLeverMesh) return;
  // Tilt and recolour the lever: up for ON (warm off‑white), down for OFF (gray).
  switchLeverMesh.rotation.z = switchOn ? -0.25 : 0.25;
  switchLeverMesh.material.color.setHex(switchOn ? 0xfffde7 : 0x8f8f8f);
  // Adjust all indoor lights when toggling the switch.  When OFF, the
  // ceiling light and room fill lights should emit no light at all.  A
  // small ambient hemisphere remains to avoid total darkness, but is
  // dimmed.  Also update the ceiling fixture appearance so it glows only
  // when the light is on.
  // Only toggle the artificial ceiling fixture.  Hemisphere & roomFillLight
  // are driven by updateDaylight (sun + shade), which already accounts for
  // switchOn for the sky-component contribution.
  if (ceilingLight) {
    ceilingLight.intensity = switchOn ? 0.95 : 0.0;
  }
  if (ceilingFixtureMesh && ceilingFixtureMesh.material) {
    ceilingFixtureMesh.material.emissiveIntensity = switchOn ? 0.6 : 0.0;
    ceilingFixtureMesh.material.color.setHex(switchOn ? 0xffffff : 0x888888);
  }
}

/* -----------------------------------------------------------------
 * Interaction and sequencing
 * ----------------------------------------------------------------- */

// Determine which device is under the pointer.  Returns a string
// identifier or null.
function getClickedDevice(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // Shade
  if (raycaster.intersectObjects([shadeClickTarget, shadeHandle, shadeBottomBar], false).length > 0) {
    return 'shade';
  }
  // Thermostat
  if (thermClickTarget && raycaster.intersectObject(thermClickTarget, false).length > 0) {
    return 'therm';
  }
  // Switch
  if (switchClickTarget && raycaster.intersectObject(switchClickTarget, false).length > 0) {
    return 'switch';
  }
  return null;
}

function onPointerMove(event) {
  if (state !== 'idle') {
    renderer.domElement.style.cursor = 'default';
    return;
  }
  const device = getClickedDevice(event);
  renderer.domElement.style.cursor = device ? 'pointer' : 'default';
}

function onPointerDown(event) {
  if (state !== 'idle') return;
  const device = getClickedDevice(event);
  if (device === 'shade')      commandShadeToggle();
  else if (device === 'therm') commandThermCycle();
  else if (device === 'switch') commandLightsToggle();
}

/* -----------------------------------------------------------------
 * Player commands — write to the simulation, no scripted occupant.
 * ----------------------------------------------------------------- */

function commandShadeToggle() {
  if (state !== 'idle') return;
  const cmds = getCommands();
  setShadeCmd(cmds.shade > 0.4 ? 0.05 : 0.7);
}

// null means thermostat OFF.
const SETPOINT_CYCLE = [null, 20, 22, 24, 26];
function commandThermCycle() {
  if (state !== 'idle') return;
  const cmds = getCommands();
  let idx = SETPOINT_CYCLE.findIndex(v => v === cmds.setpoint);
  if (idx < 0) idx = 0;
  setSetpointCmd(SETPOINT_CYCLE[(idx + 1) % SETPOINT_CYCLE.length]);
}

function commandLightsToggle() {
  if (state !== 'idle') return;
  const cmds = getCommands();
  setLightsCmd(!cmds.lights);
}

// Sequence for roller shade: RL lowers shade; occupant stands, walks to
// window, raises shade and returns.
/* -----------------------------------------------------------------
 * Occupant override animations.  Triggered by the FSM in dataSource
 * when patience runs out.  At the "reach" frame we commit the
 * occupant's hidden preference into the actuator command, so the
 * rest of the simulation immediately uses the new value.
 * ----------------------------------------------------------------- */

function startOverrideAnim(target) {
  if (target === 'shade')           playShadeOverride();
  else if (target === 'thermostat') playThermOverride();
  else if (target === 'lights')     playLightsOverride();
}

function playShadeOverride() {
  clear();
  setButtons(false);
  state = 'overriding';
  setStatus('occupant gets up — shade');
  animatePosture(0, 1, 850, () => {
    setStatus('occupant walks to the window');
    animateMovePath([POS.standDesk, POS.aisle, POS.windowApproach, POS.window], 2200, () => {
      setStatus('occupant adjusts the shade');
      animateReach(0, 1, 350, () => {
        applyOccupantOverride('shade');
        reportOccupantOverride('shade', 'pref');
        animateReach(1, 0, 350, () => {
          setStatus('occupant returns to desk');
          animateMovePath([POS.window, POS.windowApproach, POS.aisle, POS.standDesk], 2200, () => {
            animatePosture(1, 0, 850, finishOverride);
          });
        });
      });
    });
  });
}

function playThermOverride() {
  clear();
  setButtons(false);
  state = 'overriding';
  setStatus('occupant gets up — thermostat');
  animatePosture(0, 1, 850, () => {
    setStatus('occupant walks to the thermostat');
    animateMovePath([POS.standDesk, POS.aisle, POS.thermAisle, POS.thermApproach], 2200, () => {
      setStatus('occupant adjusts the thermostat');
      animateReach(0, 1, 400, () => {
        applyOccupantOverride('thermostat');
        reportOccupantOverride('thermostat', 'pref');
        animateReach(1, 0, 400, () => {
          setStatus('occupant returns to desk');
          animateMovePath([POS.thermApproach, POS.thermAisle, POS.aisle, POS.standDesk], 2200, () => {
            animatePosture(1, 0, 850, finishOverride);
          });
        });
      });
    });
  });
}

function playLightsOverride() {
  clear();
  setButtons(false);
  state = 'overriding';
  setStatus('occupant gets up — lights');
  animatePosture(0, 1, 850, () => {
    setStatus('occupant walks to the light switch');
    animateMovePath([POS.standDesk, POS.aisle, POS.switchAisle, POS.switchApproach], 2000, () => {
      setStatus('occupant flips the switch');
      animateReach(0, 1, 400, () => {
        applyOccupantOverride('lights');
        reportOccupantOverride('lights', 'pref');
        animateReach(1, 0, 400, () => {
          setStatus('occupant returns to desk');
          animateMovePath([POS.switchApproach, POS.switchAisle, POS.aisle, POS.standDesk], 2000, () => {
            animatePosture(1, 0, 850, finishOverride);
          });
        });
      });
    });
  });
}

function finishOverride() {
  endOverride();
  state = 'idle';
  setStatus('waiting for interaction');
  setButtons(true);
}

/* -----------------------------------------------------------------
 * Animation helpers
 * ----------------------------------------------------------------- */

// Add a new animation task to the queue
function addAnimation({ duration, update, onComplete }) {
  animations.push({
    start: performance.now(),
    duration,
    update,
    onComplete
  });
}

// Clear all pending animations
function clear() {
  animations.length = 0;
}

// Animate shade fabric to target scale.y
function animateShadeTo(target, duration, onComplete) {
  const startScale = shadeFabric.scale.y;
  addAnimation({
    duration,
    update: (t) => {
      const eased = easeInOutCubic(t);
      shadeFabric.scale.y = THREE.MathUtils.lerp(startScale, target, eased);
      updateShadeBar();
    },
    onComplete
  });
}

// Animate occupant posture (0–1).  Adjust posture property; y position
// will be applied in animateMovePath via occupant.userData.posture.
function animatePosture(from, to, duration, onComplete) {
  addAnimation({
    duration,
    update: (t) => {
      const eased = easeInOutCubic(t);
      occupant.userData.posture = THREE.MathUtils.lerp(from, to, eased);
    },
    onComplete
  });
}

// Animate occupant reach (0–1).  Arms rotate to simulate reaching.
function animateReach(from, to, duration, onComplete) {
  addAnimation({
    duration,
    update: (t) => {
      const eased = easeInOutCubic(t);
      occupant.userData.reach = THREE.MathUtils.lerp(from, to, eased);
      updateArms();
    },
    onComplete: () => {
      // ensure final arms rotation
      updateArms();
      if (onComplete) onComplete();
    }
  });
}

function updateArms() {
  const r = occupant.userData.reach || 0;
  // raise arms: 0 = down, 1 = up
  occupant.userData.leftArm.rotation.z = -0.5 * r;
  occupant.userData.rightArm.rotation.z =  0.5 * r;
}

// Move occupant along a path of waypoints over a duration.  The
// occupant's base position is stored in userData.basePos; posture is
// applied as a vertical offset.
function animateMovePath(path, duration, onComplete) {
  // Precompute segment lengths
  const segLen = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = path[i].distanceTo(path[i + 1]);
    segLen.push(d);
    total += d;
  }
  occupant.userData.walking = true;
  addAnimation({
    duration,
    update: (t) => {
      // distance along entire path
      const s = t * total;
      let acc = 0;
      let i = 0;
      while (i < segLen.length && acc + segLen[i] < s) {
        acc += segLen[i];
        i++;
      }
      const segmentFraction = segLen[i] === 0 ? 0 : (s - acc) / segLen[i];
      const start = path[i].clone();
      const end   = path[i + 1].clone();
      occupant.userData.basePos.copy(start.lerp(end, segmentFraction));
      // Face direction of motion: body's forward is local -Z, so atan2 + π
      const dir = end.clone().sub(start);
      if (dir.lengthSq() > 1e-6) {
        const yaw = Math.atan2(dir.x, dir.z);
        occupant.rotation.y = yaw + Math.PI;
      }
      // Vertical position: lerp between seated (SEAT_Y) and standing (STAND_Y)
      const basePos = occupant.userData.basePos;
      const p = occupant.userData.posture;
      const y = SEAT_Y + (STAND_Y - SEAT_Y) * p;
      occupant.position.set(basePos.x, y, basePos.z);
    },
    onComplete: () => {
      occupant.userData.walking = false;
      occupant.userData.stride = 0;
      if (onComplete) onComplete();
    }
  });
}

/* -----------------------------------------------------------------
 * Render loop
 * ----------------------------------------------------------------- */

function animate() {
  requestAnimationFrame(animate);
  const simState = getState();
  // Annoyance cue: visible whenever the occupant is not satisfied.
  // Stays on while overriding so the player sees the angry burst tracking
  // the occupant as they get up to fix the system.
  if (occupant && occupant.userData.angrySprite) {
    const occState = simState.occupant.state;
    const target = (occState === 'overriding' || simState.occupant.discomfort > 0.05) ? 1 : 0;
    const sprite = occupant.userData.angrySprite;
    sprite.material.opacity += (target - sprite.material.opacity) * 0.12;
    const bob = Math.sin(performance.now() * 0.009) * 0.05;
    sprite.position.y = occupant.userData.angryBaseY + bob;
    const wobble = 1 + Math.sin(performance.now() * 0.015) * 0.08;
    sprite.scale.set(0.45 * wobble, 0.45 * wobble, 1);
  }
  // Apply current posture (jointed limbs) every frame so seated/standing pose
  // holds even when no movement animation is active.  Drive a stride swing
  // while walking.
  if (occupant && occupant.userData.applyPosture) {
    occupant.userData.stride = occupant.userData.walking
      ? Math.sin(performance.now() * 0.012) * 0.7
      : 0;
    occupant.userData.applyPosture(occupant.userData.posture);
    // Y position: keep occupant on chair when posture==0
    const basePos = occupant.userData.basePos;
    const p = occupant.userData.posture;
    const y = SEAT_Y + (STAND_Y - SEAT_Y) * p;
    occupant.position.set(basePos.x, y, basePos.z);
  }
  // Drive device visuals from the simulation state so the player can see
  // their commands take effect (and watch the IEQ react).
  if (shadeFabric) {
    shadeFabric.scale.y = simState.shadePosition;
    updateShadeBar();
  }
  if (switchOn !== simState.lightsOn) {
    switchOn = simState.lightsOn;
    updateSwitchVisual();
  }
  if (acRunning !== simState.acRunning) {
    updateACVisual(simState.acRunning);
  }
  updateThermDisplay(simState.thermostatSetpoint, simState.thermostatMode);

  // FSM watcher: when the occupant decides to override and we're idle,
  // kick off the corresponding walk-and-reach animation.
  if (state === 'idle' && simState.occupant.pendingTarget) {
    startOverrideAnim(simState.occupant.pendingTarget);
  }

  // Update HUD cards, narrative and mode badge based on current state.
  updateHUD(simState);
  // Update daylight (sun position, sky colour, ambient lighting) based
  // on the current time of day and the state of the light switch.
  updateDaylight(simState);

  const now = performance.now();
  // Process queued animation tasks.  Each task runs for its specified
  // duration and is removed when complete.  This drives the occupant
  // walking, shade movement and reaching animations.
  for (let i = animations.length - 1; i >= 0; i--) {
    const anim = animations[i];
    const t = Math.min(1, (now - anim.start) / anim.duration);
    anim.update(t);
    if (t >= 1) {
      animations.splice(i, 1);
      if (anim.onComplete) anim.onComplete();
    }
  }
  // AC louvre animation: oscillate slats while the AC is running to
  // give a subtle sense of airflow.  The group contains all slats
  // added in buildACAndThermostat().
  if (acGrilleGroup) {
    const angle = acRunning ? Math.sin(now * 0.002) * 0.45 : 0;
    acGrilleGroup.children.forEach((slat) => {
      slat.rotation.x = angle;
    });
  }
  // Airflow streams: fade & drift downward while running.  Colour is
  // driven by AC mode — blue for cooling, orange for heating, white when
  // the AC is idle.
  if (acAirflowGroup) {
    const mode = simState.thermostatMode;
    const flowColor = mode === 'COOL' ? 0x9fdcff
                    : mode === 'HEAT' ? 0xffb070
                    : 0xffffff;
    acAirflowGroup.children.forEach((stream) => {
      stream.material.color.setHex(flowColor);
      if (acRunning) {
        const phase = (now * 0.0018 + stream.userData.phase) % 1;
        stream.position.y = 2.85 - 0.36 / 2 - 0.05 - phase * 0.85;
        stream.material.opacity = (1 - phase) * 0.55;
      } else {
        stream.material.opacity = 0;
      }
    });
  }
  // LED pulse + colour while running.  Cool → blue, heat → orange, off → dim.
  if (acLedMesh) {
    const mode = simState.thermostatMode;
    if (acRunning) {
      const ledColor = mode === 'HEAT' ? 0xff6b35 : 0x00bfff;
      acLedMesh.material.color.setHex(ledColor);
      acLedMesh.material.emissive.setHex(ledColor);
      const pulse = 0.9 + Math.sin(now * 0.006) * 0.5;
      acLedMesh.material.emissiveIntensity = pulse;
    }
  }
  // Render the scene from the current camera viewpoint.  The camera
  // remains locked so the user cannot pan or zoom.
  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* -----------------------------------------------------------------
 * Utility functions
 * ----------------------------------------------------------------- */

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = `Status: ${text}`;
}

// Enable or disable all control buttons.  When a sequence is running,
// all user input should be disabled to prevent overlapping actions.
function setButtons(enabled) {
  const btns = [shadeBtnEl, thermBtnEl, lightBtnEl];
  btns.forEach((btn) => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1.0' : '0.5';
    btn.style.cursor = enabled ? 'pointer' : 'default';
  });
}

function updateThermDisplay(temp, mode) {
  const canvas = thermDisplay?.image;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  drawThermDisplay(ctx, temp, mode);
  thermDisplay.needsUpdate = true;
}

// Update the AC unit visual state.  When the AC is running, the LED
// glows bright blue and the slats gently oscillate to suggest airflow.
// When off, the LED dims and slats remain stationary.  The acRunning
// flag is toggled here and read in the animate() loop.
function updateACVisual(on) {
  acRunning = on;
  if (!acLedMesh) return;
  // LED colour and emissive power
  acLedMesh.material.color.setHex(on ? 0x00bfff : 0x334444);
  acLedMesh.material.emissive.setHex(on ? 0x00bfff : 0x000000);
  acLedMesh.material.emissiveIntensity = on ? 1.2 : 0.0;
}

// Update the heads‑up display with live simulation metrics and actuator states.
function updateHUD(simState) {
  // Update the heads‑up display with live simulation metrics and actuator states.
  // This function is called every frame and does not mutate the simulation.
  if (!simState) return;
  // Format time of day into HH:MM (24‑hour clock) and update the time card.
  const hrs = Math.floor(simState.timeOfDay);
  const mins = Math.floor((simState.timeOfDay % 1) * 60);
  const timeString = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  if (valTimeEl) valTimeEl.textContent = timeString;
  // Comfort metrics from the data source.  Round values appropriately.
  if (valPmvEl) valPmvEl.textContent  = simState.pmv.toFixed(2);
  if (valTempEl) valTempEl.textContent = `${simState.temperature.toFixed(1)}°C`;
  if (valCo2El) valCo2El.textContent   = `${Math.round(simState.co2)}ppm`;
  if (valLuxEl) valLuxEl.textContent   = `${Math.round(simState.illuminance)}`;
  if (valHumEl) valHumEl.textContent   = `${Math.round(simState.humidity)}%`;
  // Actuator state cards.  Shade percentage is derived from the current
  // shade mesh scale; thermostat setpoint and mode come from the
  // simulation state; lighting and AC states use module globals.
  const shadePct = Math.round(shadeFabric.scale.y * 100);
  if (valShadeEl) valShadeEl.textContent = shadePct >= 50 ? 'Down' : 'Up';
  if (valLightsEl) valLightsEl.textContent = switchOn ? 'ON' : 'OFF';
  if (valAcEl) valAcEl.textContent = acRunning ? 'ON' : 'OFF';
  if (valThermEl) {
    valThermEl.textContent = simState.thermostatSetpoint == null
      ? 'OFF'
      : `${simState.thermostatSetpoint.toFixed(1)}°C`;
  }
  if (annoyanceBarEl) annoyanceBarEl.style.width = `${(simState.occupant.patience01 * 100).toFixed(0)}%`;
  // Narrative reacts to the occupant's FSM state without revealing prefs.
  if (narrativeEl) {
    let narrative;
    if (simState.occupant.state === 'overriding') {
      narrative = '😤 Too late — they got up to fix it themselves.';
    } else if (simState.occupant.state === 'annoyed') {
      narrative = '⚠️ Something\'s off. Try a different setting before they snap.';
    } else if (simState.pmv > 0.6) {
      narrative = '🔥 It\'s getting warm in here — act fast.';
    } else if (simState.pmv < -0.6) {
      narrative = '🥶 Brr! Warm it up.';
    } else {
      narrative = '🕹️ Control the blinds, thermostat, and lights — keep the occupant happy. Can you crack their comfort code?';
    }
    narrativeEl.textContent = narrative;
  }
  // Mode badge highlights when the occupant has taken over.
  if (modeBadgeEl) {
    if (simState.occupant.state === 'overriding') {
      modeBadgeEl.style.background = '#d35400';
      modeBadgeEl.textContent = '🙋 OCCUPANT OVERRIDING YOU';
    } else if (simState.occupant.state === 'annoyed') {
      modeBadgeEl.style.background = '#c0922a';
      modeBadgeEl.textContent = '⚠️ OCCUPANT GETTING ANNOYED';
    } else {
      modeBadgeEl.style.background = '#1a6bb5';
      modeBadgeEl.textContent = '🎮 YOU ARE THE AUTOMATION';
    }
  }
}

// Update daylight conditions based on the current time of day.  The
// sun's position, intensity and colour change smoothly throughout
// the day.  The sky colour and ambient lighting are also adjusted.
function updateDaylight(simState) {
  if (!sunLight || !simState) return;
  const t = simState.timeOfDay;
  // Daylight curve over working hours (8–18). Peaks at midday.
  const daylightFactor = (t - 6) / 14;          // 0 at 6am, 1 at 8pm
  const angle = daylightFactor * Math.PI;
  const sunCurve = Math.max(0, Math.sin(angle));
  // Sun travels east → west across the sky.  Always behind the south wall.
  const sunX = -Math.cos(angle) * 5;
  const sunY = Math.sin(angle) * 10;
  sunLight.position.set(sunX, Math.max(1.5, sunY), -14);
  // Sun colour: warm at dawn/dusk, neutral midday
  const warmth = 1 - sunCurve;
  sunLight.color.setRGB(1.0,
    Math.min(1, 0.95 - warmth * 0.20),
    Math.min(1, 0.88 - warmth * 0.35));

  // Shade transmission: fully open shade lets all sun in; closed blocks ~92%.
  const shade = simState.shadePosition;          // 0 open, 1 fully closed
  const transmission = 1 - 0.92 * shade;
  // When the artificial lights are on, drop the direct-sun contribution a bit
  // so interior fill competes with it and shadows on the shelf/plant soften.
  const sunDirectScale = switchOn ? 0.7 : 1.0;
  sunLight.intensity = 2.6 * sunCurve * transmission * sunDirectScale;

  // Skylight (hemisphere): contributes ambient daylight, slightly dimmed by
  // closed shade and significantly dimmed when artificial lights are off and
  // sun is low.  When lights are ON, add a flat ambient lift so the room
  // looks more homogeneously lit (less directional contrast on shelves/plant).
  if (hemisphereLight) {
    const skyBase = 0.18 + 0.30 * sunCurve * (1 - 0.5 * shade);
    const onLift = switchOn ? 0.45 : 0.0;
    hemisphereLight.intensity = skyBase * (switchOn ? 1.0 : 0.55) + onLift;
  }
  // Warm fill at the window: represents sun bouncing off floor/walls.
  // Scales strongly with sun*transmission.  Boosted slightly when the
  // ceiling light is on to wash out hard shadows.
  if (roomFillLight) {
    roomFillLight.intensity = 0.8 * sunCurve * transmission + (switchOn ? 0.35 : 0.0);
  }

  // Sunbeam pool on the floor: opacity & position track the sun.
  if (sunbeamMesh) {
    sunbeamMesh.material.opacity = 0.55 * sunCurve * transmission;
    // Drift the pool along the floor as the sun moves east→west.
    const beamX = -sunX * 0.18;
    const beamZ = -1.4 + (1 - sunCurve) * 1.2;
    sunbeamMesh.position.set(beamX, 0.005, beamZ);
    // Stretch the pool when the sun is low (long shadows).
    const stretch = 1 + (1 - sunCurve) * 1.4;
    sunbeamMesh.scale.set(1, stretch, 1);
  }

  // Sky colour stays daytime blue during office hours.
  if (skyMesh && skyMesh.material) {
    skyMesh.material.color.setHex(0x9bd4f0);
  }
}
