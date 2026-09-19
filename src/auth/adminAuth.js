import env from "../config/env.js";
import { requireCustomer } from "./supabaseAuth.js";

export function requireAdmin(req, res, next) {
  requireCustomer(req, res, (error) => {
    if (error) return next(error);
    const email = String(req.customer?.email || "").trim().toLowerCase();
    if (!email || !env.ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ success: false, message: "Admin access required." });
    }
    req.admin = {
      userId: req.customer.id,
      customerId: req.customer.customerId,
      email,
    };
    next();
  });
}
