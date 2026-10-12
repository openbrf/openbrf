-- One consent per member and app.
--
-- The sign-in library records a consent by looking for the member's row for
-- the app and then updating it or inserting one. The two steps are not atomic,
-- so two consent submissions arriving together - two tabs, a double click -
-- could each find nothing and each insert, and nothing in the table refused the
-- second row. The token resolver then read whichever of the two it happened to
-- get, which could be the broader and older grant.
--
-- The unique index makes the second insert fail instead. Before it can be
-- built, the duplicates already here are merged into one row per member and
-- app, holding only what every one of them grants: the grant a racing pair
-- left behind is unknowable, and the side that can still be corrected is the
-- narrower one, since a member who finds an app asking again can consent again.
--
-- The earliest row is the one kept. A token stands only while a consent at
-- least as old as the token does, and keeping a later row would end every
-- token issued between the two.
--
-- Locked for the length of the migration so that a consent given while it runs
-- cannot add a duplicate between the merge and the index.
LOCK TABLE "auth_oauth_consent" IN SHARE ROW EXCLUSIVE MODE;

UPDATE "auth_oauth_consent" AS kept
SET
  "scopes" = ARRAY(
    SELECT granted.value
    FROM unnest(kept."scopes") WITH ORDINALITY AS granted(value, position)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "auth_oauth_consent" AS other
      WHERE other."userId" = kept."userId"
        AND other."clientId" = kept."clientId"
        AND NOT (granted.value = ANY (COALESCE(other."scopes", ARRAY[]::TEXT[])))
    )
    ORDER BY granted.position
  ),
  "resources" = ARRAY(
    SELECT granted.value
    FROM unnest(kept."resources") WITH ORDINALITY AS granted(value, position)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "auth_oauth_consent" AS other
      WHERE other."userId" = kept."userId"
        AND other."clientId" = kept."clientId"
        AND NOT (granted.value = ANY (COALESCE(other."resources", ARRAY[]::TEXT[])))
    )
    ORDER BY granted.position
  ),
  "requestedUserInfoClaims" = ARRAY(
    SELECT granted.value
    FROM unnest(kept."requestedUserInfoClaims") WITH ORDINALITY AS granted(value, position)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "auth_oauth_consent" AS other
      WHERE other."userId" = kept."userId"
        AND other."clientId" = kept."clientId"
        AND NOT (granted.value = ANY (COALESCE(other."requestedUserInfoClaims", ARRAY[]::TEXT[])))
    )
    ORDER BY granted.position
  ),
  "updatedAt" = (
    SELECT max(other."updatedAt")
    FROM "auth_oauth_consent" AS other
    WHERE other."userId" = kept."userId"
      AND other."clientId" = kept."clientId"
  )
WHERE EXISTS (
    SELECT 1
    FROM "auth_oauth_consent" AS other
    WHERE other."userId" = kept."userId"
      AND other."clientId" = kept."clientId"
      AND other."id" <> kept."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "auth_oauth_consent" AS earlier
    WHERE earlier."userId" = kept."userId"
      AND earlier."clientId" = kept."clientId"
      AND (earlier."createdAt", earlier."id") < (kept."createdAt", kept."id")
  );

DELETE FROM "auth_oauth_consent" AS later
USING "auth_oauth_consent" AS kept
WHERE later."userId" = kept."userId"
  AND later."clientId" = kept."clientId"
  AND (kept."createdAt", kept."id") < (later."createdAt", later."id");

-- The unique index leads with the member, so it serves every lookup the
-- member's own index did.
DROP INDEX "auth_oauth_consent_userId_idx";

CREATE UNIQUE INDEX "auth_oauth_consent_userId_clientId_key" ON "auth_oauth_consent"("userId", "clientId");
