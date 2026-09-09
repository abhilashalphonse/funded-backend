import { Schema, model } from 'mongoose';

const phaseSchema = new Schema({
  phase: { type: Number, required: true },
  profitTarget: { type: Number, required: true }
}, { _id: false });

const rulesSchema = new Schema({
  dailyDrawdown: { type: Number, required: true },
  maxDrawdown: { type: Number, required: true },
  minimumTradingDays: { type: Number, required: true }
}, { _id: false });

const tradingAccountSchema = new Schema({
  name: { type: String, required: true },
  accountSize: { type: Number, required: true },
  type: { 
    type: String, 
    enum: ['TWO_STEP', 'ONE_STEP', 'INSTANT'], 
    required: true 
  },
  price: { type: Number, required: true },
  phases: [phaseSchema],
  rules: rulesSchema
}, { timestamps: true });

const TradingAccount = model('TradingAccount', tradingAccountSchema);

export default TradingAccount;