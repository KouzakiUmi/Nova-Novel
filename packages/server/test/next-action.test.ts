import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendNextAction } from "@nova-novel/shared";

test("next action favors the current decision instead of more generation buttons", () => {
  assert.equal(recommendNextAction({ hasBody: false, hasPlan: false }).kind, "plan");
  assert.equal(recommendNextAction({ hasBody: false, hasPlan: true }).kind, "write");
  assert.equal(recommendNextAction({ hasBody: true, hasPlan: true, outcome: "candidate" }).kind, "review-candidate");
  assert.equal(recommendNextAction({ hasBody: true, hasPlan: true, outcome: "candidate", stale: true }).kind, "compare");
  assert.equal(recommendNextAction({ hasBody: true, hasPlan: true, lastAction: "accepted" }).kind, "review-scene");
  assert.equal(recommendNextAction({ hasBody: true, hasPlan: true, outcome: "report" }).kind, "continue");
  assert.equal(recommendNextAction({ hasBody: true, hasPlan: true, lastAction: "reviewed" }).kind, "plan");
});
