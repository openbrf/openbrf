-- At most one import is applied at a time.
--
-- The claim that starts an apply was conditional on its own session only, so
-- two sessions holding the same file - two board members, or a second tab
-- opened because the first looked stuck - could both be applied. Each chunk
-- plans against the register as it stands, which does not include what the
-- other session's chunk has yet to commit, so both created the same people,
-- each with a residency and a member register ENTRY that cannot be deleted.
--
-- The index makes a second claim fail while one import is queued or running.
-- It indexes a constant, so every row it covers has the same key, and it
-- covers only the two states an import is in while it writes. Prisma cannot
-- express an index on an expression, so it has no counterpart in
-- schema.prisma; the ImportSession model's comment says so.
--
-- An install that already has more than one import in those states would fail
-- to build the index. The one that is furthest along is kept and the others
-- are recorded as interrupted, which is what the import screen already says of
-- an import that stopped: what it wrote is in the register, and the rest is
-- imported as a new file.
UPDATE "import_session"
SET "status" = 'FAILED', "failureReason" = 'apply-interrupted', "finishedAt" = now()
WHERE "status" IN ('QUEUED', 'APPLYING')
  AND "id" <> (
    SELECT "id" FROM "import_session"
    WHERE "status" IN ('QUEUED', 'APPLYING')
    ORDER BY ("status" = 'APPLYING') DESC, "createdAt", "id"
    LIMIT 1
  );

CREATE UNIQUE INDEX "import_session_one_apply" ON "import_session" ((true))
WHERE "status" IN ('QUEUED', 'APPLYING');
