export const PAYOUT_PROVIDER_FEE_POLICY = "ACG_COVERS";

export const PAYOUT_FEE_POLICY = Object.freeze({
  providerFeePolicy: PAYOUT_PROVIDER_FEE_POLICY,
  traderPaysProviderFee: false,
  description: "ACG covers payout-provider fees. Provider fees must not reduce the trader's quoted payout amount.",
});
