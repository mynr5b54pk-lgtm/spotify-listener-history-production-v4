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
  isPastDeadline
};
