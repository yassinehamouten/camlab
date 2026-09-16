import { describe, it, expect } from "vitest";
import { createGame, resetGame, flap, stepGame, circleRect } from "../src/lib/flappy.js";

const W = 1280, H = 720;

describe("createGame / resetGame", () => {
  it("initial state: ready, bird centered, no pipes", () => {
    const g = createGame(W, H);
    expect(g.state).toBe("ready");
    expect(g.bird.y).toBe(H / 2);
    expect(g.pipes).toHaveLength(0);
    expect(g.score).toBe(0);
    expect(g.clouds).toHaveLength(5);
  });

  it("resetGame(full) clears the score but keeps best", () => {
    const g = createGame(W, H);
    g.score = 7; g.best = 9;
    resetGame(g, W, H, true);
    expect(g.score).toBe(0);
    expect(g.best).toBe(9);
    expect(g.pipes).toHaveLength(0);
  });
});

describe("flap / stepGame", () => {
  it("flap starts the game and pushes the bird upward", () => {
    const g = createGame(W, H);
    flap(g, W, H);
    expect(g.state).toBe("play");
    expect(g.bird.vy).toBeLessThan(0);
  });

  it("in ready state the bird bobs around the center and nothing spawns", () => {
    const g = createGame(W, H);
    stepGame(g, 1 / 60, W, H);
    stepGame(g, 1 / 60, W, H);
    expect(Math.abs(g.bird.y - H / 2)).toBeLessThan(H * 0.05);
    expect(g.pipes).toHaveLength(0);
  });

  it("gravity makes the vertical velocity increasingly positive", () => {
    const g = createGame(W, H);
    flap(g, W, H);
    const vy0 = g.bird.vy;
    stepGame(g, 0.1, W, H);
    expect(g.bird.vy).toBeGreaterThan(vy0);
  });

  it("passing a pipe increments the score and fires onScore", () => {
    const g = createGame(W, H);
    flap(g, W, H);
    g.bird.y = H / 2;
    const pw = W * 0.062;
    g.pipes.push({ x: 10, gapY: H / 2 - 90, gapH: 180, scored: false });
    let scores = 0;
    stepGame(g, 1 / 60, W, H, { onScore: () => scores++ });
    expect(g.score).toBe(1);
    expect(scores).toBe(1);
    expect(g.best).toBe(1);
    expect(pw).toBeGreaterThan(0); // fixture sanity check
  });

  it("touching the floor kills the bird and fires onDie", () => {
    const g = createGame(W, H);
    flap(g, W, H);
    g.bird.vy = 0;                    // otherwise the flap impulse would move the bird up
    g.bird.y = H - g.bird.r + 2;      // below the floor (h − 6)
    let died = 0;
    stepGame(g, 1 / 60, W, H, { onDie: () => died++ });
    expect(g.state).toBe("dead");
    expect(died).toBe(1);
  });

  it("touching a pipe kills the bird", () => {
    const g = createGame(W, H);
    flap(g, W, H);
    g.bird.y = H / 2;
    g.pipes.push({ x: g.bird.x - 20, gapY: H / 2 - 40, gapH: 30, scored: true }); // gap shifted away: direct collision
    stepGame(g, 1 / 60, W, H);
    expect(g.state).toBe("dead");
  });

  it("dead state freezes the simulation", () => {
    const g = createGame(W, H);
    g.state = "dead";
    g.bird.y = 100;
    stepGame(g, 0.5, W, H);
    expect(g.bird.y).toBe(100);
  });
});

describe("circleRect", () => {
  it("circle-rectangle collision", () => {
    const c = { x: 50, y: 50, r: 10 };
    expect(circleRect(c, 0, 0, 100, 100)).toBe(true);   // inside
    expect(circleRect(c, 200, 200, 50, 50)).toBe(false); // far away
    expect(circleRect({ x: 105, y: 50, r: 10 }, 0, 0, 100, 100)).toBe(true);  // overlaps right edge
    expect(circleRect({ x: 115, y: 50, r: 10 }, 0, 0, 100, 100)).toBe(false); // just beside
  });
});
