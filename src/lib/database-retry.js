const { sleep } = require("./utils");

const TRANSIENT_DATABASE_ERROR = /(?:gateway timeout|fetch failed|network|timeout|timed out|econnreset|econnrefused|socket|\b50[0234]\b|\b52[024]\b)/i;

function isTransientDatabaseError(error) {
  if (!error) return false;
  const message = [error.message, error.details, error.hint, error.code, error.status]
    .filter(Boolean)
    .join(" ");
  return TRANSIENT_DATABASE_ERROR.test(message);
}

async function retryTransientOperation(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? 400));
  let lastThrown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation(attempt);
      if (!result?.error || !isTransientDatabaseError(result.error) || attempt === attempts) {
        return result;
      }
    } catch (error) {
      lastThrown = error;
      if (!isTransientDatabaseError(error) || attempt === attempts) throw error;
    }

    if (baseDelayMs > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }

  throw lastThrown || new Error("database operation failed after retries");
}

module.exports = { isTransientDatabaseError, retryTransientOperation };
