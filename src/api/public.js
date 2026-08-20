const express = require("express");
const config = require("../lib/config");
const {
  getPublicArtists,
  getArtistById,
  getArtistHistory
} = require("../lib/db");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=60");
  next();
});

router.get("/artists", async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const requested = Number(req.query.limit || config.PUBLIC_API_PAGE_SIZE);
    const query = String(req.query.q || "").trim();

    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > config.PUBLIC_API_MAX_PAGE
    ) {
      return res.status(400).json({ error: "invalid page" });
    }

    if (!Number.isInteger(requested) || requested < 1) {
      return res.status(400).json({ error: "invalid limit" });
    }

    if (query.length > config.PUBLIC_API_MAX_QUERY_LENGTH) {
      return res.status(400).json({ error: "query too long" });
    }

    const limit = Math.min(requested, config.PUBLIC_API_MAX_PAGE_SIZE);
    const offset = (page - 1) * limit;

    const artists = await getPublicArtists({ query, limit, offset });

    res.json({
      data: artists,
      pagination: {
        page,
        limit,
        returned: artists.length
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/artists/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid artist id" });
    }

    const artist = await getArtistById(id);
    const history = await getArtistHistory(id);

    res.json({ data: { ...artist, history } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
