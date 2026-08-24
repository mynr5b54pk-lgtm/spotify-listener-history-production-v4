const fs = require("fs");
const config = require("../lib/config");
const { supabase } = require("../lib/db");
const { reconcileStaleRuns } = require("../lib/lifecycle");

(async () => {
  const reconciled = await reconcileStaleRuns();

  const { data, error } = await supabase
    .from("worker_runs")
    .select("id,status,started_at,finished_at,last_heartbeat_at")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`worker health check: ${error.message}`);

  const now = Date.now();
  const lastStarted = data?.started_at ? Date.parse(data.started_at) : 0;
  const ageHours = lastStarted ? (now - lastStarted) / 3_600_000 : Infinity;
  const heartbeatAt = data?.last_heartbeat_at ? Date.parse(data.last_heartbeat_at) : lastStarted;
  const heartbeatAgeMinutes = heartbeatAt ? (now - heartbeatAt) / 60_000 : Infinity;

  const staleRunning = data?.status === "running" &&
    (!Number.isFinite(heartbeatAgeMinutes) || heartbeatAgeMinutes >= config.WORKER_HEARTBEAT_STALE_MINUTES);
  const staleBySchedule = !data || !Number.isFinite(ageHours) || ageHours >= config.WORKER_STALE_HOURS;
  const stale = staleRunning || staleBySchedule;

  const result = {
    stale,
    staleRunning,
    reconciled,
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
    heartbeatAgeMinutes: Number.isFinite(heartbeatAgeMinutes) ? Number(heartbeatAgeMinutes.toFixed(1)) : null,
    latestRun: data || null
  };
  console.log(JSON.stringify(result));

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `stale=${stale ? "true" : "false"}\n`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
