import Account from "../../accounts/account.model.js";
import Payment from "../../models/payment.model.js";
import AnalyticsEvent from "../../models/analyticsEvent.model.js";

export async function getCustomerJourneyMetrics(from) {
  const trials = await Account.aggregate([
    { $match: { accountMode: "DEMO", createdAt: { $gte: from } } },
    { $group: {
      _id: { $ifNull: ["$customerId", "$ownerExternalRef"] },
      started: { $min: "$createdAt" },
      accounts: { $addToSet: "$accountId" },
      traded: { $max: { $cond: [{ $gt: ["$totalTrades", 0] }, 1, 0] } },
      passed: { $max: { $cond: [{ $eq: ["$trial.result", "PASSED"] }, 1, 0] } },
    } },
    { $match: { _id: { $nin: [null, ""] } } },
    { $lookup: {
      from: AnalyticsEvent.collection.name,
      localField: "accounts",
      foreignField: "accountId",
      pipeline: [
        { $match: { source: "server", event: { $in: ["trial_first_trade", "trial_passed"] } } },
        { $group: { _id: "$event" } },
      ],
      as: "outcomes",
    } },
    { $lookup: {
      from: Payment.collection.name,
      localField: "_id",
      foreignField: "customerId",
      as: "payments",
    } },
    { $project: {
      traded: { $cond: [{ $or: [
        { $eq: ["$traded", 1] }, { $in: ["trial_first_trade", "$outcomes._id"] },
      ] }, 1, 0] },
      passed: { $cond: [{ $or: [
        { $eq: ["$passed", 1] }, { $in: ["trial_passed", "$outcomes._id"] },
      ] }, 1, 0] },
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


function stage(key, label, count, total, previous = null) {
  return {
    key, label, count: Number(count || 0),
    overallRate: total ? Number(count || 0) / total : 0,
    stepRate: previous == null ? null : (previous ? Number(count || 0) / previous : 0),
  };
}

export async function getCustomerCohortJourneys(from) {
  const [trial, direct] = await Promise.all([
    getCustomerJourneyMetrics(from),
    getDirectPurchaseMetrics(from),
  ]);
  const trials = Number(trial.customers || 0);
  const checkouts = Number(direct.customers || 0);
  const buyers = Number(direct.paid || 0);
  return {
    trial: {
      identity: "customer",
      label: "Free Trial — Customer Cohort",
      description: "Unique customers who started a trial during this period. Passing is optional before buying.",
      stages: [
        stage("trial_created", "Customers starting trials", trials, trials, trials),
        stage("trial_first_trade", "Customers who traded", trial.traded, trials, trials),
        stage("trial_passed", "Customers who passed", trial.passed, trials),
        stage("payment_completed", "Customers who purchased", trial.purchased, trials),
      ],
    },
    paid: {
      identity: "customer",
      label: "Direct Purchase — Customer Cohort",
      description: "Unique customers with payment orders started this period and no prior trial.",
      stages: [
        stage("payment_started", "Customers starting payment", checkouts, checkouts, checkouts),
        stage("payment_completed", "Customers who paid", buyers, checkouts, checkouts),
        stage("account_activated", "Customers activated", direct.active, checkouts, buyers),
      ],
    },
  };
}
