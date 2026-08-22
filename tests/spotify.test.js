const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanArtistName,
  parseCompactNumber,
  extractMonthlyListeners
} = require("../src/lib/spotify");
const { normalizeText } = require("../src/lib/utils");


test("clean canonical Spotify artist names", () => {
  assert.equal(cleanArtistName("Bring Me The Horizon"), "Bring Me The Horizon");
  assert.equal(cleanArtistName("Bring Me The Horizon | Spotify"), "Bring Me The Horizon");
  assert.equal(cleanArtistName("  King   Gnu  "), "King Gnu");
  assert.equal(cleanArtistName("1,234 monthly listeners"), null);
  assert.equal(cleanArtistName("Spotify artist abc123"), null);
  assert.equal(cleanArtistName("Your Library"), null);
  assert.equal(cleanArtistName("Home"), "Home");
  assert.equal(cleanArtistName("Search"), "Search");
});

test("parse compact numbers", () => {
  assert.equal(parseCompactNumber("1.2M"), 1_200_000);
  assert.equal(parseCompactNumber("45.6K"), 45_600);
  assert.equal(parseCompactNumber("12,345"), 12_345);
  assert.equal(parseCompactNumber("1 monthly listeners"), 1);
  assert.equal(parseCompactNumber("12 M monthly listeners"), 12_000_000);
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


test("normalize mojibake and Unicode width", () => {
  assert.equal(normalizeText("BeyoncÃ©"), "Beyoncé");
  assert.equal(normalizeText("ＡＢＣ　Band"), "ABC Band");
  assert.equal(normalizeText("正常な日本語"), "正常な日本語");
  assert.equal(normalizeText("Rock â€“ Roll"), "Rock – Roll");
  assert.equal(normalizeText("A\u0000   B"), "A B");
});
