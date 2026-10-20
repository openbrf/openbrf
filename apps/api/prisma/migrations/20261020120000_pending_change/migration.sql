-- Pending changes (väntande ändringar, ADR 0039): a call to an action held as a
-- preview until the person who proposed it confirms it on the platform's own
-- screen.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql: a row is a draft that exists only while
-- it waits. Confirming and rejecting delete it, and the nightly purge deletes
-- one whose expiry has passed. The audit log is the record of what happened.

CREATE TABLE "pending_change" (
    "id" TEXT NOT NULL,

    -- The action's canonical public name. Actions are registered in memory at
    -- boot, so there is nothing to reference.
    "actionName" TEXT NOT NULL,

    -- The input as the action's schema parsed it. Can name a resident, which is
    -- why it is held here and never in an audit entry.
    "input" JSONB NOT NULL,

    -- Who it was proposed as, and the only person who may act on it. A plain
    -- column, as key_order."orderedByPersonId" is: a foreign key would either
    -- rewrite this row when a person is erased or veto the erasure.
    "proposedByPersonId" TEXT NOT NULL,

    "channel" "AuditChannel" NOT NULL,
    "clientId" TEXT,
    "clientHost" TEXT,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_change_pkey" PRIMARY KEY ("id")
);

-- A person's own waiting changes, oldest first.
CREATE INDEX "pending_change_proposedByPersonId_proposedAt_idx" ON "pending_change"("proposedByPersonId", "proposedAt");

-- The purge scan.
CREATE INDEX "pending_change_expiresAt_idx" ON "pending_change"("expiresAt");
