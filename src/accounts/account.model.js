import mongoose from "mongoose";

const AccountSchema = new mongoose.Schema(
    {
        // --- Identity & Meta ---
        accountId: { type: String, required: true, unique: true },
        version: { type: Number, default: 0 },
        lastSequence: { type: Number, default: 0 },
        lastProcessedEventId: { type: String },
        lastActiveDay: { type: String },
        dailyResetAt: { type: Date },
        dailyStartEquity: { type: Number, default: 0 },
        commandPending: { type: String, default: null },
        
        // --- Configuration & Challenge Definition ---
        challengeType: { type: String, required: true },
        accountSize: { type: Number, required: true },
        initialDeposit: { type: Number, default: 0 },
        currentPhase: { type: Number, default: 1 },
        
        rules: {
            dailyDrawdown: Number,
            maxDrawdown: Number,
            minimumTradingDays: Number,
            phases: [{
                phase: Number,
                profitTarget: Number
            }]
        },

        // --- Current State ---
        status: {
            type: String,
            default: "NEW",
            enum: ["NEW", "ACTIVE", "BREACHED", "LOCKED", "PASSED", "PHASE_2", "FUNDED_REVIEW", "FUNDED", "CLOSED"]
        },
        enabled: { type: Boolean, default: true },
        
        // --- Platform Integration ---
        platform: { type: String, default: "mt5" },
        platformAccountId: { type: String, sparse: true },
        login: Number,
        group: String,
        leverage: Number,

        // --- Computed Projections (Read Model) ---
        projections: {
            highestBalance: { type: Number, default: 0 },
            highestEquity: { type: Number, default: 0 },
            profit: { type: Number, default: 0 },
            dailyLoss: { type: Number, default: 0 },
            totalLoss: { type: Number, default: 0 },
            dailyStartBalance: { type: Number, default: 0 },
            tradingDays: { type: Number, default: 0 },
            passedAt: { type: Date },
            breachedAt: { type: Date }
        },

        // --- Active Metrics (Raw from Platform) ---
        balance: { type: Number, default: 0 },
        equity: { type: Number, default: 0 },
        credit: { type: Number, default: 0 },
        margin: { type: Number, default: 0 },
        marginFree: { type: Number, default: 0 },
        marginLevel: { type: Number, default: 0 },
        floatingProfit: { type: Number, default: 0 },
        
        // --- Historical/Aggregate Stats ---
        totalTrades: { type: Number, default: 0 },
        winningTrades: { type: Number, default: 0 },
        losingTrades: { type: Number, default: 0 }
    },
    {
        versionKey: false,
        timestamps: true
    }
);

// Indexes remain largely the same, optimized for your CQRS flow
AccountSchema.index({ accountId: 1, version: 1 });
AccountSchema.index({ accountId: 1, lastSequence: 1 });
AccountSchema.index({ platform: 1, platformAccountId: 1 }, { unique: true, sparse: true });
AccountSchema.index({ status: 1 });

export default mongoose.model("Account", AccountSchema);
