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


export async function getDirectPurchaseMetrics(from) {
  const rows = await Payment.aggregate([
    { $match: { createdAt: { $gte: from } } },
    { $group: {
      _id: { $ifNull: ["$customerId", "$ownerExternalRef"] },
      firstOrderAt: { $min: "$createdAt" },
      paid: { $max: { $cond: [{ $eq: ["$status", "PAID"] }, 1, 0] } },
      active: { $max: { $cond: [{
        $and: [
          { $eq: ["$status", "PAID"] },
          { $eq: ["$activation.status", "ACTIVE"] },
        ],
      }, 1, 0] } },
    } },
    { $match: { _id: { $nin: [null, ""] } } },
    { $lookup: {
      from: Account.collection.name,
      let: { customer: "$_id", before: "$firstOrderAt" },
      pipeline: [
        { $match: { accountMode: "DEMO" } },
        { $match: { $expr: { $and: [
          { $eq: ["$customerId", "$$customer"] },
          { $lte: ["$createdAt", "$$before"] },
        ] } } },
        { $limit: 1 },
      ],
      as: "priorTrials",
    } },
    { $match: { priorTrials: { $size: 0 } } },
    { $group: {
      _id: null, customers: { $sum: 1 },
      paid: { $sum: "$paid" }, active: { $sum: "$active" },
    } },
  ]).allowDiskUse(true);
  return rows[0] || { customers: 0, paid: 0, active: 0 };
}
