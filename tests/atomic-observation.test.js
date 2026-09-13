const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("successful collection uses the atomic observation RPC", () => {
  const source = fs.readFileSync(path.join(root, "src/lib/db.js"), "utf8");
  assert.match(source, /supabase\.rpc\("save_artist_observation"/);
  assert.doesNotMatch(source, /\.from\("monthly_listener_history"\)\s*\.insert/);
});

test("observation RPC is idempotent per UTC day and service-only", () => {
  const migration = fs.readFileSync(path.join(root, "sql/033_atomic_artist_observation.sql"), "utf8");
  assert.match(migration, /exception when unique_violation/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
});

test("public search does not elevate anonymous requests", () => {
  const migration = fs.readFileSync(path.join(root, "sql/034_remove_public_search_privilege_escalation.sql"), "utf8");
  assert.match(migration, /public_artist_search\(text, integer, integer\)\s+security invoker/);
  assert.match(migration, /grant select \(alias\)[\s\S]*to anon/);
});
