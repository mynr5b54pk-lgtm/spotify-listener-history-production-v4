function shouldRetainArtist(listeners, minimum = 10_000) {
  const value = Number(listeners);
  return Number.isFinite(value) && value >= minimum;
}

module.exports = { shouldRetainArtist };
