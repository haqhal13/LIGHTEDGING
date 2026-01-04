import mongoose, { Schema, Document } from "mongoose";
import { TradeHistory } from "../interfaces";

export interface TradeHistoryDocument extends TradeHistory, Document {}

const TradeHistorySchema = new Schema<TradeHistoryDocument>(
  {
    marketId: { type: String, required: true },
    conditionId: { type: String, required: true },
    tokenId: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    price: { type: Number, required: true },
    size: { type: Number, required: true },
    usdcSize: { type: Number, required: true },
    fees: { type: Number, default: 0 },
    strategyName: { type: String, required: true },
    paperTrade: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
    transactionHash: { type: String },
  },
  { timestamps: true }
);

TradeHistorySchema.index({ conditionId: 1 });
TradeHistorySchema.index({ strategyName: 1 });
TradeHistorySchema.index({ timestamp: -1 });
TradeHistorySchema.index({ paperTrade: 1 });

export const TradeHistoryModel = mongoose.model<TradeHistoryDocument>(
  "TradeHistory",
  TradeHistorySchema
);

export default TradeHistoryModel;
