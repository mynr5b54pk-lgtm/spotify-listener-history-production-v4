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
app.use((req, res, next) => {
  res.charset = "utf-8";
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(pinoHttp({ logger }));

// 日本語がホスティング環境やブラウザの推測で文字化けしないよう、
// テキスト系レスポンスの文字コードを明示する。
app.use((req, res, next) => {
  const originalType = res.type.bind(res);
  res.type = (value) => {
    originalType(value);
    const contentType = res.getHeader("Content-Type");
    if (typeof contentType === "string" && /^(text\/|application\/(javascript|json))/.test(contentType)) {
      res.setHeader("Content-Type", contentType.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8");
    }
    return res;
  };
  next();
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-listener-history-v4",
    timestamp: new Date().toISOString()
  });
});

app.use("/api/v1", publicApi);
app.use("/api/admin", adminApi);
app.use(express.static(path.join(__dirname, "dashboard/public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    } else if (filePath.endsWith(".js")) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    } else if (filePath.endsWith(".css")) {
      res.setHeader("Content-Type", "text/css; charset=utf-8");
    }
  }
}));

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
