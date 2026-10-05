import mongoose from "mongoose";

// Stable traversal ensures a poison record cannot hide later records behind a fixed first page.
export async function recoverPages({ model, filter, enqueue, onError = console.error, batchSize = 500 }) {
  const startedAt = new Date();
  let cursor;
  let attempted = 0;
  while (true) {
    const rows = await model.find({ ...filter, createdAt: mongoose.trusted({ $lte: startedAt }),
      ...(cursor ? { _id: mongoose.trusted({ $gt: cursor }) } : {}),
    }).select("_id").sort({ _id: 1 }).limit(batchSize).lean();
    for (const row of rows) {
      attempted++;
      try { await enqueue(row._id); } catch (error) { onError(error, row._id); }
    }
    if (rows.length < batchSize) return attempted;
    cursor = rows.at(-1)._id;
  }
}

export function periodicRecovery(run, onError = console.error, intervalMs = 60000) {
  let inFlight = null;
  const tick = () => {
    if (!inFlight) inFlight = Promise.resolve().then(run).catch(onError).finally(() => { inFlight = null; });
    return inFlight;
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { tick, async stop() { clearInterval(timer); await inFlight; } };
}
