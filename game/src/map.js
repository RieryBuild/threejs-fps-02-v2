// LAST TRAIN: a metro station at night, 40 x 34 m. Attackers spawn in the
// Ticket Hall at the south end; defenders hold the two platforms at the
// north end. Three lanes run south to north: the Concourse down the middle,
// the West Tunnel and the East Tunnel. A stopped train sits on the tracks
// between the platforms and blocks the middle sightline. Two bomb sites:
// A, Platform West, and B, Platform East. Every box is a collider for
// players and bots and a surface a bullet stops on. Waypoints below are the
// bot route graph, not scenery. minimapWalls is the same geometry in plan
// view, so the HUD minimap can never disagree with the map.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

function makeMaterials() {
  const defs = {
    floor: { color: PALETTE.floor, roughness: 0.85, metalness: 0.05 },
    floorDark: { color: PALETTE.floorDark, roughness: 0.9, metalness: 0.05 },
    wall: { color: PALETTE.wall, roughness: 0.9, metalness: 0.05 },
    wallDark: { color: PALETTE.wallDark, roughness: 0.92, metalness: 0.05 },
    pillar: { color: PALETTE.pillar, roughness: 0.7, metalness: 0.2 },
    steel: { color: PALETTE.steel, roughness: 0.45, metalness: 0.6 },
    steelDark: { color: PALETTE.steelDark, roughness: 0.55, metalness: 0.5 },
    train: { color: PALETTE.train, roughness: 0.5, metalness: 0.4 },
    trainWindow: { color: PALETTE.trainWindow, roughness: 0.3, metalness: 0.1, emissive: PALETTE.trainWindow, emissiveIntensity: 0.9 },
    amber: { color: PALETTE.amber, roughness: 0.5, metalness: 0.2, emissive: PALETTE.amber, emissiveIntensity: 0.7 },
    cyan: { color: PALETTE.cyan, roughness: 0.4, metalness: 0.2, emissive: PALETTE.cyan, emissiveIntensity: 0.8 },
    sign: { color: PALETTE.sign, roughness: 0.4, metalness: 0.1, emissive: PALETTE.sign, emissiveIntensity: 0.9 },
    red: { color: PALETTE.red, roughness: 0.5, metalness: 0.1, emissive: PALETTE.red, emissiveIntensity: 0.6 },
    bench: { color: 0x6b4a2f, roughness: 0.8, metalness: 0.05 },
    kiosk: { color: 0x2e6f6a, roughness: 0.6, metalness: 0.2 },
  };
  const out = {};
  for (const [name, def] of Object.entries(defs)) {
    out[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color),
      roughness: def.roughness,
      metalness: def.metalness,
      emissive: def.emissive ? new THREE.Color(def.emissive) : new THREE.Color(0x000000),
      emissiveIntensity: def.emissiveIntensity || 0,
    });
  }
  return out;
}

export function createMap(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const mats = makeMaterials();
  const colliders = [];
  const shootables = [];
  const minimapWalls = [];

  function box(w, h, d, x, y, z, mat, collide = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
      minimapWalls.push({ x, z, w, d });
    }
    return mesh;
  }

  function cylinder(rt, rb, h, x, y, z, mat, seg = 10) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    minimapWalls.push({ x, z, w: rt * 2, d: rt * 2 });
    return mesh;
  }

  // Sign: a thin emissive panel facing the given yaw, no collider.
  function sign(w, h, x, y, z, mat, yaw = 0) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    group.add(mesh);
    return mesh;
  }

  // --- floor, ceiling and the outer shell ----------------------------------
  box(40.4, 0.4, 34.4, 0, -0.2, 0, 'floor');
  box(40.4, 0.3, 34.4, 0, 8.6, 0, 'wallDark', false); // ceiling slab
  // Perimeter walls with two doorways on the south (spawn) side.
  box(40.4, 9, 0.5, 0, 4.5, -17.2, 'wall');
  box(40.4, 9, 0.5, 0, 4.5, 17.2, 'wall');
  box(0.5, 9, 34.4, -20.2, 4.5, 0, 'wall');
  box(0.5, 9, 34.4, 20.2, 4.5, 0, 'wall');

  // --- the stopped train, between the platforms -----------------------------
  // One car, 9 m long, windows lit: the middle sightline dies here.
  const train = new THREE.Group();
  train.position.set(0, 0, -11.5);
  const car = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.7, 9), mats.train);
  car.position.y = 1.35;
  car.castShadow = true;
  car.receiveShadow = true;
  train.add(car);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.25, 8.6), mats.steelDark);
  roof.position.y = 2.8;
  train.add(roof);
  for (let i = 0; i < 4; i += 1) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), mats.trainWindow);
    win.position.set(-2.32, 1.7, -3.2 + i * 2.1);
    win.rotation.y = -Math.PI / 2;
    train.add(win);
    const win2 = win.clone();
    win2.position.x = 2.32;
    win2.rotation.y = Math.PI / 2;
    train.add(win2);
  }
  // Headlights: two small amber discs on the north face.
  for (const sx of [-1.2, 1.2]) {
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.18, 12), mats.amber);
    lamp.position.set(sx, 0.7, -16.02);
    lamp.rotation.y = Math.PI;
    train.add(lamp);
  }
  group.add(train);
  colliders.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(0, 1.4, -11.5), new THREE.Vector3(4.6, 2.8, 9)));
  shootables.push(car);
  minimapWalls.push({ x: 0, z: -11.5, w: 4.6, d: 9 });

  // --- concourse pillars and kiosks -----------------------------------------
  for (const [x, z] of [[-8, 5], [0, 5], [8, 5], [-8, -2], [0, -2], [8, -2]]) {
    cylinder(0.55, 0.65, 8.4, x, 4.2, z, 'pillar', 10);
  }
  // Ticket gates: a row of low machines across the concourse at z = 8.
  for (const x of [-6, -4.5, -3, 3, 4.5, 6]) {
    box(0.5, 1.1, 2.2, x, 0.55, 8, 'steelDark');
  }
  // Kiosks: newsstand west, coffee east. They sit against the tunnel's
  // outer wall, NOT in the lane: an earlier build put them on the lane
  // centre (x = ±13) and bots routing down the tunnel stalled face-first
  // against them for whole rounds.
  box(3.4, 2.4, 2.0, -16.5, 1.2, 4, 'kiosk');
  box(3.4, 2.4, 2.0, 16.5, 1.2, 4, 'kiosk');
  box(2.2, 1.0, 1.2, -16.5, 0.5, 0.5, 'bench');
  box(2.2, 1.0, 1.2, 16.5, 0.5, 0.5, 'bench');
  // Service cart and crates, mid cover.
  box(1.4, 0.9, 0.9, -5, 0.45, -5.5, 'steel');
  box(1.1, 0.9, 1.1, 5.5, 0.45, -5.5, 'wallDark');
  box(1.1, 0.7, 1.1, 5.5, 1.25, -5.5, 'wallDark');

  // --- tunnel walls: they split the lanes from the concourse -----------------
  // West tunnel wall with two gaps; east the same, mirrored.
  box(0.5, 8.4, 9, -9.5, 4.2, -8, 'wall');
  box(0.5, 8.4, 6, -9.5, 4.2, 6.5, 'wall');
  box(0.5, 8.4, 9, 9.5, 4.2, -8, 'wall');
  box(0.5, 8.4, 6, 9.5, 4.2, 6.5, 'wall');
  // Tunnel end caps: none — the tunnels open straight onto the platforms,
  // so the waypoint graph's tunnel-to-site edges are walkable. (An earlier
  // build sealed them with walls and bots could never reach the sites.)

  // --- platforms: benches, signs, the yellow edge line -----------------------
  for (const [x, z] of [[-14, -14.5], [-8, -14.5], [8, -14.5], [14, -14.5]]) {
    box(2.4, 0.5, 0.7, x, 0.25, z, 'bench');
    box(0.15, 0.5, 0.7, x - 1, 0.75, z, 'steelDark');
    box(0.15, 0.5, 0.7, x + 1, 0.75, z, 'steelDark');
  }
  // Yellow safety line along both platform edges.
  for (const x of [-11, 11]) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(8, 0.02, 0.3), mats.amber);
    line.position.set(x, 0.02, -8.6);
    group.add(line);
  }
  // Site markers: glowing rings on the platform floor.
  function plantRing(x, z) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 1.75, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.03, z);
    group.add(ring);
    return ring;
  }
  const ringA = plantRing(-12, -13);
  const ringB = plantRing(12, -13);

  // --- mezzanine: a deck above the east tunnel, seen not walked ---------------
  // It gives the station its height in the screenshots; the railing and the
  // stair bulkheads are scenery, the deck is out of play.
  box(8, 0.4, 12, 14, 4.6, 2, 'floorDark', false);
  box(0.15, 1.1, 12, 9.9, 5.3, 2, 'steel', false);
  box(8, 0.3, 0.15, 14, 5.2, -4, 'steel', false);
  box(8, 0.3, 0.15, 14, 5.2, 8, 'steel', false);
  box(2.5, 4.6, 2.5, 14, 2.3, 9.5, 'wallDark');

  // --- signs -------------------------------------------------------------------
  sign(6, 1.1, 0, 6.4, -9.4, 'sign', 0); // CONCOURSE -> platforms
  sign(4.5, 0.9, -12, 5.6, -16.8, 'cyan', 0); // PLATFORM A
  sign(4.5, 0.9, 12, 5.6, -16.8, 'cyan', 0); // PLATFORM B
  sign(5, 1, 0, 6.8, 16.9, 'amber', Math.PI); // LAST TRAIN
  sign(3, 0.7, -14.5, 5.2, 0, 'red', Math.PI / 2); // WEST TUNNEL
  sign(3, 0.7, 14.5, 5.2, 0, 'red', -Math.PI / 2); // EAST TUNNEL

  // --- light: dim blue ambient, sodium over the platforms, cyan in the hall ----
  const sky = new THREE.HemisphereLight(new THREE.Color('#7d94a0'), new THREE.Color('#232a30'), 1.5);
  scene.add(sky);
  const sodium = new THREE.Color(PALETTE.amberSoft);
  for (const [x, z] of [[-12, -12], [12, -12], [-12, -9], [12, -9]]) {
    const light = new THREE.PointLight(sodium, 20, 16, 1.7);
    light.position.set(x, 5.5, z);
    group.add(light);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.14, 0.4), mats.amber);
    lamp.position.set(x, 6.2, z);
    group.add(lamp);
  }
  const cyanLight = new THREE.Color(PALETTE.cyan);
  for (const [x, z] of [[0, 8], [-8, 2], [8, 2], [-14, 2], [14, 2]]) {
    const light = new THREE.PointLight(cyanLight, 12, 14, 1.8);
    light.position.set(x, 6.8, z);
    group.add(light);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.3), mats.cyan);
    strip.position.set(x, 7.4, z);
    group.add(strip);
  }
  // Ticket hall: warm downlights so the spawn area reads at a glance.
  for (const [x, z] of [[-5, 13], [5, 13], [0, 10.5]]) {
    const light = new THREE.PointLight(new THREE.Color('#ffc27d'), 10, 12, 1.8);
    light.position.set(x, 6.5, z);
    group.add(light);
  }
  const trainGlow = new THREE.PointLight(new THREE.Color(PALETTE.trainWindow), 6, 10, 1.8);
  trainGlow.position.set(0, 2.2, -11.5);
  group.add(trainGlow);

  // --- gameplay data -----------------------------------------------------------
  const sites = [
    { id: 'A', name: 'Platform A', center: new THREE.Vector3(-12, 0, -13), radius: 2.4, ring: ringA },
    { id: 'B', name: 'Platform B', center: new THREE.Vector3(12, 0, -13), radius: 2.4, ring: ringB },
  ];
  const spawns = {
    attack: [
      new THREE.Vector3(-6, 0, 14.5), new THREE.Vector3(-3, 0, 15),
      new THREE.Vector3(0, 0, 15), new THREE.Vector3(3, 0, 15),
      new THREE.Vector3(6, 0, 14.5),
    ],
    defend: [
      new THREE.Vector3(-12, 0, -10.5), new THREE.Vector3(-16, 0, -12),
      new THREE.Vector3(12, 0, -10.5), new THREE.Vector3(16, 0, -12),
      new THREE.Vector3(0, 0, -4),
    ],
  };
  const nodes = [
    [0, 14.5], [-6, 11], [6, 11], [0, 8], [-4, 5], [4, 5], [0, 2],
    [-12, 8], [-14, 2], [-14, -4], [-12, -8], [-12, -13],
    [12, 8], [14, 2], [14, -4], [12, -8], [12, -13],
    [-6, -2], [6, -2], [-6, -7.5], [6, -7.5], [0, -6],
    [-16, -8], [16, -8], [-4, -13], [4, -13], [0, 11],
    [-14, 11], [14, 11], [-8, -6], [8, -6],
  ];
  // Edges are walkable straight lines: every one crosses its wall gaps, never
  // a wall and never the train (the train's south face is z = -7, so the
  // mid-to-site approaches stay south of it).
  const edges = [
    [0, 1], [0, 2], [0, 26], [1, 3], [2, 3], [26, 3], [3, 4], [3, 5],
    [4, 6], [5, 6], [6, 17], [6, 18], [1, 27], [27, 7], [7, 8], [8, 9],
    [9, 10], [10, 11], [10, 22], [2, 28], [28, 12], [12, 13], [13, 14],
    [14, 15], [15, 16], [15, 23], [4, 17], [5, 18], [17, 19], [18, 20],
    [19, 21], [20, 21], [11, 24], [16, 25],
    [9, 29], [14, 30], [29, 19], [30, 20], [7, 27], [12, 28],
    [8, 17], [13, 18], [29, 17], [30, 18],
  ];
  const waypoints = { nodes: nodes.map(([x, z]) => new THREE.Vector3(x, 0, z)), edges };

  return { colliders, shootables, group, sites, spawns, waypoints, minimapWalls };
}
