-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "barsHeld" INTEGER,
ADD COLUMN     "captureRatio" DECIMAL(6,3),
ADD COLUMN     "confluence" JSONB,
ADD COLUMN     "confluenceScore" DECIMAL(5,1),
ADD COLUMN     "maeR" DECIMAL(8,3),
ADD COLUMN     "mfeR" DECIMAL(8,3),
ADD COLUMN     "postMortem" JSONB,
ADD COLUMN     "primaryReason" TEXT,
ADD COLUMN     "realisedR" DECIMAL(8,3);

-- CreateTable
CREATE TABLE "weight_proposals" (
    "id" TEXT NOT NULL,
    "baseWeights" JSONB NOT NULL,
    "proposedWeights" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "performance" JSONB NOT NULL,
    "tradesAnalysed" INTEGER NOT NULL,
    "holdoutSize" INTEGER NOT NULL DEFAULT 0,
    "baseSeparation" DECIMAL(10,6),
    "proposedSeparation" DECIMAL(10,6),
    "edge" DECIMAL(10,6),
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weight_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weight_proposals_isActive_idx" ON "weight_proposals"("isActive");

-- CreateIndex
CREATE INDEX "weight_proposals_createdAt_idx" ON "weight_proposals"("createdAt");

-- CreateIndex
CREATE INDEX "signals_primaryReason_idx" ON "signals"("primaryReason");
