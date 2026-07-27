const express = require("express");
const config = require("../lib/config");
const { getOpsSummary } = require("../lib/db");

const router = express.Router();

router.use((req, res, next) => {
  const token = req.get("x-admin-token");
  if (!token || token !== config.ADMIN_TOKEN) {
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
