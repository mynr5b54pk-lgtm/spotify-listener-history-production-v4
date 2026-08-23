const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const INVALID_CANONICAL_NAMES = ["your library"];

async function getPriorityRepairArtists(limit) {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return [];

  const { data, error } = await supabase
    .from("artists")
    .select("*")
    .eq("tracking_enabled", true)
    .in("name", ["Your Library", "your library", "YOUR LIBRARY"])
    .order("next_collect_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.min(Number(limit), 100));

  if (error) throw new Error(`get priority repair artists: ${error.message}`);

  return (data || []).filter((artist) =>
    INVALID_CANONICAL_NAMES.includes(String(artist.name || "").trim().toLowerCase())
  );
}

module.exports = { getPriorityRepairArtists };
