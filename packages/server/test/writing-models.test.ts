import assert from "node:assert/strict";
import { test } from "node:test";
import { writingRecommendation } from "../../web/src/lib/writing-models.js";

test("writing recommendations distinguish preferred writing models without using version rank", () => {
  assert.equal(writingRecommendation("claude-opus-4.6").label, "写作推荐");
  assert.equal(writingRecommendation("claude-sonnet-4.6").label, "写作推荐");
  assert.equal(writingRecommendation("claude-opus-5.5").label, "暂不优先");
  assert.equal(writingRecommendation("claude-sonnet-5.5").label, "暂不优先");
  assert.equal(writingRecommendation("gemini-4-argon").label, "写作推荐");
  assert.equal(writingRecommendation("deepseek-v4.1-flash").label, "写作推荐");
  assert.equal(writingRecommendation("unknown-model").label, "暂不优先");
});
