const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  acquireLock,
  releaseLock,
  createRun,
  finishRun
} = require("../lib/db");
const { reserveRunQuota, finalizeRunQuota } = require("../lib/quota");
const { heartbeatRun, reconcileStaleRuns } = require("../lib/lifecycle");
const { discoverPlaylists } = require("./discover");
const { scanPlaylists } = require("./scan");
const { collectArtists } = require("./collect");
const { uuid, deadlineFromMinutes, isPastDeadline } = require("../lib/utils");

(async () => {
  const started = Date.now();
  const runToken = uuid();
  let runId = null;
  let lockAcquired = false;
  let quota = null;
  let quotaFinalized = false;
  let heartbeatTimer = null;
  let heartbeatInFlight = false;

  const stats = {
    artistUpdatesCompleted: 0,
    playlistScansCompleted: 0,
    discoveryQueriesCompleted: 0,
    discoveredPlaylists: 0,
    discoveredArtists: 0,
    failedJobs: 0,
    durationSeconds: 0,
    notes: null
  };

  const usage = {
    artistAttempted: 0,
    playlistAttempted: 0,
    discoveryAttempted: 0,
    artistCompleted: 0,
    playlistCompleted: 0,
    discoveryCompleted: 0
  };

  async function finalizeQuotaOnce() {
    if (!quota || quotaFinalized) return;
    await finalizeRunQuota(quota, usage);
    quotaFinalized = true;
  }

  async function pulseHeartbeat() {
    if (!runId || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const ok = await heartbeatRun(runId, runToken);
      if (!ok) logger.error({ runId }, "worker heartbeat lost lock ownership");
    } catch (error) {
      logger.error({ err: error, runId }, "worker heartbeat failed");
    } finally {
      heartbeatInFlight = false;
    }
  }

  try {
    const reconciled = await reconcileStaleRuns();
    if (reconciled > 0) logger.warn({ reconciled }, "stale worker runs reconciled");

    lockAcquired = await acquireLock(runToken);
    if (!lockAcquired) {
      logger.info("another worker is running; skipped");
      return;
    }

    quota = await reserveRunQuota();
    runId = await createRun(runToken, quota);
    await pulseHeartbeat();
    heartbeatTimer = setInterval(pulseHeartbeat, config.WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();

    const deadline = deadlineFromMinutes(config.MAX_RUNTIME_MINUTES);
    logger.info({ quota, deadline: new Date(deadline).toISOString() }, "worker started");

    // Discovery used to run after the large artist queue and was starved on
    // every full-length run. Keep these quotas deliberately small and execute
    // them first, so coverage can grow without materially slowing refreshes.
    if (!isPastDeadline(deadline)) {
      const discovery = await discoverPlaylists(quota.discoveryAllowed, deadline, runToken);
      usage.discoveryAttempted = discovery.completed + discovery.failures;
      usage.discoveryCompleted = discovery.completed;
      stats.discoveryQueriesCompleted = discovery.completed;
      stats.discoveredPlaylists = discovery.discoveredPlaylists;
      stats.failedJobs += discovery.failures;
    }

    if (!isPastDeadline(deadline)) {
      const scan = await scanPlaylists(quota.playlistAllowed, deadline, runToken);
      usage.playlistAttempted = scan.completed + scan.failures;
      usage.playlistCompleted = scan.completed;
      stats.playlistScansCompleted = scan.completed;
      stats.discoveredArtists = scan.discoveredArtists;
      stats.failedJobs += scan.failures;
    }

    if (!isPastDeadline(deadline)) {
      const collect = await collectArtists(quota.artistAllowed, deadline, runToken);
      usage.artistAttempted = collect.completed + collect.failures;
      usage.artistCompleted = collect.completed;
      stats.artistUpdatesCompleted = collect.completed;
      stats.failedJobs += collect.failures;
    } else {
      stats.notes = "runtime budget exhausted before artist collection";
    }

    stats.durationSeconds = Math.round((Date.now() - started) / 1000);
    await finalizeQuotaOnce();

    const status = stats.failedJobs === 0
      ? "success"
      : stats.artistUpdatesCompleted + stats.playlistScansCompleted + stats.discoveryQueriesCompleted > 0
        ? "partial"
        : "failed";

    await finishRun(runId, stats, status, quotaFinalized);
    logger.info({ stats, usage, status }, "worker finished");
  } catch (error) {
    stats.durationSeconds = Math.round((Date.now() - started) / 1000);
    stats.notes = `fatal: ${error.message}`;
    logger.error({ err: error }, "worker fatal error");

    try { await finalizeQuotaOnce(); } catch (quotaError) {
      logger.error({ err: quotaError }, "failed to finalize run quota");
    }

    if (runId) {
      try { await finishRun(runId, stats, "failed", quotaFinalized); } catch (finishError) {
        logger.error({ err: finishError }, "failed to save worker failure");
      }
    }
    process.exitCode = 1;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lockAcquired) {
      try { await releaseLock(runToken); } catch (error) {
        logger.error({ err: error }, "failed to release lock");
      }
    }
  }
})();
