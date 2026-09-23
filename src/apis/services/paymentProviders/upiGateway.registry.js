import env from "../../../config/env.js";
import SystemSetting from "../../../models/systemSetting.model.js";
import {
  createRupexOrder,
  getRupexOrderStatus,
  normalizeRupexStatus,
} from "./rupex.service.js";

export const ACTIVE_UPI_GATEWAY_SETTING = "payments.upi.activeGateway";
export const DEFAULT_UPI_GATEWAY_ID = "rupex";

const LEGACY_ALIASES = new Map([
  ["upi-gateway", "rupex"],
  ["upi_gateway", "rupex"],
  ["upi_gateway_1", "rupex"],
  ["upi_gateway_2", "sunpay"],
]);

const gateways = [
  {
    id: "rupex",
    label: "Rupex",
    implemented: true,
    isConfigured: () => Boolean(
      env.RUPEX_BASE_URL
      && env.RUPEX_API_TOKEN
      && env.RUPEX_CALLBACK_URL
    ),
    callbackUrl: () => env.RUPEX_CALLBACK_URL,
    quoteSecret: () => env.RUPEX_API_TOKEN,
    createOrder: createRupexOrder,
    getOrderStatus: getRupexOrderStatus,
    normalizeStatus: normalizeRupexStatus,
  },
  {
    id: "sunpay",
    label: "Sunpay",
    implemented: false,
    isConfigured: () => false,
    callbackUrl: () => env.SUNPAY_CALLBACK_URL || null,
    quoteSecret: () => env.SUNPAY_API_TOKEN || null,
    createOrder: null,
    getOrderStatus: null,
    normalizeStatus: null,
  },
];

const byId = new Map(gateways.map(gateway => [gateway.id, gateway]));

export function normalizeUpiGatewayId(value) {
  const id = String(value || "").trim().toLowerCase();
  return LEGACY_ALIASES.get(id) || id;
}

export function getUpiGateway(gatewayId, { requireAvailable = true } = {}) {
  const normalizedId = normalizeUpiGatewayId(gatewayId);
  const gateway = byId.get(normalizedId);
  if (!gateway) {
    const error = new Error("Unknown UPI payment gateway.");
    error.status = 400;
    error.code = "UPI_GATEWAY_UNKNOWN";
    throw error;
  }

  if (requireAvailable && (!gateway.implemented || !gateway.isConfigured())) {
    const error = new Error(
      gateway.implemented
        ? "Selected UPI payment gateway is not configured."
        : "Selected UPI payment gateway is not integrated yet.",
    );
    error.status = 503;
    error.code = gateway.implemented ? "UPI_GATEWAY_NOT_CONFIGURED" : "UPI_GATEWAY_NOT_INTEGRATED";
    throw error;
  }

  return gateway;
}

export async function normalizeStoredUpiGatewaySetting() {
  const setting = await SystemSetting.findOne({ key: ACTIVE_UPI_GATEWAY_SETTING });
  if (!setting) return DEFAULT_UPI_GATEWAY_ID;

  const normalized = normalizeUpiGatewayId(setting.value || DEFAULT_UPI_GATEWAY_ID);
  if (setting.value !== normalized && byId.has(normalized)) {
    setting.value = normalized;
    await setting.save();
  }
  return normalized;
}

export async function getActiveUpiGatewayId() {
  const setting = await SystemSetting.findOne({ key: ACTIVE_UPI_GATEWAY_SETTING }).lean();
  return normalizeUpiGatewayId(setting?.value || DEFAULT_UPI_GATEWAY_ID);
}

export async function getActiveUpiGateway() {
  const gatewayId = await getActiveUpiGatewayId();
  return getUpiGateway(gatewayId);
}

export async function setActiveUpiGateway(gatewayId, updatedBy = null) {
  const gateway = getUpiGateway(gatewayId);
  const previous = await getActiveUpiGatewayId();

  await SystemSetting.findOneAndUpdate(
    { key: ACTIVE_UPI_GATEWAY_SETTING },
    {
      $set: {
        value: gateway.id,
        updatedBy: updatedBy ? String(updatedBy).toLowerCase() : null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { previous, active: gateway.id };
}

export async function listUpiGateways() {
  const activeGatewayId = await getActiveUpiGatewayId();

  return gateways.map(gateway => {
    const configured = gateway.implemented && gateway.isConfigured();
    const active = gateway.id === activeGatewayId;
    const status = !gateway.implemented
      ? "NOT_INTEGRATED"
      : !configured
        ? "NOT_CONFIGURED"
        : active
          ? "ACTIVE"
          : "READY";

    return {
      id: gateway.id,
      label: gateway.label,
      implemented: gateway.implemented,
      configured,
      active,
      status,
    };
  });
}

export function gatewayIdsForPaymentLookup(gatewayId) {
  const normalized = normalizeUpiGatewayId(gatewayId);
  if (normalized === "rupex") {
    return ["rupex", "upi_gateway_1", "upi-gateway", "upi_gateway"];
  }
  if (normalized === "sunpay") {
    return ["sunpay", "upi_gateway_2"];
  }
  return [normalized];
}
