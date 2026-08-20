const crypto = require("crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countMatches(value, pattern) {
  return (String(value).match(pattern) || []).length;
}

function normalizeText(value) {
  if (value === null || value === undefined) return value;

  let text = String(value).normalize("NFKC").replace(/\\u0000/g, "").trim();
  if (!text) return text;

  // Repair the common case where UTF-8 bytes were decoded as Latin-1/Windows-1252.
  // Apply only when the repaired text clearly reduces mojibake markers.
  if (/[ÃÂâð]/.test(text)) {
    try {
      const repaired = Buffer.from(text, "latin1").toString("utf8");
      const before = countMatches(text, /[ÃÂâð�]/g);
      const after = countMatches(repaired, /[ÃÂâð�]/g);
      if (!repaired.includes("�") && after < before) text = repaired;
    } catch {
      // Keep the original when a safe repair is not possible.
    }
  }

  return text.replace(/\\s+/g, " ").trim();
}

function randomDelay(baseMs, jitterMs) {
  return baseMs + Math.floor(Math.random() * Math.max(1, jitterMs + 1));
}

async function withRetry(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 5000,
    label = "operation",
    onError = async () => {}
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      await onError(error, attempt);

      if (attempt >= retries) break;

      const delay =
        baseDelayMs * 2 ** (attempt - 1) +
        Math.floor(Math.random() * 1000);

      await sleep(delay);
    }
  }

  throw lastError;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );

  return results;
}

function uuid() {
  return crypto.randomUUID();
}

function deadlineFromMinutes(minutes) {
  return Date.now() + minutes * 60 * 1000;
}

function isPastDeadline(deadline) {
  return Date.now() >= deadline;
}

module.exports = {
  sleep,
  normalizeText,
  randomDelay,
  withRetry,
  mapLimit,
  uuid,
  deadlineFromMinutes,
  isPastDeadline
};
