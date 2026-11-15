// Team plans and the bot economy. The attack picks one plan per round and
// every attacker gets a role in it; the defence holds the sites and rotates
// on intel. Bots buy with their own money, in tiers: full buys when rich,
// force buys when middling, eco when broke. The loss bonus climbs with
// consecutive lost rounds, so a team that keeps losing can still buy back in.
import { pick, chance } from './rng.js';

export const ATTACK_PLANS = {
  'a-rush': { name: 'A RUSH', site: 'A', brief: 'All five push the West Tunnel to Platform A, fast.' },
  'b-rush': { name: 'B RUSH', site: 'B', brief: 'All five push the East Tunnel to Platform B, fast.' },
  split: { name: 'SPLIT', site: null, brief: 'Two hit A, two hit B, the carrier reads the defence and picks.' },
  fake: { name: 'FAKE A', site: 'B', brief: 'Three show at A, the carrier slips to B with one escort.' },
  default: { name: 'DEFAULT', site: null, brief: 'Spread out, clear the lanes, take the quiet site.' },
};

// Waypoint indices on the LAST TRAIN map (see map.js): hall 0, gates 3,
// concourse 6, west tunnel 8/9, east tunnel 13/14, platform A 11, B 16,
// mid 21, A approach 19, B approach 20.
const PLAN_ROLES = {
  'a-rush': [19, 19, 10, 10, 11],
  'b-rush': [20, 20, 15, 15, 16],
  split: [10, 11, 15, 16, 6],
  fake: [10, 10, 11, 15, 16],
  default: [17, 18, 6, 10, 15],
};

export function pickAttackPlan(rng, round) {
  const keys = ['a-rush', 'b-rush', 'split', 'fake', 'default'];
  // Early rounds default more; later rounds commit to a rush or a fake.
  const weights = round <= 1 ? [1, 1, 2, 1, 3] : [3, 3, 2, 2, 1];
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng() * total;
  for (let i = 0; i < keys.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return keys[i];
  }
  return 'default';
}

export function planTargets(planId) {
  return PLAN_ROLES[planId] || PLAN_ROLES.default;
}

export function planBrief(planId) {
  return ATTACK_PLANS[planId] || ATTACK_PLANS.default;
}

export function lossBonus(lossStreak) {
  if (lossStreak >= 3) return 400;
  if (lossStreak === 2) return 300;
  return 200;
}

// A bot's buy, from its own wallet. Returns what it buys and what it spent.
export function botLoadout(money, rng) {
  if (money >= 3350) {
    return { weapon: chance(rng, 0.6) ? 'vesper' : 'longshot', armor: true, smokes: 1, flashes: 1, molotovs: chance(rng, 0.5) ? 1 : 0, spent: 0 };
  }
  if (money >= 2700) {
    return { weapon: 'vesper', armor: true, smokes: 0, flashes: 1, molotovs: 0, spent: 0 };
  }
  if (money >= 1500) {
    return { weapon: 'metro', armor: false, smokes: 0, flashes: chance(rng, 0.5) ? 1 : 0, molotovs: 0, spent: 0 };
  }
  if (money >= 1200) {
    return { weapon: 'turnstile', armor: false, smokes: 0, flashes: 0, molotovs: 0, spent: 0 };
  }
  return { weapon: 'sidearm', armor: false, smokes: 0, flashes: 0, molotovs: 0, spent: 0 };
}

export function loadoutCost(loadout) {
  const prices = { vesper: 2700, longshot: 3200, metro: 1500, turnstile: 1200, sidearm: 0 };
  let cost = prices[loadout.weapon] || 0;
  if (loadout.armor) cost += 650;
  cost += (loadout.smokes || 0) * 300 + (loadout.flashes || 0) * 200 + (loadout.molotovs || 0) * 400;
  return cost;
}

// One round's full team plan: the attack's plan with its waypoint targets
// per attacker, and the defence's holds per defender (two per site, one
// roamer). Waypoint indices are the map's (see map.js).
export function makeRoundPlan(rng, round) {
  const id = pickAttackPlan(rng, round);
  const brief = ATTACK_PLANS[id];
  return {
    attack: { id, name: brief.name, site: brief.site, brief: brief.brief, targets: planTargets(id) },
    defend: { a: [10, 11], b: [15, 16], roamer: chance(rng, 0.5) ? 'mid' : 'tunnel' },
  };
}
