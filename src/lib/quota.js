const config = require("./config");
const { supabase } = require("./db");

function ensure(data, error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function reserveRunQuota() {
  const { data, error } = await supabase.rpc("reserve_run_quota", {
    p_artist_requested: config.MAX_ARTIST_UPDATES_PER_RUN,
    p_playlist_requested: config.MAX_PLAYLIST_SCANS_PER_RUN,
    p_discovery_requested: config.MAX_DISCOVERY_QUERIES_PER_RUN,
    p_artist_daily_max: config.MAX_ARTIST_UPDATES_PER_DAY,
    p_playlist_daily_max: config.MAX_PLAYLIST_SCANS_PER_DAY,
    p_discovery_daily_max: config.MAX_DISCOVERY_QUERIES_PER_DAY
  });

  const rows = ensure(data, error, "reserve run quota") || [];
  const row = rows[0];
  if (!row?.usage_date) {
    throw new Error("reserve run quota: missing reservation row");
  }

  return {
    usageDate: row.usage_date,
    artistAllowed: Number(row.artist_allowed || 0),
    playlistAllowed: Number(row.playlist_allowed || 0),
    discoveryAllowed: Number(row.discovery_allowed || 0)
  };
}

async function finalizeRunQuota(quota, usage) {
  const { error } = await supabase.rpc("finalize_run_quota", {
    p_usage_date: quota.usageDate,
    p_artist_reserved: quota.artistAllowed,
    p_playlist_reserved: quota.playlistAllowed,
    p_discovery_reserved: quota.discoveryAllowed,
    p_artist_attempted: usage.artistAttempted,
    p_playlist_attempted: usage.playlistAttempted,
    p_discovery_attempted: usage.discoveryAttempted,
    p_artist_completed: usage.artistCompleted,
    p_playlist_completed: usage.playlistCompleted,
    p_discovery_completed: usage.discoveryCompleted
  });
  ensure(null, error, "finalize run quota");
}

module.exports = { reserveRunQuota, finalizeRunQuota };
