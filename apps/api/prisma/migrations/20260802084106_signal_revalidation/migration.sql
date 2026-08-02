-- AlterEnum
ALTER TYPE "SignalStatus" ADD VALUE 'INVALIDATED';

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "atrPercentAtIssue" DECIMAL(8,4),
ADD COLUMN     "healthFindings" JSONB,
ADD COLUMN     "healthSeverity" TEXT,
ADD COLUMN     "invalidatedAt" TIMESTAMP(3),
ADD COLUMN     "invalidationReason" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3);
