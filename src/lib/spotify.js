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

  // Only treat K/M/B as a suffix when it is a standalone unit.
  // This prevents the M in "monthly listeners" from becoming "million".
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

    if (
      lower.includes("monthly listeners") ||
      lines[i].includes("月間リスナー")
    ) {
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

async function extractArtistName(page) {
  const heading = page.locator("h1").first();
  const name = await heading.innerText().catch(() => "");
  return name.trim() || null;
}

async function extractPlaylistLinks(page) {
  return page.locator('a[href*="/playlist/"]').evaluateAll((anchors) => {
    const seen = new Set();
    const output = [];

    for (const anchor of anchors) {
      const href = anchor.href || "";
      const match = href.match(/\/playlist\/([A-Za-z0-9]+)/);
      if (!match || seen.has(match[1])) continue;

      seen.add(match[1]);
      output.push({
        spotifyId: match[1],
        spotifyUrl: `https://open.spotify.com/playlist/${match[1]}`,
        name: (anchor.textContent || "").trim() || null
      });
    }

    return output;
  });
}

async function extractArtistLinks(page) {
  for (let i = 0; i < 16; i += 1) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(350);
  }

  return page.locator('a[href*="/artist/"]').evaluateAll((anchors) => {
    const seen = new Set();
    const output = [];

    for (const anchor of anchors) {
      const href = anchor.href || "";
      const match = href.match(/\/artist\/([A-Za-z0-9]+)/);
      if (!match || seen.has(match[1])) continue;

      seen.add(match[1]);
      const image = anchor.querySelector("img");

      output.push({
        spotifyId: match[1],
        spotifyUrl: `https://open.spotify.com/artist/${match[1]}`,
        name: (anchor.textContent || "").trim() || `Spotify artist ${match[1]}`,
        imageUrl: image?.src || null
      });
    }

    return output;
  });
}

module.exports = {
  parseCompactNumber,
  extractMonthlyListeners,
  extractArtistName,
  extractPlaylistLinks,
  extractArtistLinks
};
