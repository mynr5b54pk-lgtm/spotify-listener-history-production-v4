const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const INVALID_CANONICAL_NAMES = ["your library"];

function isLikelyLocalizedCanonicalName(name) {
  const value = String(name || "").trim();
  return /[ァ-ヶー]/.test(value) && !/[A-Za-z]/.test(value) && !/[一-龠々]/.test(value);
}

async function getPriorityRepairArtists(limit) {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return [];

  const poolLimit = Math.min(Math.max(Number(limit) * 4, 400), 4000);
  const { data, error } = await supabase
    .from("artists")
    .select("*")
    .eq("tracking_enabled", true)
    .order("next_collect_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(poolLimit);

  if (error) throw new Error(`get priority repair artists: ${error.message}`);

  const invalid = [];
  const localized = [];
  for (const artist of data || []) {
    const normalized = String(artist.name || "").trim().toLowerCase();
    if (INVALID_CANONICAL_NAMES.includes(normalized)) invalid.push(artist);
    else if (isLikelyLocalizedCanonicalName(artist.name)) localized.push(artist);
  }

  return [...invalid, ...localized].slice(0, Math.min(Number(limit), 250));
}

module.exports = { getPriorityRepairArtists, isLikelyLocalizedCanonicalName };
