const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  getDuePlaylists,
  upsertArtist,
  linkPlaylistArtist,
  savePlaylistSuccess,
  savePlaylistFailure,
  logJobError
} = require("../lib/db");
const { extractArtistLinks } = require("../lib/spotify");
const { launchBrowser, newPage } = require("./browser");
const {
  mapLimit,
  withRetry,
  sleep,
  randomDelay,
  isPastDeadline
} = require("../lib/utils");

async function scanOne(browser, playlist, deadline, runToken) {
  if (isPastDeadline(deadline)) return { skipped: true };

  const { context, page } = await newPage(browser);

  try {
    const artists = await withRetry(async () => {
      await page.goto(playlist.spotify_url, {
        waitUntil: "domcontentloaded",
        timeout: config.PAGE_TIMEOUT_MS
      });
      await page.waitForTimeout(config.PAGE_SETTLE_MS);
      return extractArtistLinks(page);
    }, {
      retries: config.MAX_RETRIES,
      baseDelayMs: config.RETRY_BASE_DELAY_MS,
      label: `playlist:${playlist.spotify_id}`
    });

    for (const item of artists) {
      const artist = await upsertArtist(item);
      await linkPlaylistArtist(playlist.id, artist.id);
    }

    await savePlaylistSuccess(playlist);
    logger.info({ playlist: playlist.spotify_id, artists: artists.length }, "playlist scan complete");
    return { completed: 1, discoveredArtists: artists.length, failures: 0 };
  } catch (error) {
    await savePlaylistFailure(playlist, error.message);
    await logJobError({
      run_token: runToken,
      job_type: "playlist",
      entity_id: playlist.id,
      entity_key: playlist.spotify_id,
      error_message: error.message
    });
    logger.error({ err: error, playlist: playlist.spotify_id }, "playlist scan failed");
    return { completed: 0, discoveredArtists: 0, failures: 1 };
  } finally {
    await context.close();
    await sleep(randomDelay(config.REQUEST_DELAY_MS, config.REQUEST_JITTER_MS));
  }
}

async function scanPlaylists(limit, deadline, runToken) {
  const playlists = await getDuePlaylists(limit);
  if (!playlists.length) {
    return { completed: 0, discoveredArtists: 0, failures: 0 };
  }

  const browser = await launchBrowser();

  try {
    const results = await mapLimit(
      playlists,
      config.BROWSER_CONCURRENCY,
      (playlist) => scanOne(browser, playlist, deadline, runToken)
    );

    return results.reduce((acc, item) => ({
      completed: acc.completed + (item?.completed || 0),
      discoveredArtists: acc.discoveredArtists + (item?.discoveredArtists || 0),
      failures: acc.failures + (item?.failures || 0)
    }), { completed: 0, discoveredArtists: 0, failures: 0 });
  } finally {
    await browser.close();
  }
}

module.exports = { scanPlaylists };

if (require.main === module) {
  const { deadlineFromMinutes, uuid } = require("../lib/utils");
  scanPlaylists(
    config.MAX_PLAYLIST_SCANS_PER_RUN,
    deadlineFromMinutes(config.MAX_RUNTIME_MINUTES),
    uuid()
  ).then(console.log).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
