function splitPlaylistLimit(limit, backfillPercent) {
  const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  const safePercent = Math.min(100, Math.max(0, Number(backfillPercent) || 0));
  const backfill = Math.min(safeLimit, Math.round(safeLimit * safePercent / 100));
  return { productive: safeLimit - backfill, backfill };
}

module.exports = { splitPlaylistLimit };
