require("dotenv").config({ override: true });
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const rows = await mongoose.connection.db
    .collection("events")
    .find({
      aggregateId: "TRIAL-3AED89F2044C4218",
      eventType: "ACG_TRADER_ACCOUNT_SNAPSHOT"
    })
    .sort({ occurredAt: -1 })
    .limit(5)
    .toArray();

  console.dir(rows.map(x => ({
    eventId: x.eventId,
    occurredAt: x.occurredAt,
    receivedAt: x.receivedAt,
    streamVersion: x.streamVersion,
    payload: x.payload
  })), { depth: null });

  await mongoose.disconnect();
})();
