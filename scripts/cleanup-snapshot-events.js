import "dotenv/config";
import mongoose from "mongoose";
import Event from "../src/events/event.model.js";

const SNAPSHOT_EVENT = "ACG_TRADER_ACCOUNT_SNAPSHOT";
const BATCH_SIZE = 5000;

function retentionHours() {
  const arg = process.argv.find(value => value.startsWith("--retention-hours="));
  const raw = arg ? arg.split("=")[1] : process.env.SNAPSHOT_EVENT_RETENTION_HOURS || "24";
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("retention hours must be >= 0");
  return value;
}

async function deleteInBatches(filter) {
  let deleted = 0;
  while (true) {
    const rows = await Event.find(filter).select("_id").sort({ _id: 1 }).limit(BATCH_SIZE).lean();
    if (!rows.length) break;
    const ids = rows.map(row => row._id);
    const result = await Event.deleteMany({ _id: { $in: ids } });
    deleted += result.deletedCount || 0;
    process.stdout.write(`Deleted ${deleted} historical snapshot events\r`);
  }
  if (deleted) process.stdout.write("\n");
  return deleted;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const hours = retentionHours();
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const filter = {
      eventType: SNAPSHOT_EVENT,
      occurredAt: { $lt: cutoff },
    };

    const totalSnapshots = await Event.countDocuments({ eventType: SNAPSHOT_EVENT });
    const removableSnapshots = await Event.countDocuments(filter);
    const durableBusinessEvents = await Event.countDocuments({ eventType: { $ne: SNAPSHOT_EVENT } });

    console.log(JSON.stringify({
      mode: apply ? "APPLY" : "DRY_RUN",
      cutoff: cutoff.toISOString(),
      retentionHours: hours,
      totalSnapshots,
      removableSnapshots,
      durableBusinessEvents,
    }, null, 2));

    if (!apply) {
      console.log("Dry run only. Re-run with --apply after reviewing the counts.");
      return;
    }

    const deleted = await deleteInBatches(filter);
    console.log(JSON.stringify({ deleted, retainedRecentSnapshots: totalSnapshots - deleted }, null, 2));
    console.log("Stream lastVersion values are intentionally preserved; only obsolete snapshot documents are removed.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
