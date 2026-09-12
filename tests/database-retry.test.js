const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isTransientDatabaseError,
  retryTransientOperation
} = require("../src/lib/database-retry");

test("recognizes temporary Supabase gateway and network failures", () => {
  assert.equal(isTransientDatabaseError({ message: "Gateway Timeout" }), true);
  assert.equal(isTransientDatabaseError(new TypeError("fetch failed")), true);
  assert.equal(isTransientDatabaseError({ code: "23505", message: "duplicate key" }), false);
});

test("retries a temporary database response and returns the successful result", async () => {
  let calls = 0;
  const result = await retryTransientOperation(async () => {
    calls += 1;
    return calls === 1 ? { data: null, error: { message: "Gateway Timeout" } } : { data: 42, error: null };
  }, { baseDelayMs: 0 });

  assert.equal(calls, 2);
  assert.equal(result.data, 42);
});

test("does not retry permanent database errors", async () => {
  let calls = 0;
  const result = await retryTransientOperation(async () => {
    calls += 1;
    return { data: null, error: { code: "23505", message: "duplicate key" } };
  }, { baseDelayMs: 0 });

  assert.equal(calls, 1);
  assert.equal(result.error.code, "23505");
});
