// The minimap: a small canvas top-down of the station, drawn from the same
// wall list the map hands the game, so it can never disagree with the map.
// Teammates are amber dots, the player is a white arrow, the Charge carrier
// carries a dot, and a planted Charge pulses red on its site. It redraws
// every sixth frame; the canvas is small and the draw is cheap.
export function createMinimap(map) {
  const canvas = document.getElementById('minimap');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  // Map bounds x -20..20, z -17..17 -> scale to the canvas with a margin.
  const scale = Math.min(W / 42, H / 36);
  const ox = W / 2;
  const oy = H / 2;

  function toX(x) { return ox + x * scale; }
  function toY(z) { return oy + z * scale; }

  let frame = 0;

  function draw(state) {
    frame += 1;
    if (frame % 6 !== 0) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10, 14, 20, 0.82)';
    ctx.fillRect(0, 0, W, H);

    // Walls.
    ctx.fillStyle = '#7d94a0';
    for (const w of map.minimapWalls) {
      ctx.fillRect(toX(w.x - w.w / 2), toY(w.z - w.d / 2), Math.max(1, w.w * scale), Math.max(1, w.d * scale));
    }
    // Sites.
    for (const site of map.sites) {
      ctx.strokeStyle = '#f2a541';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(toX(site.center.x), toY(site.center.z), site.radius * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f2a541';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(site.id, toX(site.center.x), toY(site.center.z) - site.radius * scale - 3);
    }
    // Planted Charge pulses on its site.
    if (state.bomb.status === 'planted' && state.bomb.site) {
      const pulse = 3 + Math.sin(performance.now() / 150) * 1.5;
      ctx.fillStyle = '#e0564a';
      ctx.beginPath();
      ctx.arc(toX(state.bomb.site.center.x), toY(state.bomb.site.center.z), pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    // Dropped Charge marker.
    if (state.bomb.status === 'dropped' && state.bomb.pos) {
      ctx.fillStyle = '#f2a541';
      ctx.fillRect(toX(state.bomb.pos.x) - 3, toY(state.bomb.pos.z) - 3, 6, 6);
    }
    // Teammates.
    for (const bot of state.bots) {
      if (!bot.alive) continue;
      ctx.fillStyle = bot.team === 'attack' ? '#f2a541' : '#5d8fa8';
      ctx.beginPath();
      ctx.arc(toX(bot.pos.x), toY(bot.pos.z), bot.carrying ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // The player: a white arrow that turns with the view.
    if (state.playerAlive) {
      ctx.save();
      ctx.translate(toX(state.playerPos.x), toY(state.playerPos.z));
      ctx.rotate(-state.playerYaw + Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(3.5, 4);
      ctx.lineTo(-3.5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  return { draw };
}
