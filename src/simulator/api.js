import express from "express";
import simulatorEngine from "./engine.js";

const router = express.Router();

router.post("/api/accounts", async (req, res, next) => {
  try {
    const { accountId, balance, leverage } = req.body ?? {};
    if (!accountId || balance === undefined) {
      return res.status(400).json({ success: false, message: "accountId and balance are required" });
    }
    const account = await simulatorEngine.provisionAccount({ accountId, balance: Number(balance), leverage });
    return res.status(201).json({ success: true, data: account });
  } catch (error) { next(error); }
});

router.get("/api/accounts/:accountId", (req, res) => {
  const account = simulatorEngine.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ success: false, message: "Simulator account not found" });
  return res.json({ success: true, data: account });
});

router.post("/api/accounts/:accountId/snapshot", async (req, res, next) => {
  try {
    const account = await simulatorEngine.recordSnapshot(req.params.accountId, req.body ?? {});
    return res.status(202).json({ success: true, data: account });
  } catch (error) { next(error); }
});

export default router;
