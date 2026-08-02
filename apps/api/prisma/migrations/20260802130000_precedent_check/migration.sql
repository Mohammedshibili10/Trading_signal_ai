-- Precedent check, and archiving as a flag rather than a status.
--
-- `ARCHIVED` was added to SignalStatus in the previous migration and is removed
-- again here without ever having been written. Archiving a stopped trade must
-- not stop it being a stopped trade: the status is the outcome, and the outcome
-- is exactly what the learning data is made of. `archivedAt` already carries
-- the fact, and the lifecycle stage is derived from the two together.

ALTER TYPE "SignalStatus" RENAME TO "SignalStatus_old";

CREATE TYPE "SignalStatus" AS ENUM (
  'ACTIVE',
  'HIT_T1',
  'HIT_T2',
  'HIT_T3',
  'STOPPED',
  'EXPIRED',
  'CANCELLED',
  'INVALID'
);

ALTER TABLE "signals" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "signals"
  ALTER COLUMN "status" TYPE "SignalStatus"
  USING ("status"::text)::"SignalStatus";

ALTER TABLE "signals" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

DROP TYPE "SignalStatus_old";

-- The precedent check that ran before this signal was issued: matched setups,
-- their outcomes, and any previously-fatal condition found present again.
-- Stored so a confidence adjustment can be audited against what was known at
-- the time rather than re-derived later against a record that has since grown.
ALTER TABLE "signals" ADD COLUMN "precedent" JSONB;
