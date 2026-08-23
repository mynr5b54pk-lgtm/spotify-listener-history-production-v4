const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  acquireLock,
  releaseLock,
  createRun,
  finishRun
} = require("../lib/db");
const { reserveRunQuota, finalizeRunQuota } = require("../lib/quota");
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

  try {
    lockAcquired = await acquireLock(runToken);

    if (!lockAcquired) {
      logger.info("another worker is running; skipped");
      return;
    }

    quota = await reserveRunQuota();
    runId = await createRun(runToken, quota);
    const deadline = deadlineFromMinutes(config.MAX_RUNTIME_MINUTES);

    logger.info({ quota }, "worker started");

    // Listener history is the core product. Do this first so playlist discovery
    // can never consume the runtime budget needed for due active artists.
    const collect = await collectArtists(
      quota.artistAllowed,
      deadline,
      runToken
    );
    usage.artistAttempted = collect.completed + collect.failures;
    usage.artistCompleted = collect.completed;
    stats.artistUpdatesCompleted = collect.completed;
    stats.failedJobs += collect.failures;

    if (!isPastDeadline(deadline)) {
      const scan = await scanPlaylists(
        quota.playlistAllowed,
        deadline,
        runToken
      );
      usage.playlistAttempted = scan.completed + scan.failures;
      usage.playlistCompleted = scan.completed;
      stats.playlistScansCompleted = scan.completed;
      stats.discoveredArtists = scan.discoveredArtists;
      stats.failedJobs += scan.failures;
    } else {
      stats.notes = "runtime budget exhausted after artist collection; discovery deferred";
    }

    if (!isPastDeadline(deadline)) {
      const discovery = await discoverPlaylists(
        quota.discoveryAllowed,
        deadline,
        runToken
      );
      usage.discoveryAttempted = discovery.completed + discovery.failures;
      usage.discoveryCompleted = discovery.completed;
      stats.discoveryQueriesCompleted = discovery.completed;
      stats.discoveredPlaylists = discovery.discoveredPlaylists;
      stats.failedJobs += discovery.failures;
    }

    stats.durationSeconds = Math.round((Date.now() - started) / 1000);
    await finalizeQuotaOnce();

    const status =
      stats.failedJobs === 0
        ? "success"
        : stats.artistUpdatesCompleted +
            stats.playlistScansCompleted +
            stats.discoveryQueriesCompleted >
          0
          ? "partial"
          : "failed";

    await finishRun(runId, stats, status);
    logger.info({ stats, usage, status }, "worker finished");
  } catch (error) {
    stats.durationSeconds = Math.round((Date.now() - started) / 1000);
    stats.notes = `fatal: ${error.message}`;
    logger.error({ err: error }, "worker fatal error");

    try {
      await finalizeQuotaOnce();
    } catch (quotaError) {
      logger.error({ err: quotaError }, "failed to finalize run quota");
    }

    if (runId) {
      try {
        await finishRun(runId, stats, "failed");
      } catch (finishError) {
        logger.error({ err: finishError }, "failed to save worker failure");
      }
    }

    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      try {
        await releaseLock(runToken);
      } catch (error) {
        logger.error({ err: error }, "failed to release lock");
      }
    }
  }
})();
