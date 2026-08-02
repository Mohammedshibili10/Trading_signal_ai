-- Signal lifecycle: separate the ways a signal can end.
--
-- `INVALIDATED` conflated two very different endings: a filled position the
-- engine closed early, and a setup that broke before it was ever entered. Only
-- the first can have cost anything, and neither is a loss — so both were being
-- reported alongside genuine stop-outs. Splitting them is what lets the loss
-- column mean "price traded through the stop" and nothing else.
--
-- Postgres will not drop an enum value that rows still reference, so the type
-- is rebuilt and the column recast with an explicit mapping.

ALTER TYPE "SignalStatus" RENAME TO "SignalStatus_old";

CREATE TYPE "SignalStatus" AS ENUM (
  'ACTIVE',
  'HIT_T1',
  'HIT_T2',
  'HIT_T3',
  'STOPPED',
  'EXPIRED',
  'CANCELLED',
  'INVALID',
  'ARCHIVED'
);

ALTER TABLE "signals" ALTER COLUMN "status" DROP DEFAULT;

-- Existing INVALIDATED rows predate fill tracking, so there is no evidence any
-- of them was ever entered. INVALID is the claim the data actually supports;
-- CANCELLED would assert a position that was never recorded.
ALTER TABLE "signals"
  ALTER COLUMN "status" TYPE "SignalStatus"
  USING (
    CASE "status"::text
      WHEN 'INVALIDATED' THEN 'INVALID'
      ELSE "status"::text
    END
  )::"SignalStatus";

ALTER TABLE "signals" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

DROP TYPE "SignalStatus_old";

-- ── Lifecycle columns ───────────────────────────────────────────
ALTER TABLE "signals" ADD COLUMN "entryFilledAt" TIMESTAMP(3);
ALTER TABLE "signals" ADD COLUMN "cooldownUntil" TIMESTAMP(3);
ALTER TABLE "signals" ADD COLUMN "supersedesId"  TEXT;
ALTER TABLE "signals" ADD COLUMN "archivedAt"    TIMESTAMP(3);

CREATE UNIQUE INDEX "signals_supersedesId_key" ON "signals"("supersedesId");

ALTER TABLE "signals"
  ADD CONSTRAINT "signals_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "signals"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "signals_symbol_timeframe_action_status_idx"
  ON "signals"("symbol", "timeframe", "action", "status");

-- Signals already ended by the engine must not be re-issued the moment this
-- ships. Without a cooldown the very next scan would regenerate them, which is
-- the bug this migration exists to fix.
UPDATE "signals"
   SET "cooldownUntil" = NOW() + INTERVAL '6 hours'
 WHERE "status" IN ('CANCELLED', 'INVALID')
   AND "cooldownUntil" IS NULL;
