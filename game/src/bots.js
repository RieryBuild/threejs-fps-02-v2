// Bots: nine of them, four teammates and five opponents, so the match is
// 5v5. Each one walks the map's waypoint graph, holds angles, patrols, and
// fights with the same rules the player does: line of sight, a field of
// view, hearing, bursts with spread, a reaction time, and a plant or defuse
// channel it must stand still to finish. No bot sees through walls, smoke
// or the map; every decision below reads the world through the hooks
// main.js provides. Bots also play the team game: they follow the round's
// plan, buy with their own money, rotate to a site under attack, throw
// their grenades on an execute, and walk around molotov fire.
import * as THREE from 'three';
import { WEAPONS } from './weapons.js';
import { range, pick, chance } from './rng.js';
import { botLoadout, loadoutCost, planTargets } from './plans.js';

const BOT_SPEED = 3.7;
const RUSH_SPEED = 4.4;
const STRAFE_SPEED = 2.3;
const EYE = 1.55;
const HEIGHT = 1.72;
const RADIUS = 0.34;
const SIGHT_RANGE = 46;
const HEAR_RANGE = 30;

const TEAM_COLORS = {
  attack: 0xb06a3b,
  defend: 0x5d8fa8,
};

// Skill tiers: sharpshooters react fast and shoot straight, rookies slower.
const SKILLS = [
  { reactMin: 0.28, reactMax: 0.5, spreadMul: 0.85 },
  { reactMin: 0.35, reactMax: 0.62, spreadMul: 1.0 },
  { reactMin: 0.45, reactMax: 0.75, spreadMul: 1.15 },
];

function buildBody(team) {
  const group = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: new THREE.Color(TEAM_COLORS[team]), roughness: 0.75, metalness: 0.05, emissive: new THREE.Color(TEAM_COLORS[team]), emissiveIntensity: 0.18 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x2a2e2a), roughness: 0.85, metalness: 0.05 });
  const visor = new THREE.MeshStandardMaterial({ color: new THREE.Color(0xf2a541), roughness: 0.3, metalness: 0.4, emissive: new THREE.Color(0xf2a541), emissiveIntensity: 0.35 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 0.3), cloth);
  torso.position.y = 1.0;
  torso.userData.part = 'torso';
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), dark);
  head.position.y = 1.53;
  head.userData.part = 'head';
  const visorMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.05), visor);
  visorMesh.position.set(0, 1.55, 0.14);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.26), dark);
  legs.position.y = 0.31;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.55), dark);
  gun.position.set(0.2, 1.15, -0.3);
  group.add(torso, head, visorMesh, legs, gun);
  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return { group, torso, head };
}

function bfsPath(adj, from, to, blocked) {
  if (from === to) return [to];
  const prev = new Array(adj.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const node = queue.shift();
    for (const next of adj[node]) {
      if (prev[next] !== -1) continue;
      if (blocked && blocked.has(next)) continue;
      prev[next] = node;
      if (next === to) {
        const path = [to];
        let cur = to;
        while (cur !== from) {
          cur = prev[cur];
          path.unshift(cur);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [to];
}

export function createBots(scene, map, rng, hooks) {
  const adj = map.waypoints.nodes.map(() => []);
  for (const [a, b] of map.waypoints.edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const probe = new THREE.Box3();
  const tmp = new THREE.Vector3();
  const eyePos = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const facing = new THREE.Vector3();

  function collides(x, y, z, height) {
    probe.min.set(x - RADIUS, y + 0.02, z - RADIUS);
    probe.max.set(x + RADIUS, y + height - 0.02, z + RADIUS);
    for (const c of map.colliders) if (probe.intersectsBox(c)) return true;
    return false;
  }

  function nearestNode(pos) {
    let best = 0;
    let bestDist = Infinity;
    map.waypoints.nodes.forEach((node, i) => {
      const d = (node.x - pos.x) ** 2 + (node.z - pos.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  // Waypoint nodes inside a molotov fire are blocked for pathing.
  function fireBlockedNodes() {
    const blocked = new Set();
    const fires = hooks.fires ? hooks.fires() : [];
    for (const f of fires) {
      map.waypoints.nodes.forEach((node, i) => {
        if (Math.hypot(node.x - f.center.x, node.z - f.center.z) < f.radius + 0.6) blocked.add(i);
      });
    }
    return blocked;
  }

  function inFire(x, z) {
    const fires = hooks.fires ? hooks.fires() : [];
    for (const f of fires) {
      if (Math.hypot(x - f.center.x, z - f.center.z) < f.radius + 0.3) return true;
    }
    return false;
  }

  const bots = [];
  const defs = [
    { team: 'attack', name: 'Rook', skill: 1 },
    { team: 'attack', name: 'Mira', skill: 0 },
    { team: 'attack', name: 'Heron', skill: 2 },
    { team: 'attack', name: 'Ash', skill: 1 },
    { team: 'defend', name: 'Voss', skill: 0 },
    { team: 'defend', name: 'Ilya', skill: 1 },
    { team: 'defend', name: 'Sable', skill: 2 },
    { team: 'defend', name: 'Wren', skill: 1 },
    { team: 'defend', name: 'Kade', skill: 0 },
  ];

  for (const def of defs) {
    const body = buildBody(def.team);
    scene.add(body.group);
    const skill = SKILLS[def.skill];
    const bot = {
      id: def.name,
      team: def.team,
      name: def.name,
      weaponKey: 'sidearm',
      skill,
      money: 800,
      armor: false,
      smokes: 0,
      flashes: 0,
      molotovs: 0,
      group: body.group,
      torso: body.torso,
      head: body.head,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      yaw: 0,
      health: 100,
      alive: true,
      state: 'route',
      role: 'route',
      planNode: 0,
      path: [],
      pathIndex: 0,
      holdUntil: 0,
      scanYaw: 0,
      target: null,
      lastSeenAt: -99,
      lastSeenPos: new THREE.Vector3(),
      reactAt: 0,
      burstLeft: 0,
      burstPause: 0,
      shotTimer: 0,
      strafeDir: 1,
      strafeUntil: 0,
      investigatePos: null,
      channel: null,
      channelSite: null,
      blindUntil: 0,
      mag: WEAPONS.sidearm.mag,
      reloadLeft: 0,
      thinkAt: rng() * 0.15,
      carrying: false,
      fall: 0,
      thrownSmoke: false,
    };
    body.torso.userData.bot = bot;
    body.head.userData.bot = bot;
    bots.push(bot);
  }

  function visibleEnemy(bot, time) {
    const enemies = hooks.enemiesOf(bot.team);
    let best = null;
    let bestScore = Infinity;
    eyePos.set(bot.pos.x, bot.pos.y + EYE, bot.pos.z);
    for (const e of enemies) {
      if (!e.alive) continue;
      toTarget.copy(e.eye).sub(eyePos);
      const dist = toTarget.length();
      if (dist > SIGHT_RANGE) continue;
      if (dist > 4) {
        facing.set(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
        toTarget.normalize();
        if (facing.dot(toTarget) < 0.25) continue;
      }
      if (!hooks.canSee(eyePos, e.eye)) continue;
      const score = dist + (e.isPlayer ? 0 : 2);
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  function moveToward(bot, target, dt, speed) {
    const dx = target.x - bot.pos.x;
    const dz = target.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return true;
    const vx = (dx / dist) * speed;
    const vz = (dz / dist) * speed;
    const ox = bot.pos.x;
    const oz = bot.pos.z;
    const nx = bot.pos.x + vx * dt;
    const nz = bot.pos.z + vz * dt;
    // Never step into molotov fire: hold instead of burning.
    if (!inFire(nx, bot.pos.z) && !collides(nx, bot.pos.y, bot.pos.z, HEIGHT)) bot.pos.x = nx;
    if (!inFire(bot.pos.x, nz) && !collides(bot.pos.x, bot.pos.y, nz, HEIGHT)) bot.pos.z = nz;
    // Stuck face-first against an obstacle (the direct step moved nothing)?
    // Sidestep perpendicular — first one way, then the other — so the bot
    // slides around the corner instead of pushing forever. Without this,
    // bots stalled for whole rounds against kiosk faces on the lane.
    if (bot.pos.x === ox && bot.pos.z === oz) {
      for (const s of [1, -1]) {
        const px = bot.pos.x - vz * dt * s;
        const pz = bot.pos.z + vx * dt * s;
        if (!inFire(px, bot.pos.z) && !collides(px, bot.pos.y, bot.pos.z, HEIGHT)) bot.pos.x = px;
        if (!inFire(bot.pos.x, pz) && !collides(bot.pos.x, bot.pos.y, pz, HEIGHT)) bot.pos.z = pz;
        if (bot.pos.x !== ox || bot.pos.z !== oz) break;
      }
    }
    bot.yaw = Math.atan2(-dx, -dz);
    return dist < 0.4;
  }

  function faceToward(bot, point, dt, rate = 6) {
    const dx = point.x - bot.pos.x;
    const dz = point.z - bot.pos.z;
    const want = Math.atan2(-dx, -dz);
    let diff = want - bot.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    bot.yaw += Math.max(-rate * dt, Math.min(rate * dt, diff));
  }

  function startChannel(bot, type, site) {
    bot.channel = { type, site, progress: 0 };
    bot.channelSite = site;
    bot.state = type === 'plant' ? 'plant' : 'defuse';
  }

  function stopChannel(bot) {
    bot.channel = null;
    bot.channelSite = null;
    if (bot.state === 'plant' || bot.state === 'defuse') bot.state = 'route';
  }

  function fireAt(bot, target, dt, time) {
    const def = WEAPONS[bot.weaponKey];
    if (bot.reloadLeft > 0) {
      bot.reloadLeft -= dt;
      if (bot.reloadLeft <= 0) bot.mag = def.mag;
      return;
    }
    if (bot.mag <= 0) {
      bot.reloadLeft = def.reload;
      return;
    }
    if (bot.burstPause > 0) {
      bot.burstPause -= dt;
      return;
    }
    if (bot.burstLeft <= 0) {
      bot.burstLeft = 3 + Math.floor(rng() * 3);
      bot.burstPause = 0;
    }
    bot.shotTimer -= dt;
    if (bot.shotTimer > 0) return;
    bot.shotTimer = def.rate;
    bot.burstLeft -= 1;
    if (bot.burstLeft <= 0) bot.burstPause = range(rng, 0.5, 1.1);
    bot.mag -= 1;
    const origin = new THREE.Vector3(bot.pos.x, bot.pos.y + 1.35, bot.pos.z);
    const aim = target.eye.clone();
    const dist = origin.distanceTo(aim);
    const spread = (0.028 + dist * 0.0011 + (target.isPlayer ? target.speed * 0.004 : 0.002)) * bot.skill.spreadMul;
    const dir = aim.sub(origin).normalize();
    dir.x += (rng() * 2 - 1) * spread;
    dir.y += (rng() * 2 - 1) * spread;
    dir.z += (rng() * 2 - 1) * spread;
    dir.normalize();
    hooks.onFire(bot, origin, dir, def);
  }

  function stepBot(bot, dt, time) {
    if (!bot.alive) {
      bot.fall = Math.min(1, bot.fall + dt / 0.4);
      bot.group.rotation.x = -bot.fall * 1.45;
      return;
    }
    bot.group.position.copy(bot.pos);
    bot.group.rotation.set(0, bot.yaw, 0);

    // A flashed bot cannot see or shoot; it stands and turns, and any channel
    // it was holding is interrupted.
    if (bot.blindUntil > time) {
      if (bot.channel) stopChannel(bot);
      bot.target = null;
      if (bot.state === 'engage') bot.state = 'route';
      bot.yaw += dt * 0.6;
      return;
    }

    // Outside the live phase (buy, round end) bots walk to their holds but
    // never fight: no sighting, no shooting, no channels. Without this, bots
    // reached the sites and killed each other during the 15s buy phase, so
    // rounds started half-decided (Voss died in buy in a probe run).
    const live = hooks.isLive ? hooks.isLive() : true;
    if (!live) {
      if (bot.channel) stopChannel(bot);
      bot.target = null;
      if (bot.state === 'engage' || bot.state === 'plant' || bot.state === 'defuse') bot.state = 'route';
    }

    // Think on a stagger so nine bots never raycast on the same frame.
    if (live && time >= bot.thinkAt) {
      bot.thinkAt = time + 0.15 + rng() * 0.05;
      const seen = visibleEnemy(bot, time);
      if (seen) {
        bot.target = seen;
        bot.lastSeenAt = time;
        bot.lastSeenPos.copy(seen.eye);
        if (bot.state !== 'engage') {
          bot.state = 'engage';
          bot.reactAt = time + range(rng, bot.skill.reactMin, bot.skill.reactMax);
          bot.strafeUntil = time + range(rng, 0.8, 1.6);
          bot.strafeDir = chance(rng, 0.5) ? 1 : -1;
          stopChannel(bot);
          bot.state = 'engage';
        }
      } else if (bot.state === 'engage' && time - bot.lastSeenAt > 1.2) {
        bot.target = null;
        bot.state = 'investigate';
        bot.investigatePos = bot.lastSeenPos.clone();
        bot.path = bfsPath(adj, nearestNode(bot.pos), nearestNode(bot.investigatePos), fireBlockedNodes());
        bot.pathIndex = 0;
      }
    }

    if (bot.state === 'engage' && bot.target) {
      const t = bot.target;
      if (!t.alive) {
        bot.target = null;
        bot.state = 'route';
        return;
      }
      faceToward(bot, t.eye, dt, 7);
      // Strafe sideways while fighting, so the bot is not a still target.
      if (time > bot.strafeUntil) {
        bot.strafeUntil = time + range(rng, 0.8, 1.6);
        bot.strafeDir *= -1;
      }
      const sx = Math.cos(bot.yaw) * bot.strafeDir;
      const sz = -Math.sin(bot.yaw) * bot.strafeDir;
      const nx = bot.pos.x + sx * STRAFE_SPEED * dt;
      if (!inFire(nx, bot.pos.z) && !collides(nx, bot.pos.y, bot.pos.z, HEIGHT)) bot.pos.x = nx;
      const nz = bot.pos.z + sz * STRAFE_SPEED * dt;
      if (!inFire(bot.pos.x, nz) && !collides(bot.pos.x, bot.pos.y, nz, HEIGHT)) bot.pos.z = nz;
      if (time >= bot.reactAt) fireAt(bot, t, dt, time);
      return;
    }

    if (bot.state === 'investigate' && bot.investigatePos) {
      if (bot.pathIndex < bot.path.length) {
        const node = map.waypoints.nodes[bot.path[bot.pathIndex]];
        if (moveToward(bot, node, dt, BOT_SPEED)) bot.pathIndex += 1;
      } else {
        bot.state = 'hold';
        bot.holdUntil = time + range(rng, 1.5, 3);
        bot.investigatePos = null;
      }
      return;
    }

    if (bot.state === 'hold') {
      bot.scanYaw += dt * 0.7;
      bot.yaw += Math.sin(bot.scanYaw) * dt * 0.9;
      if (time >= bot.holdUntil) {
        bot.state = 'route';
        hooks.assign(bot);
      }
      return;
    }

    if (bot.state === 'plant' || bot.state === 'defuse') {
      if (!bot.channel) {
        bot.state = 'route';
        return;
      }
      const need = bot.channel.type === 'plant' ? 4 : 5;
      bot.channel.progress += dt / need;
      if (bot.channel.progress >= 1) {
        const done = bot.channel;
        bot.channel = null;
        bot.channelSite = null;
        bot.state = 'route';
        hooks.onChannelDone(bot, done.type, done.site);
      }
      return;
    }

    // route: follow the plan's path. Rushers move faster and never hold.
    if (bot.pathIndex < bot.path.length) {
      const node = map.waypoints.nodes[bot.path[bot.pathIndex]];
      const speed = bot.role === 'rush' ? RUSH_SPEED : BOT_SPEED;
      if (moveToward(bot, node, dt, speed)) bot.pathIndex += 1;
      // Attackers throw their smoke at the site approach, on the execute.
      if (bot.team === 'attack' && bot.smokes > 0 && !bot.thrownSmoke && bot.pathIndex >= bot.path.length - 1) {
        const site = hooks.nearestSite ? hooks.nearestSite(bot.pos) : null;
        if (site && Math.hypot(bot.pos.x - site.center.x, bot.pos.z - site.center.z) < 13) {
          bot.thrownSmoke = true;
          bot.smokes -= 1;
          hooks.onBotGrenade(bot, 'smoke', site.center);
        }
      }
      if (bot.pathIndex >= bot.path.length) {
        if (bot.role === 'rush') {
          bot.state = 'hold';
          bot.holdUntil = time + range(rng, 0.5, 1.2);
        } else {
          bot.state = 'hold';
          bot.holdUntil = time + range(rng, 2, 4);
        }
      }
    } else {
      bot.state = 'hold';
      bot.holdUntil = time + range(rng, 1, 2.5);
    }
  }

  function damage(bot, amount, part) {
    if (!bot.alive) return false;
    const taken = bot.armor ? Math.round(amount * 0.65) : amount;
    bot.health -= taken;
    if (bot.health > 0) {
      // Being shot turns the bot toward the shooter and makes it investigate.
      // Fire damage does not: a burning bot runs out of the flames, it does
      // not stop to look for who lit them.
      stopChannel(bot);
      if (part !== 'fire' && bot.state !== 'engage') {
        bot.state = 'investigate';
        bot.investigatePos = bot.lastSeenPos.clone();
        bot.path = bfsPath(adj, nearestNode(bot.pos), nearestNode(bot.investigatePos), fireBlockedNodes());
        bot.pathIndex = 0;
      }
      return false;
    }
    bot.alive = false;
    bot.health = 0;
    bot.channel = null;
    bot.channelSite = null;
    bot.fall = 0;
    hooks.onDeath(bot);
    return true;
  }

  function buyRound(bot) {
    const loadout = botLoadout(bot.money, rng);
    const cost = loadoutCost(loadout);
    bot.money = Math.max(0, bot.money - cost);
    bot.weaponKey = loadout.weapon;
    bot.armor = loadout.armor;
    bot.smokes = loadout.smokes;
    bot.flashes = loadout.flashes;
    bot.molotovs = loadout.molotovs;
    bot.mag = WEAPONS[bot.weaponKey].mag;
  }

  function reset(round, carrierName, plan) {
    for (const bot of bots) {
      const spawnList = bot.team === 'attack' ? map.spawns.attack : map.spawns.defend;
      const spawn = spawnList[bots.indexOf(bot) % spawnList.length];
      bot.pos.set(spawn.x + range(rng, -0.6, 0.6), 0, spawn.z + range(rng, -0.6, 0.6));
      bot.yaw = bot.team === 'attack' ? Math.PI : 0;
      bot.health = 100;
      bot.alive = true;
      bot.fall = 0;
      bot.group.rotation.set(0, bot.yaw, 0);
      bot.group.position.copy(bot.pos);
      bot.mag = WEAPONS[bot.weaponKey].mag;
      bot.reloadLeft = 0;
      bot.target = null;
      bot.channel = null;
      bot.channelSite = null;
      bot.carrying = bot.name === carrierName;
      bot.state = 'route';
      bot.role = 'route';
      bot.planNode = 0;
      bot.pathIndex = 0;
      bot.path = [];
      bot.thrownSmoke = false;
      buyRound(bot);
      hooks.assign(bot, plan);
    }
  }

  return {
    bots,
    step(dt, time) {
      for (const bot of bots) stepBot(bot, dt, time);
    },
    damage,
    reset,
    nearestNode,
    pathTo(from, to) {
      return bfsPath(adj, from, to, fireBlockedNodes());
    },
    hearShot(pos, team) {
      for (const bot of bots) {
        // A bot holding a plant or defuse channel is committed to it: a
        // distant shot does not pull it off. Only seeing an enemy (the think
        // step) or taking damage (damage()) interrupts a channel. Without
        // this guard hearShot left the channel attached while the bot walked
        // away to investigate, and the defuse converge check (`!bot.channel`)
        // then refused to start a new channel — so nobody could ever defuse.
        if (!bot.alive || bot.team === team || bot.state === 'engage' || bot.channel) continue;
        const d = Math.hypot(bot.pos.x - pos.x, bot.pos.z - pos.z);
        if (d < HEAR_RANGE && chance(rng, 0.6)) {
          // A defender that hears shots at the far site rotates to help.
          const site = hooks.nearestSite ? hooks.nearestSite(pos) : null;
          if (bot.team === 'defend' && site && chance(rng, 0.5)) {
            bot.state = 'investigate';
            bot.investigatePos = site.center.clone();
            bot.path = bfsPath(adj, nearestNode(bot.pos), nearestNode(site.center), fireBlockedNodes());
            bot.pathIndex = 0;
            continue;
          }
          bot.state = 'investigate';
          bot.investigatePos = pos.clone();
          bot.path = bfsPath(adj, nearestNode(bot.pos), nearestNode(pos), fireBlockedNodes());
          bot.pathIndex = 0;
        }
      }
    },
    hearExplosion(pos, team) {
      // A molotov landing near a defender makes it throw one back at the push.
      for (const bot of bots) {
        if (!bot.alive || bot.team === team || bot.molotovs <= 0) continue;
        const d = Math.hypot(bot.pos.x - pos.x, bot.pos.z - pos.z);
        if (d < 22 && chance(rng, 0.4)) {
          bot.molotovs -= 1;
          hooks.onBotGrenade(bot, 'molotov', pos);
        }
      }
    },
    aliveCount(team) {
      return bots.filter((b) => b.team === team && b.alive).length;
    },
    carrier() {
      return bots.find((b) => b.carrying && b.alive) || null;
    },
    setCarrying(bot) {
      for (const b of bots) b.carrying = false;
      if (bot) bot.carrying = true;
    },
    creditKill(bot) {
      if (bot) bot.money += 50;
    },
    payout(winner, lossBonus) {
      for (const bot of bots) {
        if (bot.team === winner) bot.money += 400;
        else bot.money += lossBonus;
      }
    },
    stopChannel,
    startChannel,
  };
}
