// The DOM HUD: crosshair, hit marker, health and armour, ammo, money,
// timer, score, bomb status, kill feed, round banner, the buy menu, the
// minimap canvas and the overlays. It never touches the simulation;
// main.js and rounds.js push numbers in, and it reads the play and buy
// callbacks out. Every setter caches its last value so the DOM is not
// rewritten every frame.
import { BUY_ITEMS } from './rounds.js';

const COPY = {
  start: {
    title: 'LAST TRAIN',
    copy: 'A metro station at night. Plant the Charge at Platform A or Platform B — or wipe the defenders out. Click to play.',
    action: 'Click to play',
  },
  paused: {
    title: 'LAST TRAIN',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  roundEnd: {
    title: 'Round over',
    copy: '',
    action: 'Next round',
  },
  match: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
};

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay');
  const title = $('overlay-title');
  const copy = $('overlay-copy');
  const play = $('play');
  const ammoMag = $('ammo-mag');
  const ammoReserve = $('ammo-reserve');
  const ammoBox = $('ammo');
  const healthFill = $('health-fill');
  const healthNum = $('health-num');
  const armorFill = $('armor-fill');
  const armorBox = $('armor');
  const moneyValue = $('money-value');
  const timerValue = $('timer-value');
  const scoreAttack = $('score-attack');
  const scoreDefend = $('score-defend');
  const roundValue = $('round-value');
  const teamAttack = $('team-attack');
  const teamDefend = $('team-defend');
  const bombLine = $('bomb-line');
  const channelBox = $('channel');
  const channelFill = $('channel-fill');
  const channelLabel = $('channel-label');
  const banner = $('banner');
  const bannerTitle = $('banner-title');
  const bannerSub = $('banner-sub');
  const feed = $('feed');
  const hitmarker = $('hitmarker');
  const crosshair = $('crosshair');
  const buyPanel = $('buy');
  const buyList = $('buy-list');
  const buyPlan = $('buy-plan');
  const damageVignette = $('damage');
  const damageDir = $('damage-dir');
  const flashOverlay = $('flash');
  const bombMarker = $('bomb-marker');
  const grenades = $('grenades');
  let last = {};
  let hitTimer = 0;
  let bannerTimer = 0;
  let dirTimer = 0;

  function setText(el, key, value) {
    if (last[key] === value) return;
    last[key] = value;
    el.textContent = value;
  }

  const hud = {
    setAmmo(mag, reserve, weaponName) {
      setText(ammoMag, 'mag', String(mag));
      setText(ammoReserve, 'reserve', `/ ${reserve}`);
      setText($('weapon-name'), 'weapon', weaponName);
      ammoBox.classList.toggle('empty', mag === 0);
    },
    setHealth(hp) {
      const pct = Math.max(0, Math.min(100, hp));
      if (last.hp !== pct) {
        last.hp = pct;
        healthFill.style.width = `${pct}%`;
        healthNum.textContent = String(pct);
        healthFill.classList.toggle('low', pct <= 30);
      }
    },
    setArmor(hasArmor) {
      if (last.armor === hasArmor) return;
      last.armor = hasArmor;
      armorBox.hidden = !hasArmor;
      armorFill.style.width = hasArmor ? '100%' : '0%';
    },
    setMoney(value) {
      setText(moneyValue, 'money', `$${value}`);
    },
    setTimer(seconds, phase) {
      const m = Math.floor(seconds / 60);
      const s = String(seconds % 60).padStart(2, '0');
      setText(timerValue, 'timer', `${m}:${s}`);
      timerValue.classList.toggle('urgent', phase === 'live' && seconds <= 15);
    },
    setScore(atk, def, round) {
      setText(scoreAttack, 'sa', String(atk));
      setText(scoreDefend, 'sd', String(def));
      setText(roundValue, 'round', `Round ${round} / 9`);
    },
    setTeams(atkAlive, defAlive) {
      setText(teamAttack, 'ta', `ATK ${atkAlive}`);
      setText(teamDefend, 'td', `DEF ${defAlive}`);
    },
    setBomb(status, site) {
      if (status === 'planted' && site) setText(bombLine, 'bomb', `CHARGE PLANTED — ${site.name}`);
      else if (status === 'dropped') setText(bombLine, 'bomb', 'CHARGE DROPPED — pick it up');
      else if (status === 'carried') setText(bombLine, 'bomb', 'CHARGE ON YOU — plant at A or B');
      else setText(bombLine, 'bomb', '');
      bombLine.classList.toggle('hot', status === 'planted');
    },
    setFuse(seconds) {
      setText(bombLine, 'fuse', `CHARGE PLANTED — ${seconds.toFixed(0)}s to detonation`);
      bombLine.classList.add('hot');
    },
    setChannel(type, progress, siteName) {
      if (!type) {
        channelBox.hidden = true;
        return;
      }
      channelBox.hidden = false;
      channelFill.style.width = `${Math.round(progress * 100)}%`;
      channelLabel.textContent = type === 'plant' ? `Planting at ${siteName}…` : 'Defusing…';
    },
    setBanner(titleText, sub) {
      bannerTitle.textContent = titleText;
      bannerSub.textContent = sub || '';
      banner.hidden = false;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.hidden = true; }, 3200);
    },
    hideBanner() {
      clearTimeout(bannerTimer);
      banner.hidden = true;
    },
    killFeed(text) {
      const line = document.createElement('div');
      line.className = 'feed-line';
      line.textContent = text;
      feed.prepend(line);
      while (feed.children.length > 5) feed.removeChild(feed.lastChild);
      setTimeout(() => line.remove(), 6000);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    setSpread(px) {
      crosshair.style.setProperty('--gap', `${px}px`);
    },
    damageFlash(fromAngleDeg) {
      damageVignette.classList.add('on');
      setTimeout(() => damageVignette.classList.remove('on'), 180);
      if (fromAngleDeg !== undefined) {
        damageDir.style.transform = `translate(-50%, -50%) rotate(${fromAngleDeg}deg)`;
        damageDir.classList.add('on');
        clearTimeout(dirTimer);
        dirTimer = setTimeout(() => damageDir.classList.remove('on'), 500);
      }
    },
    flashBang(strength) {
      flashOverlay.style.opacity = String(strength);
      setTimeout(() => { flashOverlay.style.opacity = '0'; }, 120);
      setTimeout(() => { flashOverlay.style.opacity = String(strength * 0.6); }, 500);
      setTimeout(() => { flashOverlay.style.opacity = '0'; }, 1400);
    },
    setGrenades(smokes, flashes, molotovs) {
      const text = `SMOKE ${smokes} · FLASH ${flashes} · MOLOTOV ${molotovs}`;
      setText(grenades, 'nades', text);
    },
    showOverlay(mode, state) {
      const text = COPY[mode];
      title.textContent = text.title;
      if (mode === 'match') {
        const w = state.winner;
        const mvp = state.mvp ? ` MVP: ${state.mvp.name} (${state.mvp.kills} eliminations).` : '';
        copy.textContent = w === 'attack'
          ? `Attackers take the match ${state.score.attack}–${state.score.defend}. ${state.kills} eliminations, ${state.deaths} deaths.${mvp}`
          : w === 'defend'
            ? `Defenders hold the station ${state.score.defend}–${state.score.attack}. ${state.kills} eliminations, ${state.deaths} deaths.${mvp}`
            : `A draw, ${state.score.attack}–${state.score.defend}. ${state.kills} eliminations, ${state.deaths} deaths.${mvp}`;
      } else if (mode === 'roundEnd') {
        copy.textContent = state.banner || '';
      } else {
        copy.textContent = text.copy;
      }
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
    showBuy(state) {
      buyPanel.hidden = false;
      buyList.innerHTML = '';
      for (const item of BUY_ITEMS) {
        const owned = item.id === 'armor' ? state.armor : state.owned.has(item.id);
        const row = document.createElement('div');
        row.className = 'buy-row';
        if (state.money < item.price && !owned) row.classList.add('poor');
        row.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-name">${item.label}</span><span class="buy-desc">${item.desc}</span><span class="buy-price">${owned ? 'OWNED' : '$' + item.price}</span>`;
        buyList.appendChild(row);
      }
      $('buy-money').textContent = `$${state.money}`;
      if (state.plan) {
        buyPlan.textContent = `Plan: ${state.plan.attack.name} — ${state.plan.attack.brief}`;
        buyPlan.hidden = false;
      } else {
        buyPlan.hidden = true;
      }
    },
    hideBuy() {
      buyPanel.hidden = true;
    },
    setBombMarker(show, x, y) {
      bombMarker.hidden = !show;
      if (show) {
        bombMarker.style.left = `${x}px`;
        bombMarker.style.top = `${y}px`;
      }
    },
  };
  return hud;
}
