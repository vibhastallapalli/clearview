import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersPreserved } from "./contracts.ts";

test("the AI wording helper may reword but never add or change numbers", () => {
  assert.equal(numbersPreserved("can you do 5 bucks for the missing can", "Would you accept $5 for the missing can?"), true);
  assert.equal(numbersPreserved("i can do 5.00", "I can offer 5."), true);
  assert.equal(numbersPreserved("1,000 cans", "1000 cans"), true);
  assert.equal(numbersPreserved("can you do 5", "Would you accept $7.50?"), false);
  assert.equal(numbersPreserved("the can is dented", "The can is dented; I'd like 100% back."), false);
});
