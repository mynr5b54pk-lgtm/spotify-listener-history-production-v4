const test = require("node:test");
const assert = require("node:assert/strict");
const { assessWorkerFreshness } = require("../src/lib/worker-health");

const now = Date.parse("2026-09-10T12:00:00Z");
const options = { staleHours: 8, restartDelayMinutes: 15, heartbeatStaleMinutes: 15 };

test("does not restart after a recent successful completion", () => {
  const result = assessWorkerFreshness({
    status: "success",
    started_at: "2026-09-10T09:00:00Z",
    finished_at: "2026-09-10T09:30:00Z",
    last_heartbeat_at: "2026-09-10T09:29:00Z"
  }, now, options);
  assert.equal(result.stale, false);
});

test("retries a failed run after the configured delay", () => {
  const result = assessWorkerFreshness({
    status: "failed",
    started_at: "2026-09-10T11:00:00Z",
    finished_at: "2026-09-10T11:30:00Z",
    last_heartbeat_at: "2026-09-10T11:29:00Z"
  }, now, options);
  assert.equal(result.retryAfterFailure, true);
  assert.equal(result.stale, true);
});

test("recovers a running worker only after its heartbeat expires", () => {
  const healthy = assessWorkerFreshness({
    status: "running",
    started_at: "2026-09-10T10:00:00Z",
    last_heartbeat_at: "2026-09-10T11:50:00Z"
  }, now, options);
  const stale = assessWorkerFreshness({
    status: "running",
    started_at: "2026-09-10T10:00:00Z",
    last_heartbeat_at: "2026-09-10T11:40:00Z"
  }, now, options);
  assert.equal(healthy.stale, false);
  assert.equal(stale.staleRunning, true);
});
