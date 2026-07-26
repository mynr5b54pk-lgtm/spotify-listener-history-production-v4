const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function ensure(data, error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function acquireLock(lockToken) {
  const { data, error } = await supabase.rpc("acquire_worker_lock", {
    p_worker_name: config.WORKER_NAME,
    p_lock_token: lockToken,
    p_ttl_minutes: config.LOCK_TTL_MINUTES
  });

  return Boolean(ensure(data, error, "acquire lock"));
}

async function releaseLock(lockToken) {
  const { error } = await supabase.rpc("release_worker_lock", {
    p_worker_name: config.WORKER_NAME,
    p_lock_token: lockToken
  });
  if (error) throw new Error(`release lock: ${error.message}`);
}

async function reserveQuota() {
  const { data, error } = await supabase.rpc("reserve_daily_quota", {
    p_artist_requested: config.MAX_ARTIST_UPDATES_PER_RUN,
    p_playlist_requested: config.MAX_PLAYLIST_SCANS_PER_RUN,
    p_discovery_requested: config.MAX_DISCOVERY_QUERIES_PER_RUN,
    p_artist_daily_max: config.MAX_ARTIST_UPDATES_PER_DAY,
    p_playlist_daily_max: config.MAX_PLAYLIST_SCANS_PER_DAY,
    p_discovery_daily_max: config.MAX_DISCOVERY_QUERIES_PER_DAY
  });

  const row = ensure(data, error, "reserve quota")?.[0] || {};

  return {
    artistAllowed: Number(row.artist_allowed || 0),
    playlistAllowed: Number(row.playlist_allowed || 0),
    discoveryAllowed: Number(row.discovery_allowed || 0)
  };
}

async function completeUsage(stats) {
  const { error } = await supabase.rpc("complete_daily_usage", {
    p_artist_completed: stats.artistUpdatesCompleted,
    p_playlist_completed: stats.playlistScansCompleted,
    p_discovery_completed: stats.discoveryQueriesCompleted
  });
  ensure(null, error, "complete usage");
}

async function createRun(runToken, quota) {
  const { data, error } = await supabase
    .from("worker_runs")
    .insert({
      run_token: runToken,
      artist_updates_reserved: quota.artistAllowed,
      playlist_scans_reserved: quota.playlistAllowed,
      discovery_queries_reserved: quota.discoveryAllowed
    })
    .select("id")
    .single();

  return ensure(data, error, "create run").id;
}

async function finishRun(runId, stats, status) {
  const { error } = await supabase
    .from("worker_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      artist_updates_completed: stats.artistUpdatesCompleted,
      playlist_scans_completed: stats.playlistScansCompleted,
      discovery_queries_completed: stats.discoveryQueriesCompleted,
      discovered_playlists: stats.discoveredPlaylists,
      discovered_artists: stats.discoveredArtists,
      failed_jobs: stats.failedJobs,
      duration_seconds: stats.durationSeconds,
      notes: stats.notes || null
    })
    .eq("id", runId);

  ensure(null, error, "finish run");
}

async function logJobError(item) {
  const { error } = await supabase.from("job_errors").insert(item);
  if (error) console.error(`job error logging failed: ${error.message}`);
}

async function seedDiscoveryQueries(queries) {
  if (!queries.length) return;
  const rows = queries.map((query, index) => ({
    query,
    priority: 100 + index
  }));
  const { error } = await supabase
    .from("discovery_queries")
    .upsert(rows, { onConflict: "query", ignoreDuplicates: true });
  ensure(null, error, "seed discovery queries");
}

async function getDueDiscoveryQueries(limit) {
  if (limit <= 0) return [];
  const { data, error } = await supabase
    .from("discovery_queries")
    .select("*")
    .eq("enabled", true)
    .lte("next_use_at", new Date().toISOString())
    .order("priority", { ascending: true })
    .order("next_use_at", { ascending: true })
    .limit(limit);
  return ensure(data, error, "get discovery queries") || [];
}

async function markDiscoverySuccess(id) {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 7);
  const { error } = await supabase
    .from("discovery_queries")
    .update({
      last_used_at: new Date().toISOString(),
      next_use_at: next.toISOString(),
      failure_count: 0,
      last_error: null
    })
    .eq("id", id);
  ensure(null, error, "mark discovery success");
}

async function markDiscoveryFailure(query, message) {
  const failures = Number(query.failure_count || 0) + 1;
  const next = new Date();
  next.setUTCHours(next.getUTCHours() + Math.min(72, 2 ** Math.min(failures, 6)));

  const { error } = await supabase
    .from("discovery_queries")
    .update({
      next_use_at: next.toISOString(),
      failure_count: failures,
      last_error: message.slice(0, 1000)
    })
    .eq("id", query.id);
  ensure(null, error, "mark discovery failure");
}

async function upsertPlaylist(item, sourceQuery) {
  const { data, error } = await supabase
    .from("playlists")
    .upsert({
      spotify_id: item.spotifyId,
      spotify_url: item.spotifyUrl,
      name: item.name,
      source_query: sourceQuery,
      updated_at: new Date().toISOString()
    }, { onConflict: "spotify_id" })
    .select("id")
    .single();

  return ensure(data, error, "upsert playlist");
}

async function getDuePlaylists(limit) {
  if (limit <= 0) return [];
  const { data, error } = await supabase
    .from("playlists")
    .select("*")
    .in("scan_status", ["pending", "active", "error"])
    .lte("next_scan_at", new Date().toISOString())
    .order("next_scan_at", { ascending: true })
    .limit(limit);
  return ensure(data, error, "get playlists") || [];
}

async function upsertArtist(item) {
  const { data, error } = await supabase
    .from("artists")
    .upsert({
      spotify_id: item.spotifyId,
      spotify_url: item.spotifyUrl,
      name: item.name,
      image_url: item.imageUrl,
      tracking_enabled: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "spotify_url" })
    .select("id")
    .single();

  return ensure(data, error, "upsert artist");
}

async function linkPlaylistArtist(playlistId, artistId) {
  const { error } = await supabase
    .from("playlist_artists")
    .upsert({
      playlist_id: playlistId,
      artist_id: artistId,
      last_seen_at: new Date().toISOString()
    }, {
      onConflict: "playlist_id,artist_id"
    });
  ensure(null, error, "link playlist artist");
}

async function savePlaylistSuccess(playlist) {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + config.PLAYLIST_RESCAN_DAYS);

  const { error } = await supabase
    .from("playlists")
    .update({
      scan_status: "active",
      last_scanned_at: new Date().toISOString(),
      next_scan_at: next.toISOString(),
      failure_count: 0,
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", playlist.id);
  ensure(null, error, "save playlist success");
}

async function savePlaylistFailure(playlist, message) {
  const failures = Number(playlist.failure_count || 0) + 1;
  const next = new Date();
  next.setUTCHours(next.getUTCHours() + Math.min(96, failures * 6));

  const { error } = await supabase
    .from("playlists")
    .update({
      scan_status: failures >= config.MAX_FAILURES_BEFORE_PAUSE ? "paused" : "error",
      failure_count: failures,
      last_error: message.slice(0, 1000),
      next_scan_at: next.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", playlist.id);
  ensure(null, error, "save playlist failure");
}

async function getDueArtists(limit) {
  if (limit <= 0) return [];
  const { data, error } = await supabase
    .from("artists")
    .select("*")
    .eq("tracking_enabled", true)
    .lte("next_collect_at", new Date().toISOString())
    .order("next_collect_at", { ascending: true })
    .limit(limit);
  return ensure(data, error, "get artists") || [];
}

async function saveArtistSuccess(artist, listeners) {
  const now = new Date();
  const isActive = listeners >= config.MIN_MONTHLY_LISTENERS;
  const next = new Date(now);

  if (isActive) {
    next.setUTCHours(next.getUTCHours() + config.ACTIVE_RECHECK_HOURS);
  } else {
    next.setUTCDate(next.getUTCDate() + config.BELOW_THRESHOLD_RECHECK_DAYS);
  }

  const { error: historyError } = await supabase
    .from("monthly_listener_history")
    .insert({
      artist_id: artist.id,
      monthly_listeners: listeners
    });

  if (historyError && historyError.code !== "23505") {
    throw new Error(`insert listener history: ${historyError.message}`);
  }

  const { error } = await supabase
    .from("artists")
    .update({
      monthly_listeners_latest: listeners,
      last_collected_at: now.toISOString(),
      next_collect_at: next.toISOString(),
      discovery_status: isActive ? "active" : "below_threshold",
      failure_count: 0,
      last_error: null,
      updated_at: now.toISOString()
    })
    .eq("id", artist.id);

  ensure(null, error, "save artist success");
}

async function saveArtistFailure(artist, message) {
  const failures = Number(artist.failure_count || 0) + 1;
  const next = new Date();
  next.setUTCHours(next.getUTCHours() + Math.min(72, 2 ** Math.min(failures, 6)));

  const paused = failures >= config.MAX_FAILURES_BEFORE_PAUSE;

  const { error } = await supabase
    .from("artists")
    .update({
      tracking_enabled: !paused,
      discovery_status: paused ? "paused" : "error",
      failure_count: failures,
      last_error: message.slice(0, 1000),
      next_collect_at: next.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", artist.id);

  ensure(null, error, "save artist failure");
}

async function getPublicArtists({ query, limit, offset }) {
  const { data, error } = await supabase.rpc("public_artist_search", {
    p_query: query || null,
    p_limit: limit,
    p_offset: offset
  });
  return ensure(data, error, "public artist search") || [];
}

async function getArtistById(id) {
  const { data, error } = await supabase
    .from("artists")
    .select("id,spotify_id,name,spotify_url,image_url,monthly_listeners_latest,last_collected_at,discovery_status")
    .eq("id", id)
    .single();
  return ensure(data, error, "get artist");
}

async function getArtistHistory(id, limit = 365) {
  const { data, error } = await supabase
    .from("monthly_listener_history")
    .select("monthly_listeners,collected_at")
    .eq("artist_id", id)
    .order("collected_at", { ascending: true })
    .limit(limit);
  return ensure(data, error, "get artist history") || [];
}

async function getOpsSummary() {
  const [artistCount, playlistCount, usage, latestRuns, errors] = await Promise.all([
    supabase.from("artists").select("id", { count: "exact", head: true }),
    supabase.from("playlists").select("id", { count: "exact", head: true }),
    supabase.from("daily_usage").select("*").order("usage_date", { ascending: false }).limit(1),
    supabase.from("worker_runs").select("*").order("started_at", { ascending: false }).limit(20),
    supabase.from("job_errors").select("*").order("created_at", { ascending: false }).limit(20)
  ]);

  for (const result of [artistCount, playlistCount, usage, latestRuns, errors]) {
    ensure(null, result.error, "ops summary");
  }

  return {
    artistCount: artistCount.count || 0,
    playlistCount: playlistCount.count || 0,
    usage: usage.data?.[0] || null,
    latestRuns: latestRuns.data || [],
    errors: errors.data || []
  };
}

module.exports = {
  supabase,
  acquireLock,
  releaseLock,
  reserveQuota,
  completeUsage,
  createRun,
  finishRun,
  logJobError,
  seedDiscoveryQueries,
  getDueDiscoveryQueries,
  markDiscoverySuccess,
  markDiscoveryFailure,
  upsertPlaylist,
  getDuePlaylists,
  upsertArtist,
  linkPlaylistArtist,
  savePlaylistSuccess,
  savePlaylistFailure,
  getDueArtists,
  saveArtistSuccess,
  saveArtistFailure,
  getPublicArtists,
  getArtistById,
  getArtistHistory,
  getOpsSummary
};
