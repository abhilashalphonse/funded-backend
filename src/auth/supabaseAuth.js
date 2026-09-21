import env from "../config/env.js";
import { getCustomerOwnershipIds, resolveAuthenticatedCustomer } from "../customers/customer.service.js";

function bearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

async function resolveCustomer(token) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    const error = new Error("Supabase authentication is not configured on the API.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  const user = await response.json().catch(() => null);
  if (!response.ok || !user?.id) return null;

  const authCustomer = {
    id: String(user.id),
    email: String(user.email || "").trim().toLowerCase(),
    metadata: user.user_metadata || {},
  };

  const fundedCustomer = await resolveAuthenticatedCustomer(authCustomer);
  const customerIds = await getCustomerOwnershipIds(fundedCustomer);

  return {
    ...authCustomer,
    customerId: fundedCustomer.customerId,
    customerIds,
    status: fundedCustomer.status,
  };
}

export async function requireCustomer(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: "Authentication required.", code: "AUTH_REQUIRED" });
    const customer = await resolveCustomer(token);
    if (!customer) return res.status(401).json({ success: false, message: "Invalid or expired session.", code: "AUTH_SESSION_INVALID" });
    if (String(customer.status || "").toUpperCase() === "BLOCKED") {
      return res.status(403).json({ success: false, message: "This customer account is blocked.", code: "CUSTOMER_BLOCKED" });
    }
    req.customer = customer;
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAdmin(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: "Authentication required.", code: "AUTH_REQUIRED" });
    const customer = await resolveCustomer(token);
    if (!customer) return res.status(401).json({ success: false, message: "Invalid or expired session.", code: "AUTH_SESSION_INVALID" });

    const email = String(customer.email || "").trim().toLowerCase();
    if (!email || !env.ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ success: false, message: "Admin access is not enabled for this account." });
    }

    req.customer = customer;
    req.admin = {
      email,
      customerId: customer.customerId,
      authUserId: customer.id,
      role: "SUPER_ADMIN",
    };
    next();
  } catch (error) {
    next(error);
  }
}

export async function optionalCustomer(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return next();
    const customer = await resolveCustomer(token);
    if (!customer) return res.status(401).json({ success: false, message: "Invalid or expired session.", code: "AUTH_SESSION_INVALID" });
    if (String(customer.status || "").toUpperCase() === "BLOCKED") {
      return res.status(403).json({ success: false, message: "This customer account is blocked.", code: "CUSTOMER_BLOCKED" });
    }
    req.customer = customer;
    next();
  } catch (error) {
    next(error);
  }
}
