import mongoose, { Schema, Document } from "mongoose";
import { Position } from "../interfaces";

export interface PositionDocument extends Position, Document {}

const PositionSchema = new Schema<PositionDocument>(
  {
    conditionId: { type: String, required: true },
    tokenId: { type: String, required: true },
    title: { type: String, required: true },
    outcome: { type: String, required: true },
    size: { type: Number, required: true },
    avgPrice: { type: Number, required: true },
    currentPrice: { type: Number },
    currentValue: { type: Number },
    cashPnl: { type: Number, default: 0 },
    percentPnl: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

PositionSchema.index({ conditionId: 1 }, { unique: true });
PositionSchema.index({ tokenId: 1 });

export const PositionModel = mongoose.model<PositionDocument>(
  "Position",
  PositionSchema
);

export default PositionModel;
