import "dotenv/config";
import pool from "../src/config/postgres.js";
import pgBossRetention from "../src/maintenance/pgbossRetention.js";

function maxBatchesFromArgs() {
  const arg = process.argv.find(value => value.startsWith("--max-batches="));
  if (!arg) return undefined;
  const value = Number(arg.split("=")[1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--max-batches must be a positive integer");
  }
  return value;
}

function megabytes(bytes) {
  return Number((Number(bytes || 0) / (1024 * 1024)).toFixed(2));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const maxBatches = maxBatchesFromArgs();

  console.log("Starting bounded pg-boss retention audit...");
  const before = await pgBossRetention.audit();
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    queuePolicies: before.queues,
    cleanupCandidates: before.cleanupCandidates,
    cleanupCandidateErrors: before.cleanupCandidateErrors,
    tableEstimates: before.tableEstimates,
    largestRelations: before.relations.slice(0, 20).map(row => ({
      relation: row.relation,
      megabytes: megabytes(row.bytes),
    })),
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing the candidate counts.");
    return;
  }

  const result = await pgBossRetention.runOnce({
    maxBatches: maxBatches ?? Math.max(20, pgBossRetention.maxBatchesPerRun),
  });
  console.log(JSON.stringify({ cleanup: result }, null, 2));

  const after = await pgBossRetention.audit();
  console.log(JSON.stringify({
    remainingCandidates: after.cleanupCandidates,
    cleanupCandidateErrors: after.cleanupCandidateErrors,
    tableEstimates: after.tableEstimates,
    largestRelations: after.relations.slice(0, 20).map(row => ({
      relation: row.relation,
      megabytes: megabytes(row.bytes),
    })),
  }, null, 2));

  console.log(
    "Cleanup uses short lock/statement timeouts and small batches. " +
    "Postgres may reuse freed space before Supabase's physical database-size metric shrinks."
  );
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
