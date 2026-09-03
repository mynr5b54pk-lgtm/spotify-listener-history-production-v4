const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "sb_secret_test_key_that_is_long_enough";
process.env.ADMIN_TOKEN ||= "test_admin_token_that_is_long_enough";

const config = require("../src/lib/config");

test("production-safe collection defaults remain balanced", () => {
  assert.equal(config.MIN_MONTHLY_LISTENERS, 10_000);
  assert.equal(config.ACTIVE_RECHECK_HOURS, 120);
  assert.equal(config.MAX_RUNTIME_MINUTES, 325);
  assert.equal(config.BROWSER_CONCURRENCY, 10);
  assert.equal(config.MAX_CANDIDATE_UPDATES_PER_RUN, 150);
  assert.equal(config.ARTIST_COLLECTION_MODE, "balanced");
  assert.equal(config.MAX_PLAYLIST_ACTIVE_POOL, 2_000);
  assert.equal(config.CANDIDATE_QUEUE_HIGH_WATERMARK, 5_000);
  assert.equal(config.BACKLOGGED_PLAYLIST_SCANS_PER_RUN, 60);
  assert.ok(config.MAX_CANDIDATE_UPDATES_PER_RUN < config.MAX_ARTIST_UPDATES_PER_RUN);
});
