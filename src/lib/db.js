const { createClient } = require("@supabase/supabase-js");
const config = require("./config");
const { normalizeText } = require("./utils");

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const POSTGREST_PAGE_SIZE = 1000;
const INVALID_ALIAS_NAMES = new Set(["your library"]);

function ensure(data, error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

function isUsableAlias(value) {
  const normalized = normalizeText(value);
  return Boolean(
    normalized &&
    !INVALID_ALIAS_NAMES.has(normalized.toLowerCase()) &&
    !/^spotify artist\b/i.test(normalized)
  );
}

async function saveArtistAlias(artistId, alias) {
  const normalized = normalizeText(alias);
  if (!artistId || !isUsableAlias(normalized)) return;
  const { error } = await supabase
    .from("site_artist_aliases")
    .upsert({ artist_id: artistId, alias: normalized }, { onConflict: "artist_id,alias", ignoreDuplicates: true });
  if (error && error.code !== "23505") console.warn(`save artist alias failed: ${error.message}`);
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

async function createRun(runToken, quota) {
  const { data, error } = await supabase
    .from("worker_runs")
    .insert({
      run_token: runToken,
      usage_date: quota.usageDate,
      artist_updates_reserved: quota.artistAllowed,
      playlist_scans_reserved: quota.playlistAllowed,
      discovery_queries_reserved: quota.discoveryAllowed
    })
    .select("id")
    .single();
  return ensure(data, error, "create run").id;
}

async function finishRun(runId, stats, status, quotaFinalized = false) {
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
      notes: stats.notes || null,
      quota_finalized: quotaFinalized
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
  const rows = queries.map((query, index) => ({ query, priority: 100 + index }));
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
    .update({ last_used_at: new Date().toISOString(), next_use_at: next.toISOString(), failure_count: 0, last_error: null })
    .eq("id", id);
  ensure(null, error, "mark discovery success");
}

async function markDiscoveryFailure(query, message) {
  const failures = Number(query.failure_count || 0) + 1;
  const next = new Date();
  next.setUTCHours(next.getUTCHours() + Math.min(72, 2 ** Math.min(failures, 6)));
  const { error } = await supabase
    .from("discovery_queries")
    .update({ next_use_at: next.toISOString(), failure_count: failures, last_error: message.slice(0, 1000) })
    .eq("id", query.id);
  ensure(null, error, "mark discovery failure");
}

async function upsertPlaylist(item, sourceQuery) {
  const { data, error } = await supabase
    .from("playlists")
    .upsert({
      spotify_id: item.spotifyId,
      spotify_url: item.spotifyUrl,
      name: normalizeText(item.name),
      source_query: normalizeText(sourceQuery),
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
    .order("id", { ascending: true })
    .limit(limit);
  return ensure(data, error, "get playlists") || [];
}

async function upsertArtist(item) {
  const incomingName = normalizeText(item.name);
  const incomingImage = normalizeText(item.imageUrl);
  const { data: existing, error: existingError } = await supabase
    .from("artists")
    .select("id,name,image_url,last_collected_at")
    .eq("spotify_url", item.spotifyUrl)
    .maybeSingle();
  ensure(null, existingError, "find existing artist");

  // Playlist link text is discovery metadata, not canonical artist metadata.
  // Once an artist has been successfully collected, only the artist page is
  // allowed to rename it. This prevents a later playlist scan from degrading
  // an already-correct canonical name or wiping a known image with null.
  const hasCanonicalMetadata = Boolean(existing?.last_collected_at);
  const storedName = hasCanonicalMetadata && existing?.name
    ? existing.name
    : incomingName;
  const storedImage = incomingImage || existing?.image_url || null;

  const { data, error } = await supabase
    .from("artists")
    .upsert({
      spotify_id: item.spotifyId,
      spotify_url: item.spotifyUrl,
      name: storedName,
      image_url: storedImage,
      tracking_enabled: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "spotify_url" })
    .select("id")
    .single();
  const artist = ensure(data, error, "upsert artist");

  if (existing?.name && existing.name !== incomingName) {
    await saveArtistAlias(artist.id, existing.name);
  }
  if (incomingName && storedName !== incomingName) {
    await saveArtistAlias(artist.id, incomingName);
  }
  return artist;
}

async function linkPlaylistArtist(playlistId, artistId) {
  const { error } = await supabase
    .from("playlist_artists")
    .upsert({ playlist_id: playlistId, artist_id: artistId, last_seen_at: new Date().toISOString() }, { onConflict: "playlist_id,artist_id" });
  ensure(null, error, "link playlist artist");
}

async function savePlaylistSuccess(playlist) {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + config.PLAYLIST_RESCAN_DAYS);
  const { error } = await supabase
    .from("playlists")
    .update({ scan_status: "active", last_scanned_at: new Date().toISOString(), next_scan_at: next.toISOString(), failure_count: 0, last_error: null, updated_at: new Date().toISOString() })
    .eq("id", playlist.id);
  ensure(null, error, "save playlist success");
}

async function savePlaylistFailure(playlist, message) {
  const failures = Number(playlist.failure_count || 0) + 1;
  const next = new Date();
  next.setUTCHours(next.getUTCHours() + Math.min(96, failures * 6));
  const { error } = await supabase
    .from("playlists")
    .update({ scan_status: "error", failure_count: failures, last_error: message.slice(0, 1000), next_scan_at: next.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", playlist.id);
  ensure(null, error, "save playlist failure");
}

async function fetchDueArtistsByStatuses(statuses, limit, deadline) {
  if (limit <= 0) return [];
  const artists = [];
  for (let offset = 0; offset < limit; offset += POSTGREST_PAGE_SIZE) {
    const batchSize = Math.min(POSTGREST_PAGE_SIZE, limit - offset);
    const { data, error } = await supabase
      .from("artists")
      .select("*")
      .eq("tracking_enabled", true)
      .in("discovery_status", statuses)
      .lte("next_collect_at", deadline)
      .order("next_collect_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);
    const batch = ensure(data, error, "get artists") || [];
    artists.push(...batch);
    if (batch.length < batchSize) break;
  }
  return artists;
}

async function getDueArtists(limit) {
  if (limit <= 0) return [];
  const deadline = new Date().toISOString();
  const selected = [];
  const selectedIds = new Set();

  async function append(statuses, requested) {
    const remaining = limit - selected.length;
    if (remaining <= 0 || requested <= 0) return;
    const rows = await fetchDueArtistsByStatuses(statuses, Math.min(requested, remaining), deadline);
    for (const row of rows) {
      if (selectedIds.has(row.id)) continue;
      selected.push(row);
      selectedIds.add(row.id);
    }
  }

  // A 325-minute run completes about 975 artist pages. Reserve bounded slices
  // for never-checked candidates and below-threshold rechecks, then use the
  // remaining capacity for public artists so the active cycle stays near 5–6 days.
  await append(["error", "candidate"], config.MAX_CANDIDATE_UPDATES_PER_RUN);
  await append(["below_threshold"], config.MAX_BELOW_THRESHOLD_UPDATES_PER_RUN);
  await append(["active"], limit - selected.length);

  // If there are fewer active artists due, use the remaining capacity instead
  // of leaving it idle. Filtering IDs keeps this safe when the reserve already
  // selected the oldest rows.
  for (const statuses of [["error", "candidate"], ["below_threshold"]]) {
    const remaining = limit - selected.length;
    if (remaining <= 0) break;
    const rows = await fetchDueArtistsByStatuses(statuses, remaining + selectedIds.size, deadline);
    for (const row of rows) {
      if (selected.length >= limit) break;
      if (selectedIds.has(row.id)) continue;
      selected.push(row);
      selectedIds.add(row.id);
    }
  }

  return selected;
}

async function saveDailyHistory(artistId, listeners, now) {
  const { error: insertError } = await supabase
    .from("monthly_listener_history")
    .insert({ artist_id: artistId, monthly_listeners: listeners, collected_at: now.toISOString() });

  if (!insertError) return;
  if (insertError.code !== "23505") throw new Error(`insert listener history: ${insertError.message}`);

  // A manual rerun or retry can collect an artist more than once in one UTC day.
  // Keep one point/day, but make that point the latest successful observation.
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const { error: updateError } = await supabase
    .from("monthly_listener_history")
    .update({ monthly_listeners: listeners, collected_at: now.toISOString() })
    .eq("artist_id", artistId)
    .gte("collected_at", dayStart.toISOString())
    .lt("collected_at", dayEnd.toISOString());
  ensure(null, updateError, "update daily listener history");
}

async function saveArtistSuccess(artist, listeners, canonicalName = null) {
  const now = new Date();
  const isActive = listeners >= config.MIN_MONTHLY_LISTENERS;
  const next = new Date(now);
  if (isActive) next.setUTCHours(next.getUTCHours() + config.ACTIVE_RECHECK_HOURS);
  else next.setUTCDate(next.getUTCDate() + config.BELOW_THRESHOLD_RECHECK_DAYS);

  await saveDailyHistory(artist.id, listeners, now);

  const normalizedCanonicalName = normalizeText(canonicalName);
  const shouldRename = normalizedCanonicalName && normalizedCanonicalName !== normalizeText(artist.name);
  if (shouldRename) await saveArtistAlias(artist.id, artist.name);

  const { error } = await supabase
    .from("artists")
    .update({
      ...(shouldRename ? { name: normalizedCanonicalName } : {}),
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

  // A transient scrape failure must not make a previously valid public artist
  // disappear from search/detail pages. Only never-successful candidates use
  // the error state while waiting for a retry.
  const status = ["active", "below_threshold"].includes(artist.discovery_status)
    ? artist.discovery_status
    : "error";

  const { error } = await supabase
    .from("artists")
    .update({
      tracking_enabled: true,
      discovery_status: status,
      failure_count: failures,
      last_error: message.slice(0, 1000),
      next_collect_at: next.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", artist.id);
  ensure(null, error, "save artist failure");
}

async function getPublicArtists({ query, limit, offset }) {
  const { data, error } = await supabase.rpc("public_artist_search", { p_query: query || null, p_limit: limit, p_offset: offset });
  return (ensure(data, error, "public artist search") || []).map((artist) => ({ ...artist, name: normalizeText(artist.name) }));
}

async function getArtistById(id) {
  const { data, error } = await supabase
    .from("artists")
    .select("id,spotify_id,name,spotify_url,image_url,monthly_listeners_latest,last_collected_at,discovery_status")
    .eq("id", id)
    .eq("discovery_status", "active")
    .maybeSingle();
  if (error) throw new Error(`get artist: ${error.message}`);
  if (!data) return null;
  return { ...data, name: normalizeText(data.name) };
}

async function getArtistHistory(id) {
  const history = [];
  for (let offset = 0; ; offset += POSTGREST_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("monthly_listener_history")
      .select("monthly_listeners,collected_at")
      .eq("artist_id", id)
      .order("collected_at", { ascending: true })
      .range(offset, offset + POSTGREST_PAGE_SIZE - 1);
    const batch = ensure(data, error, "get artist history") || [];
    history.push(...batch);
    if (batch.length < POSTGREST_PAGE_SIZE) break;
  }
  return history;
}

async function getOpsSummary() {
  const [artistCount, playlistCount, usage, latestRuns, errors] = await Promise.all([
    supabase.from("artists").select("id", { count: "exact", head: true }),
    supabase.from("playlists").select("id", { count: "exact", head: true }),
    supabase.from("daily_usage").select("*").order("usage_date", { ascending: false }).limit(1),
    supabase.from("worker_runs").select("*").order("started_at", { ascending: false }).limit(20),
    supabase.from("job_errors").select("*").order("created_at", { ascending: false }).limit(20)
  ]);
  for (const result of [artistCount, playlistCount, usage, latestRuns, errors]) ensure(null, result.error, "ops summary");
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
  createRun,
  finishRun,
  logJobError,
  saveArtistAlias,
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
