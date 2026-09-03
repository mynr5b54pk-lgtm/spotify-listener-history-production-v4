const fs = require("fs");
const config = require("../lib/config");
const logger = require("../lib/logger");
const {
  seedDiscoveryQueries,
  getDueDiscoveryQueries,
  markDiscoverySuccess,
  markDiscoveryFailure,
  upsertPlaylist,
  logJobError
} = require("../lib/db");
const { extractPlaylistLinks } = require("../lib/spotify");
const { launchBrowser, newPage } = require("./browser");
const {
  withRetry,
  sleep,
  randomDelay,
  isPastDeadline
} = require("../lib/utils");

function loadSeedQueries() {
  return fs
    .readFileSync("discovery-keywords.txt", "utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function assertPlaylistSearchPage(page) {
  let url;
  try {
    url = new URL(page.url());
  } catch {
    throw new Error(`unexpected discovery page: ${page.url()}`);
  }

  if (
    url.hostname !== "open.spotify.com" ||
    !url.pathname.startsWith("/search/") ||
    !url.pathname.endsWith("/playlists")
  ) {
    throw new Error(`unexpected discovery page: ${page.url()}`);
  }
}

async function discoverPlaylists(limit, deadline, runToken, onProgress) {
  await seedDiscoveryQueries(loadSeedQueries());

  const queries = await getDueDiscoveryQueries(limit);
  if (!queries.length) {
    return { completed: 0, discoveredPlaylists: 0, failures: 0 };
  }

  const browser = await launchBrowser();
  let completed = 0;
  let discoveredPlaylists = 0;
  let failures = 0;

  try {
    const { context, page } = await newPage(browser);

    for (const query of queries) {
      if (isPastDeadline(deadline)) break;

      try {
        const playlists = await withRetry(async () => {
          const url = `https://open.spotify.com/search/${encodeURIComponent(query.query)}/playlists`;
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: config.PAGE_TIMEOUT_MS
          });
          await page.waitForTimeout(config.PAGE_SETTLE_MS);
          assertPlaylistSearchPage(page);
          return extractPlaylistLinks(page);
        }, {
          retries: config.MAX_RETRIES,
          baseDelayMs: config.RETRY_BASE_DELAY_MS,
          label: `discover:${query.query}`
        });

        for (const playlist of playlists) {
          await upsertPlaylist(playlist, query.query);
          discoveredPlaylists += 1;
        }

        await markDiscoverySuccess(query.id);
        completed += 1;
        logger.info({ query: query.query, count: playlists.length }, "discovery complete");
      } catch (error) {
        failures += 1;
        await markDiscoveryFailure(query, error.message);
        await logJobError({
          run_token: runToken,
          job_type: "discovery",
          entity_id: query.id,
          entity_key: query.query,
          error_message: error.message
        });
        logger.error({ err: error, query: query.query }, "discovery failed");
      }

      await sleep(randomDelay(config.REQUEST_DELAY_MS, config.REQUEST_JITTER_MS));
      onProgress?.({ completed, discoveredPlaylists, failures });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return { completed, discoveredPlaylists, failures };
}

module.exports = { discoverPlaylists };

if (require.main === module) {
  const { deadlineFromMinutes, uuid } = require("../lib/utils");
  discoverPlaylists(
    config.MAX_DISCOVERY_QUERIES_PER_RUN,
    deadlineFromMinutes(config.MAX_RUNTIME_MINUTES),
    uuid()
  ).then(console.log).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
