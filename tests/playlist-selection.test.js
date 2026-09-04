const test = require("node:test");
const assert = require("node:assert/strict");
const {
  splitPlaylistLimit,
  interleavePlaylistLanes
} = require("../src/lib/playlist-selection");

test("reserves seventy percent of discovery scans for never-scanned playlists", () => {
  assert.deepEqual(splitPlaylistLimit(200, 70), { productive: 60, backfill: 140 });
});

test("playlist allocation remains bounded for empty and invalid inputs", () => {
  assert.deepEqual(splitPlaylistLimit(0, 60), { productive: 0, backfill: 0 });
  assert.deepEqual(splitPlaylistLimit(10, 150), { productive: 0, backfill: 10 });
  assert.deepEqual(splitPlaylistLimit(10, -20), { productive: 10, backfill: 0 });
});

test("interleaves playlist lanes so partial runs preserve the target mix", () => {
  const productive = Array.from({ length: 60 }, (_, index) => ({ id: `p${index}` }));
  const backfill = Array.from({ length: 140 }, (_, index) => ({ id: `b${index}` }));
  const selected = interleavePlaylistLanes(productive, backfill);

  assert.equal(selected.length, 200);
  assert.equal(selected.slice(0, 10).filter(({ id }) => id.startsWith("b")).length, 7);
  assert.equal(new Set(selected.map(({ id }) => id)).size, 200);
  assert.deepEqual(
    selected.filter(({ id }) => id.startsWith("p")),
    productive
  );
  assert.deepEqual(
    selected.filter(({ id }) => id.startsWith("b")),
    backfill
  );
});
