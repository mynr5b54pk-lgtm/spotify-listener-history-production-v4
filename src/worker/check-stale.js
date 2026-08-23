const fs = require("fs");
const config = require("../lib/config");
const { supabase } = require("../lib/db");

(async () => {
  const { data, error } = await supabase
    .from("worker_runs")
    .select("id,status,started_at,finished_at")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`worker health check: ${error.message}`);

  const lastStarted = data?.started_at ? Date.parse(data.started_at) : 0;
  const ageHours = lastStarted ? (Date.now() - lastStarted) / 3_600_000 : Infinity;
  const stale = !data || !Number.isFinite(ageHours) || ageHours >= config.WORKER_STALE_HOURS;

  const result = {
    stale,
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
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
