const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldRetainArtist } = require("../src/lib/threshold");

test("only artists at or above the threshold are retained", () => {
  assert.equal(shouldRetainArtist(9_999), false);
  assert.equal(shouldRetainArtist(10_000), true);
  assert.equal(shouldRetainArtist(10_001), true);
  assert.equal(shouldRetainArtist(null), false);
  assert.equal(shouldRetainArtist("invalid"), false);
});
