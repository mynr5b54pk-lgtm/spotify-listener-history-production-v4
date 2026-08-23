const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const config = require("./lib/config");
const logger = require("./lib/logger");
const publicApi = require("./api/public");
const adminApi = require("./api/admin");

const app = express();
app.set("trust proxy", config.TRUST_PROXY_HOPS);

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const allowedOrigins = new Set([
  config.APP_BASE_URL,
  ...config.CORS_ALLOWED_ORIGINS
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
]
  .map(normalizeOrigin)
  .filter(Boolean));

function createRateLimiter({ windowMs, maxRequests }) {
  const clients = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of clients) {
      if (value.resetAt <= now) clients.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let state = clients.get(key);

    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      clients.set(key, state);
    }

    state.count += 1;
    const remaining = Math.max(0, maxRequests - state.count);

    res.set({
      "RateLimit-Limit": String(maxRequests),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(Math.ceil(state.resetAt / 1000))
    });

    if (state.count > maxRequests) {
      res.set("Retry-After", String(Math.ceil((state.resetAt - now) / 1000)));
      return res.status(429).json({ error: "too many requests" });
    }

    next();
  };
}

const apiRateLimiter = createRateLimiter({
  windowMs: config.PUBLIC_API_RATE_LIMIT_WINDOW_MS,
  maxRequests: config.PUBLIC_API_RATE_LIMIT_MAX_REQUESTS
});
const adminRateLimiter = createRateLimiter({
  windowMs: config.PUBLIC_API_RATE_LIMIT_WINDOW_MS,
  maxRequests: config.ADMIN_API_RATE_LIMIT_MAX_REQUESTS
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(normalizeOrigin(origin))) return callback(null, true);
    return callback(null, false);
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(pinoHttp({ logger }));

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-listener-history-v4",
    timestamp: new Date().toISOString()
  });
});

app.use("/api", apiRateLimiter);
app.use("/api/v1", publicApi);
app.use("/api/admin", adminRateLimiter, adminApi);
app.use(express.static(path.join(__dirname, "dashboard/public")));

app.use((req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(404).json({ error: "not found" });
});

app.use((error, req, res, next) => {
  req.log?.error({ err: error }, "request failed");
  res.set("Cache-Control", "no-store");
  res.status(500).json({
    error: "internal server error"
  });
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "server started");
});
