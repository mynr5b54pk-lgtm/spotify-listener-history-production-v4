const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  getDueArtists,
  saveArtistSuccess,
  saveArtistFailure,
  logJobError
} = require("../lib/db");
const { getPriorityRepairArtists } = require("../lib/repairs");
const { extractMonthlyListenersFromPage, extractArtistName } = require("../lib/spotify");
const { launchBrowser, newPage } = require("./browser");
const {
  mapLimit,
  withRetry,
  sleep,
  randomDelay,
  isPastDeadline
} = require("../lib/utils");

function assertArtistPage(page, artist) {
  const match = page.url().match(/\/artist\/([A-Za-z0-9]+)/);
  const expected = artist.spotify_id || artist.spotify_url?.match(/\/artist\/([A-Za-z0-9]+)/)?.[1];
  if (!match || (expected && match[1] !== expected)) {
    throw new Error(`unexpected artist page: ${page.url()}`);
  }
}

async function readArtistPage(page, artist) {
  assertArtistPage(page, artist);
  const listeners = await extractMonthlyListenersFromPage(page);
  if (listeners === null || listeners < 0 || listeners > 1_000_000_000) {
    throw new Error("monthly listeners not found or out of range");
  }
  return {
    listeners,
    canonicalName: await extractArtistName(page)
  };
}

function needsAnomalyConfirmation(previous, current) {
  const before = Number(previous);
  const after = Number(current);
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after <= 0) return false;
  const ratio = Math.max(after / before, before / after);
  return ratio >= config.ANOMALY_RECHECK_RATIO;
}

async function collectOne(browser, artist, deadline, runToken) {
  if (isPastDeadline(deadline)) return { skipped: true };

  const { context, page } = await newPage(browser);

  try {
    const result = await withRetry(async () => {
      await page.goto(artist.spotify_url, {
        waitUntil: "domcontentloaded",
        timeout: config.PAGE_TIMEOUT_MS
      });
      await page.waitForTimeout(config.PAGE_SETTLE_MS);

      const first = await readArtistPage(page, artist);

      if (needsAnomalyConfirmation(artist.monthly_listeners_latest, first.listeners)) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: config.PAGE_TIMEOUT_MS });
        await page.waitForTimeout(config.PAGE_SETTLE_MS);
        const confirmation = await readArtistPage(page, artist);
        const difference = Math.abs(confirmation.listeners - first.listeners);
        const tolerance = Math.max(
          10,
          Math.round(first.listeners * config.ANOMALY_CONFIRM_TOLERANCE_PERCENT / 100)
        );
        if (difference > tolerance) {
          throw new Error(`unconfirmed listener change: ${first.listeners} -> ${confirmation.listeners}`);
        }
        return confirmation;
      }

      return first;
    }, {
      retries: config.MAX_RETRIES,
      baseDelayMs: config.RETRY_BASE_DELAY_MS,
      label: `artist:${artist.spotify_id || artist.id}`
    });

    await saveArtistSuccess(artist, result.listeners, result.canonicalName);
    logger.info({ artist: result.canonicalName || artist.name, listeners: result.listeners }, "artist collection complete");
    return { completed: 1, failures: 0 };
  } catch (error) {
    await saveArtistFailure(artist, error.message);
    await logJobError({
      run_token: runToken,
      job_type: "artist",
      entity_id: artist.id,
      entity_key: artist.spotify_id || artist.spotify_url,
      error_message: error.message
    });
    logger.error({ err: error, artist: artist.name }, "artist collection failed");
    return { completed: 0, failures: 1 };
  } finally {
    await context.close();
    await sleep(randomDelay(config.REQUEST_DELAY_MS, config.REQUEST_JITTER_MS));
  }
}

async function collectArtists(limit, deadline, runToken, onProgress) {
  const priorityRepairs = config.ARTIST_COLLECTION_MODE === "candidates_only"
    ? []
    : await getPriorityRepairArtists(limit);
  const remaining = Math.max(0, limit - priorityRepairs.length);
  const regularArtists = await getDueArtists(remaining);
  const repairIds = new Set(priorityRepairs.map((artist) => artist.id));
  const artists = [
    ...priorityRepairs,
    ...regularArtists.filter((artist) => !repairIds.has(artist.id))
  ].slice(0, limit);

  if (!artists.length) return { completed: 0, failures: 0 };

  const browser = await launchBrowser();

  try {
    const progress = { completed: 0, failures: 0 };
    const results = await mapLimit(
      artists,
      config.BROWSER_CONCURRENCY,
      async (artist) => {
        const result = await collectOne(browser, artist, deadline, runToken);
        progress.completed += result?.completed || 0;
        progress.failures += result?.failures || 0;
        onProgress?.({ ...progress });
        return result;
      }
    );

    return results.reduce((acc, item) => ({
      completed: acc.completed + (item?.completed || 0),
      failures: acc.failures + (item?.failures || 0)
    }), { completed: 0, failures: 0 });
  } finally {
    await browser.close();
  }
}

module.exports = { collectArtists, needsAnomalyConfirmation };

if (require.main === module) {
  const { deadlineFromMinutes, uuid } = require("../lib/utils");
  collectArtists(
    config.MAX_ARTIST_UPDATES_PER_RUN,
    deadlineFromMinutes(config.MAX_RUNTIME_MINUTES),
    uuid()
  ).then(console.log).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
