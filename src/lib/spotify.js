function cleanArtistName(raw) {
  if (!raw) return null;

  const name = String(raw)
    .replace(/\s*[|·-]\s*Spotify\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    !name ||
    name.length > 200 ||
    name.toLowerCase() === "your library" ||
    /^spotify artist\b/i.test(name) ||
    /monthly listeners|月間リスナー/i.test(name)
  ) {
    return null;
  }

  return name;
}

async function extractArtistName(page) {
  const metadata = await page
    .locator('meta[property="og:title"]')
    .getAttribute("content")
    .catch(() => null);
  const metadataName = cleanArtistName(metadata);
  if (metadataName) return metadataName;

  const heading = await page.locator("main h1").first().textContent().catch(() => null);
  return cleanArtistName(heading);
}

function parseCompactNumber(raw) {
  if (!raw) return null;

  const normalized = String(raw)
    .replace(/\u00a0/g, " ")
    .trim()
    .toUpperCase();

  const numberMatch = normalized.match(/[\d]+(?:[.,][\d]+)*/);
  if (!numberMatch) return null;

  const value = Number(numberMatch[0].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;

  const remainder = normalized.slice(numberMatch.index + numberMatch[0].length);
  const suffix = remainder.match(/^\s*([KMB])(?=$|[\s),])/);

  const multiplier = suffix?.[1] === "K"
    ? 1_000
    : suffix?.[1] === "M"
      ? 1_000_000
      : suffix?.[1] === "B"
        ? 1_000_000_000
        : 1;

  return Math.round(value * multiplier);
}

function extractMonthlyListeners(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    if (lower.includes("monthly listeners") || lines[i].includes("月間リスナー")) {
      const sameLine = parseCompactNumber(lines[i]);
      if (sameLine !== null) return sameLine;
      const previous = parseCompactNumber(lines[i - 1]);
      if (previous !== null) return previous;
      const next = parseCompactNumber(lines[i + 1]);
      if (next !== null) return next;
    }
  }
  return null;
}

async function extractMonthlyListenersFromPage(page) {
  const candidates = [];

  const bodyText = await page.locator("body").innerText().catch(() => null);
  if (bodyText) candidates.push(bodyText);

  for (const selector of [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]'
  ]) {
    const value = await page.locator(selector).getAttribute("content").catch(() => null);
    if (value) candidates.push(value);
  }

  const labelled = await page.locator(
    '[aria-label*="monthly listener" i], [title*="monthly listener" i]'
  ).evaluateAll((nodes) => nodes.flatMap((node) => [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.textContent
  ]).filter(Boolean)).catch(() => []);
  candidates.push(...labelled);

  for (const candidate of candidates) {
    const value = extractMonthlyListeners(candidate);
    if (value !== null) return value;
  }
  return null;
}

async function collectAnchorSnapshots(page, selector, options = {}) {
  const { maxRounds = 60, stableRounds = 4, wheelY = 1800, waitMs = 350 } = options;
  const snapshots = new Map();
  let unchangedRounds = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const visible = await page.locator(selector).evaluateAll((anchors) => anchors.map((anchor) => ({
      href: anchor.href || "",
      text: (anchor.textContent || "").trim(),
      imageUrl: anchor.querySelector("img")?.src || null
    })));
    const before = snapshots.size;
    for (const item of visible) if (item.href) snapshots.set(item.href, item);
    if (snapshots.size === before) unchangedRounds += 1;
    else unchangedRounds = 0;
    if (unchangedRounds >= stableRounds) break;
    await page.mouse.wheel(0, wheelY);
    await page.waitForTimeout(waitMs);
  }
  return [...snapshots.values()];
}

async function extractPlaylistLinks(page) {
  const anchors = await collectAnchorSnapshots(page, 'a[href*="/playlist/"]', { maxRounds: 30, stableRounds: 3 });
  const seen = new Set();
  const output = [];
  for (const anchor of anchors) {
    const match = anchor.href.match(/\/playlist\/([A-Za-z0-9]+)/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    output.push({ spotifyId: match[1], spotifyUrl: `https://open.spotify.com/playlist/${match[1]}`, name: anchor.text || null });
  }
  return output;
}

async function extractArtistLinks(page) {
  const anchors = await collectAnchorSnapshots(page, 'a[href*="/artist/"]', { maxRounds: 80, stableRounds: 5 });
  const seen = new Set();
  const output = [];
  for (const anchor of anchors) {
    const match = anchor.href.match(/\/artist\/([A-Za-z0-9]+)/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    output.push({
      spotifyId: match[1],
      spotifyUrl: `https://open.spotify.com/artist/${match[1]}`,
      name: anchor.text || `Spotify artist ${match[1]}`,
      imageUrl: anchor.imageUrl
    });
  }
  return output;
}

module.exports = {
  cleanArtistName,
  extractArtistName,
  parseCompactNumber,
  extractMonthlyListeners,
  extractMonthlyListenersFromPage,
  extractPlaylistLinks,
  extractArtistLinks
};
