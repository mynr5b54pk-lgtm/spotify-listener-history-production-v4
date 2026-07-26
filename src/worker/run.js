const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  acquireLock,
  releaseLock,
  reserveQuota,
  completeUsage,
  createRun,
  finishRun
} = require("../lib/db");
const { discoverPlaylists } = require("./discover");
const { scanPlaylists } = require("./scan");
const { collectArtists } = require("./collect");
const {
  uuid,
  deadlineFromMinutes
} = require("../lib/utils");

(async () => {
  const started = Date.now();
  const runToken = uuid();
  let runId = null;
  let lockAcquired = false;

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

  try {
    lockAcquired = await acquireLock(runToken);

    if (!lockAcquired) {
      logger.info("another worker is running; skipped");
      return;
    }

    const quota = await reserveQuota();
    runId = await createRun(runToken, quota);
    const deadline = deadlineFromMinutes(config.MAX_RUNTIME_MINUTES);

    logger.info({ quota }, "worker started");

    const discovery = await discoverPlaylists(
      quota.discoveryAllowed,
      deadline,
      runToken
    );

    stats.discoveryQueriesCompleted = discovery.completed;
    stats.discoveredPlaylists = discovery.discoveredPlaylists;
    stats.failedJobs += discovery.failures;

    const scan = await scanPlaylists(
      quota.playlistAllowed,
      deadline,
      runToken
    );

    stats.playlistScansCompleted = scan.completed;
    stats.discoveredArtists = scan.discoveredArtists;
    stats.failedJobs += scan.failures;

    const collect = await collectArtists(
      quota.artistAllowed,
      deadline,
      runToken
    );

    stats.artistUpdatesCompleted = collect.completed;
    stats.failedJobs += collect.failures;
    stats.durationSeconds = Math.round((Date.now() - started) / 1000);

    await completeUsage(stats);

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
    logger.info({ stats, status }, "worker finished");
  } catch (error) {
    stats.durationSeconds = Math.round((Date.now() - started) / 1000);
    stats.notes = `fatal: ${error.message}`;
    logger.error({ err: error }, "worker fatal error");

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
