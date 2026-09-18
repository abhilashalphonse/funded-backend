require("dotenv").config({ override: true });
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const x = await mongoose.connection.db
    .collection("accounts")
    .findOne({ accountId: "TRIAL-3AED89F2044C4218" });

  console.dir({
    accountId: x?.accountId,
    status: x?.status,
    enabled: x?.enabled,
    balance: x?.balance,
    equity: x?.equity,
    floatingProfit: x?.floatingProfit,
    margin: x?.margin,
    marginFree: x?.marginFree,
    marginLevel: x?.marginLevel,
    lastProcessedEventId: x?.lastProcessedEventId,
    lastPlatformSnapshotAt: x?.lastPlatformSnapshotAt,
    lastPlatformSnapshotSequence: x?.lastPlatformSnapshotSequence
  }, { depth: null });

  await mongoose.disconnect();
})();
