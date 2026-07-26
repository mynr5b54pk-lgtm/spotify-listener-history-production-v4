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

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(pinoHttp({ logger }));

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-listener-history-v4",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/v1", publicApi);
app.use("/api/admin", adminApi);
app.use(express.static(path.join(__dirname, "dashboard/public")));

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use((error, req, res, next) => {
  req.log?.error({ err: error }, "request failed");
  res.status(500).json({
    error: "internal server error"
  });
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "server started");
});
