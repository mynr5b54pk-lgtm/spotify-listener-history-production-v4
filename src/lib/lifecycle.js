const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function heartbeatRun(runId, runToken) {
  const { data, error } = await supabase.rpc("heartbeat_worker_run", {
    p_run_id: runId,
    p_worker_name: config.WORKER_NAME,
    p_lock_token: runToken,
    p_ttl_minutes: config.LOCK_TTL_MINUTES
  });
  if (error) throw new Error(`worker heartbeat: ${error.message}`);
  return Boolean(data);
}

async function reconcileStaleRuns() {
  const { data, error } = await supabase.rpc("reconcile_stale_worker_runs", {
    p_stale_minutes: config.WORKER_STALE_RUN_MINUTES
  });
  if (error) throw new Error(`reconcile stale worker runs: ${error.message}`);
  return Number(data || 0);
}

module.exports = { heartbeatRun, reconcileStaleRuns };
