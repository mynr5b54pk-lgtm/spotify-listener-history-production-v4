const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  getDueArtists,
  saveArtistSuccess,
  saveArtistFailure,
  logJobError
} = require("../lib/db");
const { extractMonthlyListeners, extractArtistName } = require("../lib/spotify");
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
      assertArtistPage(page, artist);

      const text = await page.locator("body").innerText();
      const value = extractMonthlyListeners(text);

      if (value === null) {
        throw new Error("monthly listeners not found");
      }

      return {
        listeners: value,
        canonicalName: await extractArtistName(page)
      };
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

async function collectArtists(limit, deadline, runToken) {
  const artists = await getDueArtists(limit);
  if (!artists.length) return { completed: 0, failures: 0 };

  const browser = await launchBrowser();

  try {
    const results = await mapLimit(
      artists,
      config.BROWSER_CONCURRENCY,
      (artist) => collectOne(browser, artist, deadline, runToken)
    );

    return results.reduce((acc, item) => ({
      completed: acc.completed + (item?.completed || 0),
      failures: acc.failures + (item?.failures || 0)
    }), { completed: 0, failures: 0 });
  } finally {
    await browser.close();
  }
}

module.exports = { collectArtists };

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
