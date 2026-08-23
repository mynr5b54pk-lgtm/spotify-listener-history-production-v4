require("dotenv").config();
const { z } = require("zod");

const schema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  HEADLESS: z.string().default("true"),
  LOG_LEVEL: z.string().default("info"),

  MAX_ARTIST_UPDATES_PER_DAY: z.coerce.number().int().nonnegative().default(50000),
  MAX_PLAYLIST_SCANS_PER_DAY: z.coerce.number().int().nonnegative().default(800),
  MAX_DISCOVERY_QUERIES_PER_DAY: z.coerce.number().int().nonnegative().default(160),

  MAX_ARTIST_UPDATES_PER_RUN: z.coerce.number().int().nonnegative().default(2500),
  MAX_PLAYLIST_SCANS_PER_RUN: z.coerce.number().int().nonnegative().default(100),
  MAX_DISCOVERY_QUERIES_PER_RUN: z.coerce.number().int().nonnegative().default(20),

  BROWSER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(4),
  REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(2200),
  REQUEST_JITTER_MS: z.coerce.number().int().nonnegative().default(1200),
  PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  PAGE_SETTLE_MS: z.coerce.number().int().nonnegative().default(4500),
  MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(5000),
  MAX_RUNTIME_MINUTES: z.coerce.number().int().positive().default(170),
  ANOMALY_RECHECK_RATIO: z.coerce.number().min(1.05).max(10).default(1.5),
  ANOMALY_CONFIRM_TOLERANCE_PERCENT: z.coerce.number().min(0.1).max(10).default(1),
  WORKER_STALE_HOURS: z.coerce.number().min(1).max(24).default(4),

  MIN_MONTHLY_LISTENERS: z.coerce.number().int().nonnegative().default(10000),
  ACTIVE_RECHECK_HOURS: z.coerce.number().int().positive().default(24),
  BELOW_THRESHOLD_RECHECK_DAYS: z.coerce.number().int().positive().default(30),
  PLAYLIST_RESCAN_DAYS: z.coerce.number().int().positive().default(7),

  WORKER_NAME: z.string().default("spotify-production-worker-v4"),
  LOCK_TTL_MINUTES: z.coerce.number().int().positive().default(175),

  PUBLIC_API_PAGE_SIZE: z.coerce.number().int().positive().default(50),
  PUBLIC_API_MAX_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100),
  PUBLIC_API_MAX_PAGE: z.coerce.number().int().positive().default(10000),
  PUBLIC_API_MAX_QUERY_LENGTH: z.coerce.number().int().positive().default(100),
  PUBLIC_API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  PUBLIC_API_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  ADMIN_API_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  ADMIN_TOKEN: z.string().min(16)
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`環境変数が不正です:\n${details}`);
}

const raw = parsed.data;

module.exports = {
  ...raw,
  headless: raw.HEADLESS.toLowerCase() === "true",
  port: raw.PORT,
  supabaseUrl: raw.SUPABASE_URL,
  supabaseKey: raw.SUPABASE_SERVICE_ROLE_KEY
};
