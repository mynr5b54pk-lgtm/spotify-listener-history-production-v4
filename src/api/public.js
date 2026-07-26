const express = require("express");
const config = require("../lib/config");
const {
  getPublicArtists,
  getArtistById,
  getArtistHistory
} = require("../lib/db");

const router = express.Router();

router.get("/artists", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const requested = Number(req.query.limit || config.PUBLIC_API_PAGE_SIZE);
    const limit = Math.min(
      Math.max(1, requested),
      config.PUBLIC_API_MAX_PAGE_SIZE
    );
    const query = String(req.query.q || "").trim();
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
