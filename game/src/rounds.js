// Rounds and the economy: the match state machine, the money, the buy menu
// and the Charge. First to 5 rounds takes the match, at most 9 rounds.
// Attackers plant the Charge at A or B; defenders defuse it. A round is
// also won by eliminating the other team, or by the clock when nothing is
// planted. The loss bonus climbs with consecutive lost rounds (200, then
// 300, then 400), so a losing side can buy back in. The MVP is the player
// or bot with the most eliminations when the match ends.
import { WEAPONS } from './weapons.js';
import { lossBonus } from './plans.js';

export const BUY_ITEMS = [
  { key: '1', id: 'vesper', label: 'Vesper rifle', price: 2700, desc: 'Auto rifle · 34 dmg · 25 rounds' },
  { key: '2', id: 'metro', label: 'Metro SMG', price: 1500, desc: 'Fast SMG · 22 dmg · 32 rounds' },
  { key: '3', id: 'turnstile', label: 'Turnstile shotgun', price: 1200, desc: '8 pellets · close range' },
  { key: '4', id: 'longshot', label: 'Longshot DMR', price: 3200, desc: 'Heavy semi-auto · 68 dmg · 10 rounds' },
  { key: '5', id: 'sidearm', label: 'Sidearm', price: 300, desc: 'Pistol · 26 dmg · 12 rounds' },
  { key: '6', id: 'armor', label: 'Kevlar vest', price: 650, desc: 'Takes 35% less damage' },
  { key: '7', id: 'smoke', label: 'Smoke grenade', price: 300, desc: 'Blocks sight for 12s' },
  { key: '8', id: 'flash', label: 'Flash grenade', price: 200, desc: 'Blinds anyone facing it' },
  { key: '9', id: 'molotov', label: 'Molotov', price: 400, desc: 'Fire zone · 25 dmg/s for 6s' },
];

const WIN_ROUNDS = 5;
const MAX_ROUNDS = 9;
const ROUND_SECONDS = 100;
const BUY_SECONDS = 15;
const FUSE_SECONDS = 35;
const PLANT_SECONDS = 4;
const DEFUSE_SECONDS = 5;
const ROUND_END_SECONDS = 4;

export function createRounds(deps) {
  const { map, bots, hud, audio, pickPlan } = deps;
  const state = {
    phase: 'lobby',
    round: 0,
    score: { attack: 0, defend: 0 },
    timer: 0,
    money: 800,
    kills: 0,
    deaths: 0,
    owned: new Set(['sidearm']),
    weapon: 'sidearm',
    armor: false,
    smokes: 0,
    flashes: 0,
    molotovs: 0,
    lossStreak: 0,
    bomb: { status: 'carried', site: null, pos: null, fuse: 0, carrier: 'player' },
    plantProgress: 0,
    defuseProgress: 0,
    banner: '',
    winner: null,
    lastWinner: null,
    plan: null,
    mvp: null,
  };
  const eliminations = new Map();

  function siteNear(pos) {
    for (const site of map.sites) {
      const dx = pos.x - site.center.x;
      const dz = pos.z - site.center.z;
      if (Math.hypot(dx, dz) <= site.radius) return site;
    }
    return null;
  }

  function recordKill(name) {
    eliminations.set(name, (eliminations.get(name) || 0) + 1);
  }

  function pickMvp() {
    let best = null;
    let bestKills = -1;
    for (const [name, kills] of eliminations) {
      if (kills > bestKills) {
        bestKills = kills;
        best = name;
      }
    }
    return best ? { name: best === 'you' ? 'You' : best, kills: bestKills } : null;
  }

  function startMatch() {
    state.score.attack = 0;
    state.score.defend = 0;
    state.round = 0;
    state.kills = 0;
    state.deaths = 0;
    state.money = 800;
    state.owned = new Set(['sidearm']);
    state.weapon = 'sidearm';
    state.armor = false;
    state.smokes = 0;
    state.flashes = 0;
    state.molotovs = 0;
    state.lossStreak = 0;
    state.winner = null;
    state.lastWinner = null;
    state.plan = null;
    eliminations.clear();
    startBuy();
  }

  function startBuy() {
    state.round += 1;
    state.phase = 'buy';
    state.timer = BUY_SECONDS;
    state.plan = pickPlan ? pickPlan(state.round) : null;
    state.bomb = { status: 'carried', site: null, pos: null, fuse: 0, carrier: 'player' };
    state.plantProgress = 0;
    state.defuseProgress = 0;
    bots.reset(state.round, null, state.plan);
    hud.showBuy(state);
    hud.setBanner(`Round ${state.round} — buy phase`, `${BUY_SECONDS}s to arm up`);
    audio.round();
  }

  function startRound() {
    state.phase = 'live';
    state.timer = ROUND_SECONDS;
    hud.hideBuy();
    hud.setBanner(`Round ${state.round}`, state.plan ? `Plan: ${state.plan.attack.name} — ${state.plan.attack.brief}` : 'Plant the Charge at A or B');
  }

  function endRound(winner, reason) {
    if (state.phase === 'roundEnd' || state.phase === 'matchEnd') return;
    state.score[winner] += 1;
    state.lastWinner = winner;
    const won = winner === 'attack';
    if (won) {
      state.money += 400;
      state.lossStreak = 0;
    } else {
      state.money += lossBonus(state.lossStreak);
      state.lossStreak += 1;
    }
    bots.payout(winner, lossBonus(state.lossStreak));
    state.phase = 'roundEnd';
    state.timer = ROUND_END_SECONDS;
    state.banner = reason;
    hud.setBanner(won ? 'Round won' : 'Round lost', reason);
    hud.setScore(state.score.attack, state.score.defend, state.round);
    hud.setMoney(state.money);
    hud.setArmor(state.armor);
    audio.round();
    if (state.score.attack >= WIN_ROUNDS || state.score.defend >= WIN_ROUNDS || state.round >= MAX_ROUNDS) {
      state.winner = state.score.attack > state.score.defend ? 'attack' : state.score.attack < state.score.defend ? 'defend' : 'draw';
      state.mvp = pickMvp();
    }
  }

  function buy(itemId) {
    if (state.phase !== 'buy') return false;
    const item = BUY_ITEMS.find((i) => i.id === itemId);
    if (!item || state.money < item.price) return false;
    if (item.id === 'smoke' || item.id === 'flash' || item.id === 'molotov') {
      state.money -= item.price;
      if (item.id === 'smoke') state.smokes += 1;
      else if (item.id === 'flash') state.flashes += 1;
      else state.molotovs += 1;
    } else if (item.id === 'armor') {
      if (state.armor) return false;
      state.money -= item.price;
      state.armor = true;
    } else {
      if (state.owned.has(item.id)) {
        state.weapon = item.id;
      } else {
        state.money -= item.price;
        state.owned.add(item.id);
        state.weapon = item.id;
      }
    }
    hud.setMoney(state.money);
    hud.setArmor(state.armor);
    hud.showBuy(state);
    audio.buy();
    return true;
  }

  function dropBomb(pos) {
    if (state.bomb.status !== 'carried') return;
    state.bomb.status = 'dropped';
    state.bomb.pos = pos.clone();
    state.bomb.carrier = null;
    hud.setBomb('dropped');
  }

  function pickupBomb(carrier) {
    state.bomb.status = 'carried';
    state.bomb.carrier = carrier;
    state.bomb.pos = null;
    hud.setBomb('carried');
  }

  function plant(site) {
    state.bomb.status = 'planted';
    state.bomb.site = site;
    state.bomb.fuse = FUSE_SECONDS;
    state.bomb.carrier = null;
    state.money += 50;
    hud.setMoney(state.money);
    hud.setBomb('planted', site);
    hud.setBanner('Charge planted', `${site.name} — ${FUSE_SECONDS}s to detonation`);
    audio.plant();
  }

  function update(dt, ctx) {
    if (state.phase === 'lobby' || state.phase === 'matchEnd') return;
    state.timer -= dt;
    hud.setTimer(Math.max(0, Math.ceil(state.timer)), state.phase);

    if (state.phase === 'buy' && state.timer <= 0) {
      startRound();
      return;
    }
    if (state.phase === 'roundEnd' && state.timer <= 0) {
      if (state.winner) {
        state.phase = 'matchEnd';
        hud.showOverlay('match', state);
      } else {
        startBuy();
      }
      return;
    }
    if (state.phase !== 'live') return;

    // The clock: no plant, no win for the attackers.
    if (state.timer <= 0 && state.bomb.status !== 'planted') {
      endRound('defend', 'Time ran out — the Charge was never planted.');
      return;
    }

    // Planted: the fuse decides unless someone defuses.
    if (state.bomb.status === 'planted') {
      state.bomb.fuse -= dt;
      hud.setFuse(Math.max(0, state.bomb.fuse));
      if (state.bomb.fuse <= 0) {
        endRound('attack', 'The Charge blew Platform A — site destroyed.');
      }
      return;
    }

    // Plant channel: the player holds E inside a site; a carrier bot plants alone.
    const carrierBot = bots.carrier();
    if (ctx.playerAlive && state.bomb.status === 'carried' && state.bomb.carrier === 'player') {
      const site = siteNear(ctx.playerPos);
      if (site && ctx.holdingE) {
        state.plantProgress += dt / PLANT_SECONDS;
        hud.setChannel('plant', state.plantProgress, site.name);
        if (state.plantProgress >= 1) {
          state.plantProgress = 0;
          hud.setChannel(null, 0);
          plant(site);
        }
      } else if (state.plantProgress > 0) {
        state.plantProgress = 0;
        hud.setChannel(null, 0);
      }
    } else if (carrierBot && state.bomb.status === 'carried') {
      const site = siteNear(carrierBot.pos);
      // Only start a channel the carrier does not already hold: calling
      // startChannel every tick rebuilt the channel at progress 0, so a bot
      // carrier could stand on the site for a whole round and never plant.
      if (site && carrierBot.state !== 'engage' && !carrierBot.channel) {
        bots.startChannel(carrierBot, 'plant', site);
      }
    }

    // Dropped Charge: anyone on the attack side picks it up by walking over it.
    if (state.bomb.status === 'dropped' && state.bomb.pos) {
      if (ctx.playerAlive && ctx.playerPos.distanceTo(state.bomb.pos) < 1.4) {
        pickupBomb('player');
      } else {
        for (const bot of bots.bots) {
          if (bot.team === 'attack' && bot.alive && bot.pos.distanceTo(state.bomb.pos) < 1.4) {
            bots.setCarrying(bot);
            pickupBomb(bot.name);
            break;
          }
        }
      }
    }

    // Elimination decides the round when the bomb is not planted.
    const atkAlive = bots.aliveCount('attack') + (ctx.playerAlive ? 1 : 0);
    const defAlive = bots.aliveCount('defend');
    if (defAlive === 0) endRound('attack', 'Defenders eliminated.');
    else if (atkAlive === 0) endRound('defend', 'Attackers eliminated.');
  }

  return {
    state,
    startMatch,
    startBuy,
    startRound,
    endRound,
    buy,
    update,
    dropBomb,
    pickupBomb,
    plant,
    siteNear,
    recordKill,
    onKill() {
      state.kills += 1;
      state.money += 50;
      recordKill('you');
      hud.setMoney(state.money);
      hud.setScore(state.score.attack, state.score.defend, state.round);
    },
    onBotKill(name) {
      recordKill(name);
    },
    onDeath() {
      state.deaths += 1;
    },
  };
}
