-- Support access the administrator opens (ADR 0028).
--
-- support_access is the administrator's instruction: who opened it, when, until
-- when, and who closed it by hand. support_session is one supporter's way in
-- under it, with the digests of its sign-in token and session token and never
-- either token.
--
-- Neither table is purged. The audit entries name these rows, and the log has
-- to be able to resolve a reference for as long as it keeps the entry. The
-- person columns are plain columns, as the audit log's are, so that erasing the
-- administrator neither rewrites nor vetoes the record of what they instructed.

-- CreateTable
CREATE TABLE "support_access" (
    "id" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "openedUnderGrantId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "support_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_session" (
    "id" TEXT NOT NULL,
    "accessId" TEXT NOT NULL,
    "supporter" TEXT NOT NULL,
    "signInTokenHash" TEXT NOT NULL,
    "signInExpiresAt" TIMESTAMP(3) NOT NULL,
    "sessionTokenHash" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "support_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_access_openedAt_idx" ON "support_access"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_session_signInTokenHash_key" ON "support_session"("signInTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "support_session_sessionTokenHash_key" ON "support_session"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "support_session_accessId_idx" ON "support_session"("accessId");

-- AddForeignKey
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_accessId_fkey" FOREIGN KEY ("accessId") REFERENCES "support_access"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
