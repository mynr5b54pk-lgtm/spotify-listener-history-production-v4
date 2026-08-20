const { chromium } = require("playwright");
const config = require("../lib/config");

async function launchBrowser() {
  return chromium.launch({
    headless: config.headless,
    args: ["--disable-dev-shm-usage"]
  });
}

async function newPage(browser, locale = "en-US") {
  const context = await browser.newContext({
    locale,
    extraHTTPHeaders: { "Accept-Language": `${locale},en;q=0.9` },
    viewport: { width: 1440, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(config.PAGE_TIMEOUT_MS);

  await page.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (["font", "media"].includes(type)) {
      await route.abort();
    } else {
      await route.continue();
    }
  });

  return { context, page };
}

module.exports = { launchBrowser, newPage };
