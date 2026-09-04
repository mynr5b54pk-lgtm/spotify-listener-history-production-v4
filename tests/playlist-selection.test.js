const test = require("node:test");
const assert = require("node:assert/strict");
const { splitPlaylistLimit } = require("../src/lib/playlist-selection");

test("reserves sixty percent of discovery scans for never-scanned playlists", () => {
  assert.deepEqual(splitPlaylistLimit(150, 60), { productive: 60, backfill: 90 });
});

test("playlist allocation remains bounded for empty and invalid inputs", () => {
  assert.deepEqual(splitPlaylistLimit(0, 60), { productive: 0, backfill: 0 });
  assert.deepEqual(splitPlaylistLimit(10, 150), { productive: 0, backfill: 10 });
  assert.deepEqual(splitPlaylistLimit(10, -20), { productive: 10, backfill: 0 });
});
