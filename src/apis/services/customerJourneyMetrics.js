import Account from "../../accounts/account.model.js";
import Payment from "../../models/payment.model.js";

export async function getCustomerJourneyMetrics(from) {
  const trials = await Account.aggregate([
    { $match: { accountMode: "DEMO", createdAt: { $gte: from } } },
    { $group: {
      _id: { $ifNull: ["$customerId", "$ownerExternalRef"] },
      started: { $min: "$createdAt" },
      traded: { $max: { $cond: [{ $gt: ["$totalTrades", 0] }, 1, 0] } },
      passed: { $max: { $cond: [{ $eq: ["$trial.result", "PASSED"] }, 1, 0] } },
    } },
    { $match: { _id: { $nin: [null, ""] } } },
    { $lookup: {
      from: Payment.collection.name,
      localField: "_id",
      foreignField: "customerId",
      as: "payments",
    } },
    { $project: {
      traded: 1, passed: 1,
      purchased: { $gt: [{ $size: { $filter: {
        input: "$payments", as: "p",
        cond: { $and: [
          { $eq: ["$$p.status", "PAID"] },
          { $gte: ["$$p.paidAt", "$started"] },
        ] },
      } } }, 0] },
    } },
    { $group: {
      _id: null, customers: { $sum: 1 },
      traded: { $sum: "$traded" }, passed: { $sum: "$passed" },
      purchased: { $sum: { $cond: ["$purchased", 1, 0] } },
    } },
  ]).allowDiskUse(true);
  return trials[0] || { customers: 0, traded: 0, passed: 0, purchased: 0 };
}
