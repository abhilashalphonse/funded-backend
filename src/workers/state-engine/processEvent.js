import Account from "../../accounts/account.model.js";
import { evaluateRules } from "./rules.js";
import { resolveDecision } from "./decisions.js"; 
import { CommandQueue } from "./commandQueue.js"; 


export async function processEvent(event, boss) {

    const account = await Account.findOne({
        accountId: event.aggregateId
    });

    if (!account) {
        throw new Error(
            `Account ${event.aggregateId} not found`
        );
    }

    if (["BREACHED", "CLOSED", "FUNDED"].includes(account.status)) {
        console.log(`[STATE] Terminal account skipped ${account.accountId}`);
        return;
    }

    if (account.lastProcessedEventId === event.eventId) {
        console.log(
            `[STATE] Duplicate event skipped ${event.eventId}`
        );
        return;
    }

    applyEvent(account, event);

    const rules = evaluateRules(account);

    const decision = resolveDecision(
        account,
        rules
    );

    if (!decision.shouldUpdate) {
        account.lastProcessedEventId = event.eventId;
        await account.save();
        return;
    }

    console.log(
        `[STATE] ${account.accountId}: ${account.status} → ${decision.newStatus}`
    );

    account.status = decision.newStatus;
    account.lastProcessedEventId = event.eventId;

    // 1. Save projection
    await account.save();

    // 2. Enqueue command (New Logic)
    if (decision.command) {
        try {
            const commandQueue = new CommandQueue(boss);
            await commandQueue.enqueueCommand(decision.command, account);
            account.commandPending = null;
        } catch (error) {
            // Keep the state decision durable and make a failed side effect visible/retriable.
            account.commandPending = decision.command;
            await account.save();
            throw error;
        }
    }
}


function applyEvent(account, event) {
    const p = event.payload || {};
    const eventDate = new Date(event.receivedAt || Date.now());

    // Defensive check: Ensure the projections object exists
    account.projections = account.projections || {};

    // --- 1 & 2. Update Balance & Equity (and other raw payload data) ---
    if (p.balance !== undefined) account.balance = p.balance;
    if (p.equity !== undefined) account.equity = p.equity;
    if (p.margin !== undefined) account.margin = p.margin;
    if (p.openPositions !== undefined) account.openPositions = p.openPositions;

    // Set up baselines for calculations
    const initialBalance = account.initialDeposit;

    // --- 3. Update Highest Balance (High Water Mark) ---
    // 🔴 FIXED: Moved to projections
    if (account.projections.highestBalance === undefined) {
        account.projections.highestBalance = account.balance;
    }
    account.projections.highestBalance = Math.max(account.projections.highestBalance, account.balance);

    // --- 4. Update Highest Equity (High Water Mark) ---
    // Applying the same safe initialization to equity
    if (account.projections.highestEquity === undefined) {
        account.projections.highestEquity = account.equity;
    }
    account.projections.highestEquity = Math.max(account.projections.highestEquity, account.equity);

    // --- 5. Update Profit ---
    // 🔴 FIXED: Moved to projections
    account.projections.profit = account.balance - initialBalance;

    // --- 6. Update Daily Loss ---
    // 🔴 FIXED: Moved to projections
    const eventDayString = eventDate.toISOString().split('T')[0];
    if (account.lastActiveDay !== eventDayString) {
        account.lastActiveDay = eventDayString;
        account.dailyResetAt = eventDate;
        account.dailyStartEquity = account.equity;
        account.projections.tradingDays += 1;
    }
    if (account.dailyStartEquity === 0) account.dailyStartEquity = account.equity;
    account.projections.dailyLoss = Math.max(0, account.dailyStartEquity - account.equity);

    // --- 7. Update Total Loss ---
    // 🔴 FIXED: Moved to projections
    account.projections.totalLoss = Math.max(0, initialBalance - account.equity);
}
