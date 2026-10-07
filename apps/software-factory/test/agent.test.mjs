import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTIONS } from "../app/api/board/[[...path]]/agent.ts";

for (const task of ["thread", "review"]) {
  test(`${task}: Pi stays out of messages meant for someone else`, () => {
    assert.match(INSTRUCTIONS[task], /addressed to someone else/);
    assert.match(INSTRUCTIONS[task], /don't reply/i);
  });

  test(`${task}: board replies are tight, with no "what I ran" list`, () => {
    assert.doesNotMatch(INSTRUCTIONS[task], /list of what you ran/);
    assert.match(INSTRUCTIONS[task], /no "What I ran"/i);
    assert.match(INSTRUCTIONS[task], /a few lines/);
  });
}

test("review: detail goes in GitHub review comments, not the board", () => {
  assert.match(INSTRUCTIONS.review, /gh api .*pulls\/<N>\/reviews/);
  assert.match(INSTRUCTIONS.review, /file:line/);
});
