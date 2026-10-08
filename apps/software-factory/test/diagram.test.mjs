import assert from "node:assert/strict";
import { test } from "node:test";
import { LOOP, draw, runs } from "../components/diagram-grid.ts";

// Common monospace fonts (Liberation Mono, Consolas) have the light box-drawing
// characters but not the heavy ones the pulse uses. A fallback font draws those
// wider, so a row with them in it grows and the centered diagram shifts sideways.
const LIGHT = /^[\x20-\x7e·─│┼┬┴┌┐└┘├┤]*$/;

test("diagram: glyphs a monospace font may lack are each pinned to one cell, so rows never change width", () => {
  for (let tick = 0; tick < LOOP; tick++) {
    for (const row of draw(tick)) {
      for (const run of runs(row)) {
        if ("icon" in run || LIGHT.test(run.text)) continue;
        assert.equal(run.cell, true, `tick ${tick}: "${run.text}" isn't held to one cell`);
        assert.equal([...run.text].length, 1, `tick ${tick}: "${run.text}" isn't held to one cell`);
      }
    }
  }
});

test("diagram: every row is the full width, in cells", () => {
  for (let tick = 0; tick < LOOP; tick += 7) {
    for (const row of draw(tick)) {
      const cells = runs(row).reduce((n, run) => n + ("icon" in run || run.cell ? (("icon" in run) ? 2 : 1) : [...run.text].length), 0);
      assert.equal(cells, 76);
    }
  }
});
