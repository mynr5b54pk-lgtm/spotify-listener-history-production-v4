function splitPlaylistLimit(limit, backfillPercent) {
  const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  const safePercent = Math.min(100, Math.max(0, Number(backfillPercent) || 0));
  const backfill = Math.min(safeLimit, Math.round(safeLimit * safePercent / 100));
  return { productive: safeLimit - backfill, backfill };
}

function interleavePlaylistLanes(productive, backfill) {
  const productiveItems = Array.from(productive || []);
  const backfillItems = Array.from(backfill || []);
  const total = productiveItems.length + backfillItems.length;
  const selected = [];
  let productiveIndex = 0;
  let backfillIndex = 0;

  // Keep the target mix in every prefix. A run that stops early therefore
  // still advances both productive rescans and never-scanned backfill.
  for (let index = 0; index < total; index += 1) {
    const desiredBackfill = Math.round(((index + 1) * backfillItems.length) / total);
    if (backfillIndex < desiredBackfill && backfillIndex < backfillItems.length) {
      selected.push(backfillItems[backfillIndex]);
      backfillIndex += 1;
    } else if (productiveIndex < productiveItems.length) {
      selected.push(productiveItems[productiveIndex]);
      productiveIndex += 1;
    } else {
      selected.push(backfillItems[backfillIndex]);
      backfillIndex += 1;
    }
  }

  return selected;
}

module.exports = { splitPlaylistLimit, interleavePlaylistLanes };
