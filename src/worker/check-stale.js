const fs = require("fs");
const config = require("../lib/config");
const { supabase } = require("../lib/db");
const { reconcileStaleRuns } = require("../lib/lifecycle");
const { assessWorkerFreshness } = require("../lib/worker-health");

(async () => {
  const reconciled = await reconcileStaleRuns();

  const { data, error } = await supabase
    .from("worker_runs")
    .select("id,worker_name,status,started_at,finished_at,last_heartbeat_at")
    .eq("worker_name", config.WORKER_NAME)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`worker health check: ${error.message}`);

  const health = assessWorkerFreshness(data, Date.now(), {
    staleHours: config.WORKER_STALE_HOURS,
    restartDelayMinutes: config.WORKER_RESTART_DELAY_MINUTES,
    heartbeatStaleMinutes: config.WORKER_HEARTBEAT_STALE_MINUTES
  });

  const result = {
    ...health,
    reconciled,
    latestRun: data || null
  };
  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `stale=${health.stale ? "true" : "false"}\n`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
