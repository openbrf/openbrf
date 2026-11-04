-- The private link mailed to the reporter of an issue who has no account
-- (decision 20 of the issue module plan, ADR 0055).
--
-- The token is never stored: only its SHA-256 digest, unique, which is what a
-- request is looked up by. One link per issue at most.
CREATE TABLE "issue_reporter_link" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mailedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "issue_reporter_link_pkey" PRIMARY KEY ("id"),
    -- A SHA-256 digest in unpadded base64url is 43 characters of that
    -- alphabet. Anything else is not a digest, and a column that could hold
    -- the token itself is the one mistake this table must not allow.
    CONSTRAINT "issue_reporter_link_digest_shape" CHECK ("tokenDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX "issue_reporter_link_issueId_key" ON "issue_reporter_link"("issueId");

CREATE UNIQUE INDEX "issue_reporter_link_tokenDigest_key" ON "issue_reporter_link"("tokenDigest");

CREATE INDEX "issue_reporter_link_issuedAt_idx" ON "issue_reporter_link"("issuedAt");

ALTER TABLE "issue_reporter_link" ADD CONSTRAINT "issue_reporter_link_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
