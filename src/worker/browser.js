const { chromium } = require("playwright");
const config = require("../lib/config");

const contextOptions = {
  locale: "en-US",
  extraHTTPHeaders: {
    "Accept-Language": "en-US,en;q=0.9"
  },
  viewport: { width: 1440, height: 1200 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};

async function installResourceBlocking(target) {
  await target.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) {
      await route.abort();
    } else {
      await route.continue();
    }
  });
}

async function launchBrowser() {
  return chromium.launch({
    headless: config.headless,
    args: ["--disable-dev-shm-usage"]
  });
}

async function createSharedContext(browser) {
  const context = await browser.newContext(contextOptions);
  await installResourceBlocking(context);
  return context;
}

async function newPageInContext(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(config.PAGE_TIMEOUT_MS);
  return page;
}

async function newPage(browser) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(config.PAGE_TIMEOUT_MS);
  await installResourceBlocking(page);
  return { context, page };
}

module.exports = {
  launchBrowser,
  newPage,
  createSharedContext,
  newPageInContext
};
