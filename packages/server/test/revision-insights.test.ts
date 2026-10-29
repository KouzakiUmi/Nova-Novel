import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeRevisionText } from "@nova-novel/shared";

test("revision insights expose evidence without turning repetition into a score", () => {
  const result = analyzeRevisionText(`${"长".repeat(90)}。\n\n他笑了吗。他笑了吗。短句。`);
  assert.equal(result.paragraphCount, 2);
  assert.equal(result.sentenceCount, 4);
  assert.equal(result.shortParagraphRatio, 50);
  assert.deepEqual(result.repeatedStarts[0], { text: "他笑了吗", count: 2 });
  const empty = analyzeRevisionText("");
  assert.equal(empty.paragraphCount, 0);
  assert.equal(empty.averageSentenceLength, 0);
});
