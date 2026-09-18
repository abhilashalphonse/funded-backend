import { randomUUID } from "node:crypto";
import Customer from "./customer.model.js";
import Account from "../accounts/account.model.js";
import Payment from "../models/payment.model.js";

function customerId() {
  return `CUS-${randomUUID().replace(/-/g, "").toUpperCase()}`;
}

export function normalizeCustomerEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    const error = new Error("A valid customer email is required.");
    error.status = 400;
    error.code = "INVALID_CUSTOMER_EMAIL";
    throw error;
  }
  return email;
}

async function canonicalCustomer(record, customerModel = Customer) {
  let current = record;
  const visited = new Set();

  for (let depth = 0; current?.mergedIntoCustomerId && depth < 8; depth += 1) {
    if (visited.has(current.customerId)) break;
    visited.add(current.customerId);
    const next = await customerModel.findOne({ customerId: current.mergedIntoCustomerId });
    if (!next) break;
    current = next;
  }

  return current;
}

async function createCustomer(data, customerModel = Customer) {
  try {
    return await customerModel.create({ customerId: customerId(), ...data });
  } catch (error) {
    if (error?.code !== 11000) throw error;

    if (data.supabaseUserId) {
      const byAuth = await customerModel.findOne({ supabaseUserId: data.supabaseUserId });
      if (byAuth) return canonicalCustomer(byAuth, customerModel);
    }

    const byEmail = await customerModel.findOne({ primaryEmail: data.primaryEmail });
    if (byEmail) return canonicalCustomer(byEmail, customerModel);
    throw error;
  }
}

async function migrateOwnership(sourceCustomerId, targetCustomerId, { accountModel = Account, paymentModel = Payment } = {}) {
  if (!sourceCustomerId || !targetCustomerId || sourceCustomerId === targetCustomerId) return;

  await Promise.all([
    accountModel.updateMany(
      { customerId: sourceCustomerId },
      { $set: { customerId: targetCustomerId } },
    ),
    paymentModel.updateMany(
      { customerId: sourceCustomerId },
      { $set: { customerId: targetCustomerId } },
    ),
  ]);
}

async function claimLegacyOwnership(canonical, authCustomer, { accountModel = Account, paymentModel = Payment } = {}) {
  const legacyRefs = [authCustomer?.id, authCustomer?.email].map(value => String(value || "").trim()).filter(Boolean);
  if (!legacyRefs.length) return;

  await Promise.all([
    accountModel.updateMany(
      { customerId: { $exists: false }, ownerExternalRef: { $in: legacyRefs } },
      { $set: { customerId: canonical.customerId } },
    ),
    paymentModel.updateMany(
      { customerId: { $exists: false }, ownerExternalRef: { $in: legacyRefs } },
      { $set: { customerId: canonical.customerId } },
    ),
  ]);
}

async function mergeGuestInto(target, guest, deps = {}) {
  if (!guest || guest.customerId === target.customerId) return target;
  if (guest.supabaseUserId && guest.supabaseUserId !== target.supabaseUserId) {
    const error = new Error("This email is already linked to another authenticated customer.");
    error.status = 409;
    error.code = "CUSTOMER_IDENTITY_CONFLICT";
    throw error;
  }

  guest.status = "MERGED";
  guest.mergedIntoCustomerId = target.customerId;
  await guest.save();

  const aliases = new Set([...(target.emailAliases || []), guest.primaryEmail, ...(guest.emailAliases || [])].filter(Boolean));
  target.emailAliases = [...aliases];
  await target.save();

  await migrateOwnership(guest.customerId, target.customerId, deps);
  return target;
}

export async function getOrCreateGuestCustomer(email, { customerModel = Customer } = {}) {
  const normalizedEmail = normalizeCustomerEmail(email);
  const existing = await customerModel.findOne({ primaryEmail: normalizedEmail });
  if (existing) return canonicalCustomer(existing, customerModel);

  return createCustomer({
    primaryEmail: normalizedEmail,
    status: "ACTIVE",
  }, customerModel);
}

export async function resolveAuthenticatedCustomer(authCustomer, deps = {}) {
  const customerModel = deps.customerModel || Customer;
  const supabaseUserId = String(authCustomer?.id || "").trim();
  const primaryEmail = normalizeCustomerEmail(authCustomer?.email);

  if (!supabaseUserId) {
    const error = new Error("Authenticated customer ID is required.");
    error.status = 401;
    error.code = "CUSTOMER_AUTH_ID_REQUIRED";
    throw error;
  }

  let byAuth = await customerModel.findOne({ supabaseUserId });
  if (byAuth) byAuth = await canonicalCustomer(byAuth, customerModel);

  let byEmail = await customerModel.findOne({ primaryEmail });
  if (byEmail) byEmail = await canonicalCustomer(byEmail, customerModel);

  let resolved;
  let identityChanged = false;

  if (byAuth) {
    resolved = byAuth;
    if (byEmail && byEmail.customerId !== byAuth.customerId) {
      if (byEmail.supabaseUserId && byEmail.supabaseUserId !== supabaseUserId) {
        const error = new Error("This email is already linked to another authenticated customer.");
        error.status = 409;
        error.code = "CUSTOMER_IDENTITY_CONFLICT";
        throw error;
      }
      resolved = await mergeGuestInto(byAuth, byEmail, deps);
      identityChanged = true;
    }

    if (resolved.primaryEmail !== primaryEmail && !(resolved.emailAliases || []).includes(primaryEmail)) {
      resolved.emailAliases = [...new Set([...(resolved.emailAliases || []), primaryEmail])];
      identityChanged = true;
    }
  } else if (byEmail) {
    if (byEmail.supabaseUserId && byEmail.supabaseUserId !== supabaseUserId) {
      const error = new Error("This email is already linked to another authenticated customer.");
      error.status = 409;
      error.code = "CUSTOMER_IDENTITY_CONFLICT";
      throw error;
    }
    byEmail.supabaseUserId = supabaseUserId;
    byEmail.authLinkedAt = byEmail.authLinkedAt || new Date();
    resolved = byEmail;
    identityChanged = true;
  } else {
    resolved = await createCustomer({
      supabaseUserId,
      primaryEmail,
      authLinkedAt: new Date(),
      lastAuthenticatedAt: new Date(),
      status: "ACTIVE",
    }, customerModel);
    identityChanged = true;
  }

  const now = new Date();
  const lastAuthenticatedAt = resolved.lastAuthenticatedAt ? new Date(resolved.lastAuthenticatedAt).getTime() : 0;
  const refreshAuthTimestamp = !lastAuthenticatedAt || now.getTime() - lastAuthenticatedAt >= 15 * 60 * 1000;

  if (!resolved.authLinkedAt) {
    resolved.authLinkedAt = now;
    identityChanged = true;
  }
  if (refreshAuthTimestamp) {
    resolved.lastAuthenticatedAt = now;
    identityChanged = true;
  }

  if (identityChanged) {
    await resolved.save();
    await claimLegacyOwnership(resolved, { id: supabaseUserId, email: primaryEmail }, deps);
  }

  return resolved;
}

export async function getCustomerOwnershipIds(customer, { customerModel = Customer } = {}) {
  if (!customer?.customerId) return [];
  const merged = await customerModel.find({ mergedIntoCustomerId: customer.customerId }).select("customerId").lean();
  return [...new Set([customer.customerId, ...merged.map(item => item.customerId).filter(Boolean)])];
}
