// LAST TRAIN — boot and the one loop: a fixed 60 Hz simulation feeding a
// render at the display's rate. The simulation (player, bots, rounds,
// grenades) lives in step(); rendering only reads state. Shooting is one
// hitscan ray per trigger pull, resolved against the nearest of walls, bots
// and the player, with head shots worth triple. ?shot=start|play|buy|plant
// with &seed=N stages a deterministic frame for a capture, renders it
// twice, then freezes it and sets window.__shotReady. window.__lt exposes
// the live state for headless smoke tests; it is not part of play.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { mulberry32, range } from './rng.js';
import { createMap } from './map.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createWeaponSet, WEAPONS } from './weapons.js';
import { createBots } from './bots.js';
import { createRounds, BUY_ITEMS } from './rounds.js';
import { createHud } from './hud.js';
import { createMinimap } from './minimap.js';
import { createAudio } from './audio.js';
import { makeRoundPlan, planTargets } from './plans.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.fog), 26, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const map = createMap(scene);
const hud = createHud();
const minimap = createMinimap(map);
const audio = createAudio();
const input = createInput(renderer.domElement, onLockChange);
const player = createPlayer(map.colliders);
const weaponSet = createWeaponSet(camera, scene);
const raycaster = new THREE.Raycaster();
raycaster.far = 90;

// The one state object: everything the loop reads or writes hangs off G.
const G = {
  hp: 100,
  alive: true,
  spectating: null,
  elapsed: 0,
  frozen: false,
  started: false,
  lastPhase: 'lobby',
  accumulator: 0,
  lastTime: performance.now(),
  stepCount: 0,
};

// --- player hit meshes: what bot shots can hit --------------------------------
const playerTorso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 0.3), new THREE.MeshBasicMaterial({ visible: false }));
const playerHead = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
playerTorso.userData.isPlayer = true;
playerTorso.userData.part = 'torso';
playerHead.userData.isPlayer = true;
playerHead.userData.part = 'head';
scene.add(playerTorso, playerHead);

function syncPlayerMeshes() {
  const p = player.state.position;
  playerTorso.position.set(p.x, p.y + 1.0, p.z);
  playerHead.position.set(p.x, p.y + 1.53, p.z);
}

// --- tracers: one reusable pool, no allocation in the hot loop ------------------
const TRACER_MAX = 24;
const tracers = [];
for (let i = 0; i < TRACER_MAX; i += 1) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  line.visible = false;
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, life: 0 });
}
let tracerNext = 0;
const tracerFrom = new THREE.Vector3();
const tracerTo = new THREE.Vector3();

function spawnTracer(from, to) {
  const t = tracers[tracerNext];
  tracerNext = (tracerNext + 1) % TRACER_MAX;
  const attr = t.line.geometry.getAttribute('position');
  attr.setXYZ(0, from.x, from.y, from.z);
  attr.setXYZ(1, to.x, to.y, to.z);
  attr.needsUpdate = true;
  t.life = shot ? 0.4 : 0.09;
  t.line.visible = true;
  t.line.material.opacity = 0.9;
}

function stepTracers(dt) {
  for (const t of tracers) {
    if (t.life <= 0) continue;
    t.life -= dt;
    t.line.material.opacity = Math.max(0, t.life / 0.09) * 0.9;
    if (t.life <= 0) t.line.visible = false;
  }
}

// --- shared sight test: walls and smoke both block it --------------------------
const sightRay = new THREE.Raycaster();
const sightDir = new THREE.Vector3();
const smokeTmp = new THREE.Vector3();
const segVec = new THREE.Vector3();
const closestVec = new THREE.Vector3();

function segmentBlockedBySmoke(from, to) {
  for (const s of weaponSet.smokes) {
    smokeTmp.copy(s.center).sub(from);
    segVec.copy(to).sub(from);
    const lenSq = segVec.lengthSq();
    const t = lenSq > 0 ? Math.max(0, Math.min(1, smokeTmp.dot(segVec) / lenSq)) : 0;
    closestVec.copy(from).addScaledVector(segVec, t);
    if (closestVec.distanceTo(s.center) < 3.6) return true;
  }
  return false;
}

function canSee(from, to) {
  if (segmentBlockedBySmoke(from, to)) return false;
  sightDir.copy(to).sub(from);
  const dist = sightDir.length();
  if (dist < 0.1) return true;
  sightDir.normalize();
  sightRay.set(from, sightDir);
  sightRay.far = dist - 0.3;
  return sightRay.intersectObjects(map.shootables, false).length === 0;
}

// --- bot hooks -------------------------------------------------------------------
const botEyeVecs = new Map();
const muzzleDir = new THREE.Vector3();
const muzzlePos = new THREE.Vector3();
const shotDir = new THREE.Vector3();
const aimTmp = new THREE.Vector3();

function enemiesOf(team) {
  const out = [];
  if (team === 'defend') {
    for (const bot of bots.bots) {
      if (bot.team !== 'attack' || !bot.alive) continue;
      out.push({ id: bot.name, isPlayer: false, pos: bot.pos, eye: botEyeVecs.get(bot), torso: bot.torso, head: bot.head, alive: true, speed: 3.7 });
    }
    if (G.alive) {
      out.push({ id: 'you', isPlayer: true, pos: player.state.position, eye: camera.position, torso: playerTorso, head: playerHead, alive: true, speed: player.groundSpeed() });
    }
  } else {
    for (const bot of bots.bots) {
      if (bot.team !== 'defend' || !bot.alive) continue;
      out.push({ id: bot.name, isPlayer: false, pos: bot.pos, eye: botEyeVecs.get(bot), torso: bot.torso, head: bot.head, alive: true, speed: 3.7 });
    }
  }
  return out;
}

function resolveShot(origin, dir, def, shooterTeam, shooterId) {
  const targets = [];
  if (shooterTeam === 'attack') {
    for (const bot of bots.bots) {
      if (bot.team === 'defend' && bot.alive) targets.push(bot.torso, bot.head);
    }
  } else {
    if (G.alive) targets.push(playerTorso, playerHead);
    for (const bot of bots.bots) {
      if (bot.team === 'attack' && bot.alive && bot.name !== shooterId) targets.push(bot.torso, bot.head);
    }
  }
  raycaster.set(origin, dir);
  const hits = raycaster.intersectObjects(targets.concat(map.shootables), false);
  const hit = hits[0];
  if (!hit) return null;
  if (hit.object.userData.bot) {
    const bot = hit.object.userData.bot;
    const killed = bots.damage(bot, hit.object.userData.part === 'head' ? def.headDamage : def.damage, hit.object.userData.part);
    return { kind: 'bot', bot, killed, point: hit.point };
  }
  if (hit.object.userData.isPlayer) {
    damagePlayer(hit.object.userData.part === 'head' ? def.headDamage : def.damage, origin);
    return { kind: 'player', point: hit.point };
  }
  return { kind: 'wall', point: hit.point };
}

function onBotFire(bot, origin, dir, def) {
  const end = origin.clone().addScaledVector(dir, 80);
  const result = resolveShot(origin, dir, def, bot.team, bot.name);
  const to = result ? result.point : end;
  spawnTracer(origin, to);
  audio.shot(bot.weaponKey === 'turnstile' ? 'shotgun' : bot.weaponKey === 'metro' ? 'smg' : bot.weaponKey === 'longshot' ? 'dmr' : 'rifle');
  bots.hearShot(origin, bot.team);
  if (result && result.kind === 'bot' && result.killed) {
    hud.killFeed(`${bot.name} ▸ ${result.bot.name}`);
    bots.creditKill(bot);
    rounds.onBotKill(bot.name);
  }
}

function onBotDeath(bot) {
  // The Charge drops where its carrier falls.
  if (rounds.state.bomb.status === 'carried' && rounds.state.bomb.carrier === bot.name) {
    rounds.dropBomb(bot.pos);
  }
  hud.setTeams(bots.aliveCount('attack') + (G.alive ? 1 : 0), bots.aliveCount('defend'));
}

function onChannelDone(bot, type, site) {
  if (type === 'plant') {
    rounds.plant(site);
  } else if (type === 'defuse') {
    rounds.endRound('defend', `${bot.name} defused the Charge at ${site.name}.`);
  }
}

function onBotGrenade(bot, kind, at) {
  const from = new THREE.Vector3(bot.pos.x, bot.pos.y + 1.4, bot.pos.z);
  aimTmp.copy(at).sub(from).normalize();
  weaponSet.throwGrenade(kind, from, aimTmp);
  if (kind === 'molotov') bots.hearExplosion(at, bot.team);
}

function nearestSite(pos) {
  let best = null;
  let bestD = Infinity;
  for (const site of map.sites) {
    const d = Math.hypot(pos.x - site.center.x, pos.z - site.center.z);
    if (d < bestD) {
      bestD = d;
      best = site;
    }
  }
  return best;
}

function assignBot(bot, plan) {
  const bomb = rounds.state.bomb;
  let targetNode;
  if (bomb.status === 'planted' && bomb.site) {
    targetNode = bots.nearestNode(bomb.site.center);
  } else if (bot.team === 'defend') {
    const defBots = bots.bots.filter((b) => b.team === 'defend');
    const idx = defBots.indexOf(bot);
    const holds = plan && plan.defend ? plan.defend : { a: [10, 11], b: [15, 16], roamer: 'mid' };
    if (idx === 0) targetNode = holds.a[0];
    else if (idx === 1) targetNode = holds.a[1];
    else if (idx === 2) targetNode = holds.b[0];
    else if (idx === 3) targetNode = holds.b[1];
    else targetNode = holds.roamer === 'mid' ? 6 : 17;
    bot.role = 'hold';
  } else {
    const atkBots = bots.bots.filter((b) => b.team === 'attack');
    const idx = atkBots.indexOf(bot);
    const targets = plan && plan.attack ? plan.attack.targets : planTargets('default');
    targetNode = targets[idx % targets.length];
    bot.role = (plan && plan.attack && (plan.attack.id === 'a-rush' || plan.attack.id === 'b-rush')) ? 'rush' : 'route';
  }
  bot.planNode = targetNode;
  bot.path = bots.pathTo(bots.nearestNode(bot.pos), targetNode);
  bot.pathIndex = 0;
  bot.state = 'route';
}

const bots = createBots(scene, map, random, {
  enemiesOf,
  canSee,
  isLive: () => rounds.state.phase === 'live',
  onFire: onBotFire,
  onDeath: onBotDeath,
  onChannelDone,
  onBotGrenade,
  nearestSite,
  fires: () => weaponSet.fires,
  assign: assignBot,
});
for (const bot of bots.bots) botEyeVecs.set(bot, new THREE.Vector3(bot.pos.x, bot.pos.y + 1.55, bot.pos.z));

function makePlan(round) {
  return makeRoundPlan(random, round);
}

const rounds = createRounds({ map, bots, hud, audio, pickPlan: makePlan });

// --- player damage and death ------------------------------------------------------
function damagePlayer(amount, fromPos) {
  if (!G.alive) return;
  const taken = rounds.state.armor ? Math.round(amount * 0.65) : amount;
  G.hp -= taken;
  let angleDeg;
  if (fromPos) {
    const dx = fromPos.x - player.state.position.x;
    const dz = fromPos.z - player.state.position.z;
    const worldAngle = Math.atan2(-dx, -dz);
    let rel = worldAngle - player.state.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    angleDeg = (rel * 180) / Math.PI;
  }
  hud.damageFlash(angleDeg);
  hud.setHealth(Math.max(0, G.hp));
  audio.hurt();
  if (G.hp <= 0) {
    G.hp = 0;
    G.alive = false;
    rounds.onDeath();
    if (rounds.state.bomb.status === 'carried' && rounds.state.bomb.carrier === 'player') {
      rounds.dropBomb(player.state.position);
    }
    const mate = bots.bots.find((b) => b.team === 'attack' && b.alive);
    G.spectating = mate || null;
    hud.setBanner('You are down', mate ? `Spectating ${mate.name} — next round in a moment` : 'No teammates left');
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

// --- shooting ----------------------------------------------------------------------
function shoot(spread) {
  if (!weaponSet.takeRound()) {
    audio.dry();
    return false;
  }
  const def = weaponSet.def();
  camera.getWorldDirection(muzzleDir);
  const pellets = def.pellets || 1;
  let hitAny = false;
  let killedAny = false;
  for (let i = 0; i < pellets; i += 1) {
    const dir = muzzleDir.clone();
    dir.x += (random() * 2 - 1) * spread;
    dir.y += (random() * 2 - 1) * spread;
    dir.z += (random() * 2 - 1) * spread;
    dir.normalize();
    muzzlePos.copy(camera.position).addScaledVector(dir, 0.6);
    muzzlePos.y -= 0.12;
    const result = resolveShot(camera.position, dir, def, 'attack', 'you');
    const end = camera.position.clone().addScaledVector(dir, 80);
    spawnTracer(muzzlePos, result ? result.point : end);
    if (result && result.kind === 'bot') {
      hitAny = true;
      if (result.killed) {
        killedAny = true;
        rounds.onKill();
        hud.killFeed(`You ▸ ${result.bot.name}`);
        rounds.onBotKill('you');
        audio.kill();
      }
    }
  }
  if (hitAny) {
    hud.hitMarker(killedAny, shot ? 4000 : 90);
    if (!killedAny) audio.hit();
  }
  weaponSet.pullTrigger();
  player.recoil(WEAPONS[weaponSet.state.key].kick + random() * 0.004, (random() * 2 - 1) * 0.004);
  hud.setAmmo(weaponSet.state.mag, weaponSet.state.reserve, weaponSet.def().name);
  audio.shot(weaponSet.state.key === 'turnstile' ? 'shotgun' : weaponSet.state.key === 'metro' ? 'smg' : weaponSet.state.key === 'longshot' ? 'dmr' : weaponSet.state.key === 'sidearm' ? 'pistol' : 'rifle');
  bots.hearShot(player.state.position, 'attack');
  return true;
}

// --- grenades -------------------------------------------------------------------------
function throwSmoke() {
  if (rounds.state.smokes <= 0) return;
  rounds.state.smokes -= 1;
  camera.getWorldDirection(shotDir);
  weaponSet.throwGrenade('smoke', camera.position, shotDir);
  hud.setGrenades(rounds.state.smokes, rounds.state.flashes, rounds.state.molotovs);
}

function throwFlash() {
  if (rounds.state.flashes <= 0) return;
  rounds.state.flashes -= 1;
  camera.getWorldDirection(shotDir);
  weaponSet.throwGrenade('flash', camera.position, shotDir);
  hud.setGrenades(rounds.state.smokes, rounds.state.flashes, rounds.state.molotovs);
}

function throwMolotov() {
  if (rounds.state.molotovs <= 0) return;
  rounds.state.molotovs -= 1;
  camera.getWorldDirection(shotDir);
  weaponSet.throwGrenade('molotov', camera.position, shotDir);
  hud.setGrenades(rounds.state.smokes, rounds.state.flashes, rounds.state.molotovs);
}

function onGrenadeLand(kind, at) {
  if (kind === 'smoke') {
    weaponSet.addSmoke(at);
    return;
  }
  if (kind === 'molotov') {
    weaponSet.addFire(at);
    audio.fire();
    bots.hearExplosion(at, 'attack');
    return;
  }
  // Flash: anyone with a line of sight to the burst who faces it is blinded.
  for (const bot of bots.bots) {
    if (!bot.alive) continue;
    const eye = botEyeVecs.get(bot);
    const dist = eye.distanceTo(at);
    if (dist > 26) continue;
    const toBurst = at.clone().sub(eye).normalize();
    const facing = new THREE.Vector3(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
    if (facing.dot(toBurst) > 0.2 && canSee(eye, at)) {
      bot.blindUntil = G.elapsed + 2.5;
    }
  }
  if (G.alive) {
    const dist = camera.position.distanceTo(at);
    if (dist < 26) {
      const toBurst = at.clone().sub(camera.position).normalize();
      camera.getWorldDirection(muzzleDir);
      if (muzzleDir.dot(toBurst) > 0.2 && canSee(camera.position, at)) {
        hud.flashBang(0.85);
      }
    }
  }
}

// --- molotov fire damage ------------------------------------------------------------
function stepFire(dt) {
  for (const f of weaponSet.fires) {
    if (G.alive) {
      const d = Math.hypot(player.state.position.x - f.center.x, player.state.position.z - f.center.z);
      if (d < f.radius) damagePlayer(f.dps * dt, f.center);
    }
    for (const bot of bots.bots) {
      if (!bot.alive) continue;
      const d = Math.hypot(bot.pos.x - f.center.x, bot.pos.z - f.center.z);
      if (d < f.radius) bots.damage(bot, f.dps * dt, 'fire');
    }
  }
}

// --- camera ----------------------------------------------------------------------------
function syncCamera() {
  if (G.spectating) {
    const bot = G.spectating;
    camera.position.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
    camera.rotation.set(-0.08, bot.yaw, 0, 'YXZ');
    return;
  }
  const body = player.state;
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
}

// --- round transitions --------------------------------------------------------------------
function resetPlayerForRound() {
  const spawn = map.spawns.attack[0];
  player.reset(spawn.x, spawn.z, 0);
  G.hp = 100;
  G.alive = true;
  G.spectating = null;
  weaponSet.equip(rounds.state.weapon);
  weaponSet.refillAmmo();
  hud.setHealth(100);
  hud.setArmor(rounds.state.armor);
  hud.setAmmo(weaponSet.state.mag, weaponSet.state.reserve, weaponSet.def().name);
  hud.setScore(rounds.state.score.attack, rounds.state.score.defend, Math.max(1, rounds.state.round));
  hud.setMoney(rounds.state.money);
  hud.setGrenades(rounds.state.smokes, rounds.state.flashes, rounds.state.molotovs);
  hud.setBomb('carried');
  hud.setTeams(5, 5);
  syncPlayerMeshes();
  syncCamera();
}

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    G.started = true;
    hud.hideOverlay();
    audio.unlock();
  } else if (rounds.state.phase !== 'matchEnd') {
    hud.showOverlay(G.started ? 'paused' : 'start', rounds.state);
  }
}

hud.onPlay(() => {
  if (shot) return;
  if (rounds.state.phase === 'lobby' || rounds.state.phase === 'matchEnd') {
    rounds.startMatch();
    resetPlayerForRound();
  }
  input.requestLock();
});

// --- the fixed step -------------------------------------------------------------------------
function step(dt) {
  G.elapsed += dt;
  G.stepCount += 1;
  const pressed = input.takePressed();
  const phase = rounds.state.phase;

  if (phase === 'buy' && G.lastPhase !== 'buy') resetPlayerForRound();
  if (phase === 'matchEnd' && G.lastPhase !== 'matchEnd') hud.showOverlay('match', rounds.state);
  G.lastPhase = phase;

  // Buy keys and weapon switching.
  if (G.alive && phase === 'buy') {
    for (const item of BUY_ITEMS) {
      if (pressed.has(`Digit${item.key}`)) rounds.buy(item.id);
    }
    if (pressed.has('KeyB')) {
      if (document.getElementById('buy').hidden) hud.showBuy(rounds.state);
      else hud.hideBuy();
    }
  } else if (G.alive && phase === 'live') {
    const slotKeys = { Digit1: 'vesper', Digit2: 'metro', Digit3: 'turnstile', Digit4: 'longshot', Digit5: 'sidearm' };
    for (const [code, key] of Object.entries(slotKeys)) {
      if (pressed.has(code) && rounds.state.owned.has(key)) weaponSet.equip(key);
    }
    if (pressed.has('KeyQ')) {
      const owned = ['vesper', 'metro', 'turnstile', 'longshot', 'sidearm'].filter((k) => rounds.state.owned.has(k));
      const next = owned[(owned.indexOf(weaponSet.state.key) + 1) % owned.length];
      weaponSet.equip(next);
    }
    if (pressed.has('KeyG')) throwSmoke();
    if (pressed.has('KeyF')) throwFlash();
    if (pressed.has('KeyH')) throwMolotov();
  }

  if (G.alive && (phase === 'live' || phase === 'buy')) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    player.step(dt, input.state.keys);
    input.syncFiring();
    if (input.state.firing && phase === 'live' && weaponSet.ready()) shoot(shot ? 0 : weaponSet.spread(player.groundSpeed()));
    if (input.state.keys.has('KeyR') && weaponSet.reload()) audio.reload();
    syncPlayerMeshes();
  }

  weaponSet.step(dt);
  weaponSet.stepGrenades(dt, onGrenadeLand);
  stepFire(dt);
  bots.step(dt, G.elapsed);
  for (const bot of bots.bots) {
    const eye = botEyeVecs.get(bot);
    eye.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
  }
  stepTracers(dt);

  // Defenders converge on a planted Charge; the nearest one defuses it.
  if (rounds.state.bomb.status === 'planted' && rounds.state.bomb.site) {
    const site = rounds.state.bomb.site;
    for (const bot of bots.bots) {
      if (bot.team !== 'defend' || !bot.alive || bot.state === 'engage') continue;
      const d = Math.hypot(bot.pos.x - site.center.x, bot.pos.z - site.center.z);
      if (d <= site.radius + 0.4 && !bot.channel) {
        bots.startChannel(bot, 'defuse', site);
      }
    }
  }

  rounds.update(dt, {
    playerAlive: G.alive,
    playerPos: player.state.position,
    holdingE: input.state.keys.has('KeyE'),
  });

  // A bot's plant or defuse channel shows on the HUD too, unless the player is
  // planting right now (rounds.update already shows that one).
  if (rounds.state.plantProgress <= 0) {
    let shownChannel = false;
    for (const bot of bots.bots) {
      if (bot.channel) {
        hud.setChannel(bot.channel.type, bot.channel.progress, bot.channel.site.name);
        shownChannel = true;
        break;
      }
    }
    if (!shownChannel) hud.setChannel(null, 0);
  }

  // Dropped Charge marker on screen.
  const bomb = rounds.state.bomb;
  if (bomb.status === 'dropped' && bomb.pos && G.alive) {
    const projected = bomb.pos.clone().project(camera);
    if (projected.z < 1) {
      hud.setBombMarker(true, (projected.x * 0.5 + 0.5) * window.innerWidth, (-projected.y * 0.5 + 0.5) * window.innerHeight);
    } else {
      hud.setBombMarker(false);
    }
  } else {
    hud.setBombMarker(false);
  }

  minimap.draw({
    bomb: rounds.state.bomb,
    bots: bots.bots,
    playerAlive: G.alive,
    playerPos: player.state.position,
    playerYaw: player.state.yaw,
  });
  hud.setHealth(G.hp);
  hud.setAmmo(weaponSet.state.mag, weaponSet.state.reserve, weaponSet.def().name);
  hud.setTeams(bots.aliveCount('attack') + (G.alive ? 1 : 0), bots.aliveCount('defend'));
  hud.setSpread(2 + Math.min(14, player.groundSpeed() * 2.4) + weaponSet.state.kick * 120);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - G.lastTime) / 1000, 0.1);
  G.lastTime = now;
  if (!G.frozen) {
    G.accumulator += dt;
    let steps = 0;
    while (G.accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      G.accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (G.accumulator > FIXED_STEP * 5) G.accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

// --- deterministic captures --------------------------------------------------------------------
function aimAt(point) {
  const body = player.state;
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED_STEP);
}

function placeBot(name, x, z, yaw, holdSeconds = 99) {
  const bot = bots.bots.find((b) => b.name === name);
  if (!bot) return null;
  bot.pos.set(x, 0, z);
  bot.yaw = yaw;
  bot.state = 'hold';
  bot.holdUntil = G.elapsed + holdSeconds;
  bot.path = [];
  bot.pathIndex = 0;
  bot.group.position.copy(bot.pos);
  bot.group.rotation.set(0, yaw, 0);
  return bot;
}

function runShot(name) {
  hud.hideOverlay();
  hud.hideBuy();
  if (name === 'start') {
    rounds.state.phase = 'lobby';
    bots.reset(1, null, null);
    resetPlayerForRound();
    player.reset(0, 14.5, 0);
    placeBot('Rook', -2.5, 12.5, 0.2);
    placeBot('Mira', 2.8, 12.8, -0.2);
    settle(30);
    aimAt(new THREE.Vector3(4, 1.4, -6));
    hud.showOverlay('start', rounds.state);
  } else if (name === 'play') {
    rounds.startMatch();
    rounds.state.round = 2;
    rounds.state.score.attack = 1;
    rounds.startRound();
    rounds.state.money = 1150;
    rounds.state.weapon = 'vesper';
    resetPlayerForRound();
    player.reset(0, 8.5, 0);
    placeBot('Voss', -4, -3, Math.PI);
    placeBot('Ilya', 4, -3.5, Math.PI * 0.9);
    placeBot('Rook', -2.6, 7, 0);
    weaponSet.state.mag = 18;
    weaponSet.state.reserve = 75;
    rounds.state.timer = 84;
    settle(25);
    const voss = bots.bots.find((b) => b.name === 'Voss');
    aimAt(new THREE.Vector3(voss.pos.x, voss.pos.y + 1.1, voss.pos.z));
    shoot(0);
    settle(6);
    aimAt(new THREE.Vector3(voss.pos.x, voss.pos.y + 1.1, voss.pos.z));
    hud.setScore(1, 0, 2);
    hud.setMoney(1150);
  } else if (name === 'buy') {
    rounds.startMatch();
    rounds.state.money = 2700;
    resetPlayerForRound();
    player.reset(0, 14.5, 0);
    placeBot('Rook', -2.5, 12.5, 0.2);
    settle(20);
    aimAt(new THREE.Vector3(4, 1.4, -6));
    hud.showBuy(rounds.state);
  } else if (name === 'plant') {
    rounds.startMatch();
    rounds.state.round = 3;
    rounds.state.score.attack = 2;
    rounds.state.score.defend = 1;
    rounds.startRound();
    rounds.state.money = 2100;
    rounds.state.weapon = 'vesper';
    resetPlayerForRound();
    player.reset(-12, -5, 0);
    const siteA = map.sites[0];
    rounds.plant(siteA);
    rounds.state.bomb.fuse = 31;
    const voss = placeBot('Voss', -10.6, -11.2, Math.PI / 2);
    bots.startChannel(voss, 'defuse', siteA);
    voss.channel.progress = 0.45;
    placeBot('Rook', -3.5, -8.5, 0.5);
    settle(10);
    aimAt(new THREE.Vector3(voss.pos.x, voss.pos.y + 1.2, voss.pos.z));
    hud.setScore(2, 1, 3);
    hud.setMoney(2100);
  }
  hud.setScore(rounds.state.score.attack, rounds.state.score.defend, Math.max(1, rounds.state.round));
  hud.setMoney(rounds.state.money);
  hud.setHealth(G.hp);
  hud.hideBanner();
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      G.frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
hud.setScore(0, 0, 1);
hud.setMoney(800);
hud.setHealth(100);
hud.setArmor(false);
hud.setGrenades(0, 0, 0);
hud.setAmmo(weaponSet.state.mag, weaponSet.state.reserve, weaponSet.def().name);
hud.setBomb('carried');
// Headless smoke tests read the live state here; play never touches it.
// ff(seconds) fast-forwards the fixed-step sim synchronously (the rAF loop
// is frozen while it runs), so a whole match can be simulated in seconds.
window.__lt = { G, rounds, bots, player, map, weaponSet,
  ff(seconds) {
    G.frozen = true;
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) step(FIXED_STEP);
    G.frozen = false;
  },
};
if (shot) runShot(shot);
else requestAnimationFrame(frame);
