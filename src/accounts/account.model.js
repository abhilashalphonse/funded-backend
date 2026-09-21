import mongoose from "mongoose";

const PlatformAccountSchema = new mongoose.Schema({
    phase: { type: Number, required: true },
    accountType: { type: String, enum: ["DEMO", "CHALLENGE", "FUNDED"], default: "CHALLENGE" },
    externalRef: { type: String, required: true },
    platformAccountId: { type: String, required: true },
    accountCode: { type: String, default: null },
    login: { type: String, default: null },
    status: { type: String, default: "ACTIVE" },
    provisionedAt: { type: Date, default: Date.now }
}, { _id: false });

const DemoPositionSchema = new mongoose.Schema({
    positionId: { type: String, required: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    quantity: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    openedAt: { type: Date, default: Date.now },
}, { _id: false });

const DemoTradeSchema = new mongoose.Schema({
    tradeId: { type: String, required: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    quantity: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    pnl: { type: Number, required: true },
    openedAt: Date,
    closedAt: { type: Date, default: Date.now },
}, { _id: false });

const BreachSchema = new mongoose.Schema({
    primaryReason: {
        type: String,
        enum: ["DAILY_DRAWDOWN", "MAX_DRAWDOWN"],
        required: true
    },
    triggeredRules: {
        type: [String],
        default: []
    },
    breachedAt: { type: Date, required: true },
    phase: { type: Number, required: true },
    balance: { type: Number, default: null },
    equity: { type: Number, default: null },
    dailyStartEquity: { type: Number, default: null },
    initialBalance: { type: Number, default: null },
    dailyLoss: { type: Number, default: null },
    totalLoss: { type: Number, default: null },
    limitAmount: { type: Number, default: null },
    actualLoss: { type: Number, default: null },
    breachAmount: { type: Number, default: null },
}, { _id: false });

const AccountSchema = new mongoose.Schema(
    {
        accountId: { type: String, required: true, unique: true },
        ownerExternalRef: { type: String, index: true },
        customerId: { type: String, index: true, sparse: true },
        version: { type: Number, default: 0 },
        lastSequence: { type: Number, default: 0 },
        lastProcessedEventId: { type: String },
        lastPlatformSnapshotAt: { type: Date, default: null },
        lastPlatformSnapshotSequence: { type: Number, default: null },
        lastActiveDay: { type: String },
        lastTradingDay: { type: String },
        riskDayKey: { type: String },
        dailyResetAt: { type: Date },
        dailyStartEquity: { type: Number, default: 0 },
        commandPending: { type: String, default: null },

        accountMode: { type: String, enum: ["CHALLENGE", "DEMO"], default: "CHALLENGE", index: true },
        challengeType: { type: String, required: true },
        accountSize: { type: Number, required: true },
        initialDeposit: { type: Number, default: 0 },
        currentPhase: { type: Number, default: 1 },

        commercialTerms: {
            profitSplit: Number,
            payoutFrequency: String,
            newsTrading: Boolean,
            weekendHolding: Boolean
        },

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
        customerAccessBlocked: { type: Boolean, default: false },
        statusBeforeLock: { type: String, default: null },
        fundedApprovedAt: { type: Date, default: null },

        breach: { type: BreachSchema, default: null },

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

        demoTrading: {
            positions: { type: [DemoPositionSchema], default: [] },
            history: { type: [DemoTradeSchema], default: [] },
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
AccountSchema.index(
    { platform: 1, platformAccountId: 1 },
    {
        unique: true,
        partialFilterExpression: { platformAccountId: { $type: "string" } }
    }
);
AccountSchema.index({ status: 1 });
AccountSchema.index({ ownerExternalRef: 1, accountMode: 1, createdAt: -1 });
AccountSchema.index({ customerId: 1, accountMode: 1, createdAt: -1 });

export default mongoose.model("Account", AccountSchema);
