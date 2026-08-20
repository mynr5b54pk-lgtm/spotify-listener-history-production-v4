const crypto = require("crypto");
const express = require("express");
const config = require("../lib/config");
const { getOpsSummary } = require("../lib/db");

const router = express.Router();

function isValidAdminToken(token) {
  if (!token) return false;
  const supplied = Buffer.from(token);
  const expected = Buffer.from(config.ADMIN_TOKEN);
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}

router.use((req, res, next) => {
  if (!isValidAdminToken(req.get("x-admin-token"))) {
    res.set("Cache-Control", "no-store");
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

router.get("/summary", async (req, res, next) => {
  try {
    res.json({ data: await getOpsSummary() });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
