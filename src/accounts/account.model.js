import mongoose from "mongoose";

const PlatformAccountSchema = new mongoose.Schema({
    phase: { type: Number, required: true },
    externalRef: { type: String, required: true },
    platformAccountId: { type: String, required: true },
    accountCode: { type: String, default: null },
    login: { type: String, default: null },
    status: { type: String, default: "ACTIVE" },
    provisionedAt: { type: Date, default: Date.now }
}, { _id: false });

const AccountSchema = new mongoose.Schema(
    {
        accountId: { type: String, required: true, unique: true },
        ownerExternalRef: { type: String, index: true },
        version: { type: Number, default: 0 },
        lastSequence: { type: Number, default: 0 },
        lastProcessedEventId: { type: String },
        lastActiveDay: { type: String },
        dailyResetAt: { type: Date },
        dailyStartEquity: { type: Number, default: 0 },
        commandPending: { type: String, default: null },

        accountMode: { type: String, enum: ["CHALLENGE", "DEMO"], default: "CHALLENGE", index: true },
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

        status: {
            type: String,
            default: "NEW",
            enum: ["NEW", "ACTIVE", "BREACHED", "LOCKED", "PASSED", "PHASE_2", "FUNDED_REVIEW", "FUNDED", "CLOSED"]
        },
        enabled: { type: Boolean, default: true },

        platform: { type: String, default: () => process.env.TRADING_PROVIDER || "simulator" },
        platformAccountId: { type: String, sparse: true },
        platformAccountCode: { type: String, default: null },
        platformLogin: { type: String, default: null },
        platformAccounts: { type: [PlatformAccountSchema], default: [] },
        provisioning: {
            status: {
                type: String,
                enum: ["NOT_STARTED", "PENDING", "ACTIVE", "FAILED"],
                default: "NOT_STARTED"
            },
            error: { type: String, default: null },
            updatedAt: { type: Date, default: null }
        },
        login: Number,
        group: String,
        leverage: Number,

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

        balance: { type: Number, default: 0 },
        equity: { type: Number, default: 0 },
        credit: { type: Number, default: 0 },
        margin: { type: Number, default: 0 },
        marginFree: { type: Number, default: 0 },
        marginLevel: { type: Number, default: 0 },
        floatingProfit: { type: Number, default: 0 },

        totalTrades: { type: Number, default: 0 },
        winningTrades: { type: Number, default: 0 },
        losingTrades: { type: Number, default: 0 }
    },
    {
        versionKey: false,
        timestamps: true
    }
);

AccountSchema.index({ accountId: 1, version: 1 });
AccountSchema.index({ accountId: 1, lastSequence: 1 });
AccountSchema.index({ platform: 1, platformAccountId: 1 }, { unique: true, sparse: true });
AccountSchema.index({ status: 1 });
AccountSchema.index({ ownerExternalRef: 1, accountMode: 1, createdAt: -1 });

export default mongoose.model("Account", AccountSchema);
