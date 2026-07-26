const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCompactNumber,
  extractMonthlyListeners
} = require("../src/lib/spotify");

test("parse compact numbers", () => {
  assert.equal(parseCompactNumber("1.2M"), 1_200_000);
  assert.equal(parseCompactNumber("45.6K"), 45_600);
  assert.equal(parseCompactNumber("12,345"), 12_345);
});

test("extract English monthly listeners", () => {
  assert.equal(
    extractMonthlyListeners("Artist\n1,234,567 monthly listeners\nPopular"),
    1_234_567
  );
});

test("extract Japanese monthly listeners", () => {
  assert.equal(
    extractMonthlyListeners("アーティスト\n1,234,567人の月間リスナー\n人気"),
    1_234_567
  );
});
