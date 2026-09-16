/* Pure Flappy physics (unit-tested with Vitest) — no canvas/DOM/audio access.
   Side effects (sound, high-score persistence) go through hooks. */

export function createGame(w, h) {
  return {
    state: "ready", // ready | play | dead
    bird: { x: w * 0.28, y: h / 2, vy: 0, r: Math.max(14, h * 0.022) },
    pipes: [],
    clouds: Array.from({ length: 5 }, () => ({
      x: Math.random() * w, y: Math.random() * h * 0.5, r: 20 + Math.random() * 40,
    })),
    lastHands: [],
    score: 0, best: 0, t: 0, lastTs: 0, palmPrev: false,
  };
}

export function resetGame(game, w, h, full) {
  game.bird = { x: w * 0.28, y: h / 2, vy: 0, r: Math.max(14, h * 0.022) };
  game.pipes = [];
  game.lastHands = [];
  if (full) game.score = 0;
  game.clouds = Array.from({ length: 5 }, () => ({
    x: Math.random() * w, y: Math.random() * h * 0.5, r: 20 + Math.random() * 40,
  }));
}

export function flap(game, w, h) {
  if (game.state !== "play") {
    resetGame(game, w, h, true);
    game.state = "play";
  }
  game.bird.vy = -h * 0.62;
}

export function circleRect(c, rx, ry, rw, rh) {
  const nx = Math.max(rx, Math.min(c.x, rx + rw));
  const ny = Math.max(ry, Math.min(c.y, ry + rh));
  return (c.x - nx) ** 2 + (c.y - ny) ** 2 < c.r * c.r;
}

/* Advance the simulation by dt seconds. hooks: { onScore, onDie } */
export function stepGame(game, dt, w, h, hooks = {}) {
  game.t += dt;
  const v = w * 0.19 * Math.min(1.6, 1 + game.score * 0.035);
  for (const c of game.clouds) {
    c.x -= v * 0.25 * dt;
    if (c.x < -c.r * 2) { c.x = w + c.r * 2; c.y = Math.random() * h * 0.5; }
  }
  if (game.state === "ready") {
    game.bird.y = h / 2 + Math.sin(game.t * 3) * h * 0.02;
    return;
  }
  if (game.state !== "play") return;

  game.bird.vy += h * 1.9 * dt;
  game.bird.y += game.bird.vy * dt;

  const pw = w * 0.062;
  const gapH = Math.max(h * 0.27, 170) - Math.min(game.score, 8) * 4;
  if (!game.pipes.length || game.pipes[game.pipes.length - 1].x < w - w * 0.30) {
    const gapY = h * 0.15 + Math.random() * (h * 0.7 - gapH);
    game.pipes.push({ x: w + pw, gapY, gapH, scored: false });
  }
  for (const p of game.pipes) p.x -= v * dt;
  if (game.pipes[0] && game.pipes[0].x + pw < -10) game.pipes.shift();

  for (const p of game.pipes) {
    if (!p.scored && p.x + pw < game.bird.x) {
      p.scored = true;
      game.score++;
      hooks.onScore?.(game.score);
      if (game.score > game.best) game.best = game.score;
    }
  }

  const b = game.bird;
  if (b.y + b.r >= h - 6 || b.y - b.r <= 0) {
    game.state = "dead";
    hooks.onDie?.();
    return;
  }
  for (const p of game.pipes) {
    if (circleRect(b, p.x, 0, pw, p.gapY) || circleRect(b, p.x, p.gapY + p.gapH, pw, h)) {
      game.state = "dead";
      hooks.onDie?.();
      return;
    }
  }
}
