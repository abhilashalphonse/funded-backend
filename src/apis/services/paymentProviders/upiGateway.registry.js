import env from "../../../config/env.js";
import SystemSetting from "../../../models/systemSetting.model.js";
import {
  createUpiOrder,
  getUpiOrderStatus,
  normalizeUpiStatus,
} from "./upiGateway.service.js";

export const ACTIVE_UPI_GATEWAY_SETTING = "payments.upi.activeGateway";
export const DEFAULT_UPI_GATEWAY_ID = "upi_gateway_1";

const LEGACY_ALIASES = new Map([
  ["upi-gateway", DEFAULT_UPI_GATEWAY_ID],
  ["upi_gateway", DEFAULT_UPI_GATEWAY_ID],
]);

const gateways = [
  {
    id: DEFAULT_UPI_GATEWAY_ID,
    label: "UPI Gateway 1",
    implemented: true,
    isConfigured: () => Boolean(
      env.UPI_GATEWAY_BASE_URL
      && env.UPI_GATEWAY_API_TOKEN
      && env.UPI_GATEWAY_CALLBACK_URL
    ),
    callbackUrl: () => env.UPI_GATEWAY_CALLBACK_URL,
    quoteSecret: () => env.UPI_GATEWAY_API_TOKEN,
    createOrder: createUpiOrder,
    getOrderStatus: getUpiOrderStatus,
    normalizeStatus: normalizeUpiStatus,
  },
  {
    id: "upi_gateway_2",
    label: "UPI Gateway 2",
    implemented: false,
    isConfigured: () => false,
    callbackUrl: () => null,
    quoteSecret: () => null,
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
  if (normalized === DEFAULT_UPI_GATEWAY_ID) {
    return [DEFAULT_UPI_GATEWAY_ID, "upi-gateway", "upi_gateway"];
  }
  return [normalized];
}
