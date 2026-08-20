const crypto = require("crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function encodeWindows1252(text) {
  const reverse = new Map([
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
    [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
    [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
    [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
    [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
    [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
  ]);

  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code <= 0xff) bytes.push(code);
    else if (reverse.has(code)) bytes.push(reverse.get(code));
    else return null;
  }
  return Buffer.from(bytes);
}

function normalizeText(value) {
  if (value === null || value === undefined) return value;

  const clean = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  const suspicious = /(?:Ã.|Â.|â.|ð.|ã.|ï¿½|�)/g;
  const score = (text) => (text.match(suspicious) || []).length;
  if (score(clean) === 0) return clean;

  try {
    const bytes = encodeWindows1252(clean);
    if (bytes) {
      const repaired = bytes
        .toString("utf8")
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim();
      if (!repaired.includes("�") && score(repaired) < score(clean)) {
        return repaired;
      }
    }
  } catch {
    // Keep the original when a safe repair is not possible.
  }
  return clean;
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
  randomDelay,
  withRetry,
  mapLimit,
  uuid,
  deadlineFromMinutes,
  isPastDeadline,
  normalizeText
};
