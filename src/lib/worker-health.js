function age(value, now, divisor) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? (now - timestamp) / divisor : Infinity;
}

function assessWorkerFreshness(latestRun, now, options) {
  const ageHours = age(latestRun?.started_at, now, 3_600_000);
  const idleMinutes = age(latestRun?.finished_at, now, 60_000);
  const heartbeatAgeMinutes = age(
    latestRun?.last_heartbeat_at || latestRun?.started_at,
    now,
    60_000
  );
  const staleRunning = latestRun?.status === "running" &&
    heartbeatAgeMinutes >= options.heartbeatStaleMinutes;
  const retryAfterFailure = ["failed", "partial"].includes(latestRun?.status) &&
    idleMinutes >= options.restartDelayMinutes;
  const staleBySchedule = !latestRun || (latestRun.status !== "running" &&
    ageHours >= options.staleHours);

  return {
    stale: staleRunning || retryAfterFailure || staleBySchedule,
    staleRunning,
    retryAfterFailure,
    staleBySchedule,
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
    idleMinutes: Number.isFinite(idleMinutes) ? Number(idleMinutes.toFixed(1)) : null,
    heartbeatAgeMinutes: Number.isFinite(heartbeatAgeMinutes)
      ? Number(heartbeatAgeMinutes.toFixed(1))
      : null
  };
}

module.exports = { assessWorkerFreshness };
