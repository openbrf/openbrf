-- One Administratörer audience, as there is one Alla and one Styrelsen: its
-- members are derived from the system roles and the board's terms, so a second
-- row would be a second answer to who is in it.
CREATE UNIQUE INDEX "audience_one_admin" ON "audience" ("kind") WHERE "kind" = 'ADMIN';

INSERT INTO "audience" ("id", "kind", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'ADMIN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "audience" WHERE "kind" = 'ADMIN');
