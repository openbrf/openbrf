-- AlterEnum
--
-- Administratörer: an audience in the feed (ADR 0026) for the instance's
-- administrators and the board, so the board can write to the people who run
-- the instance and hear back from them in one place.
--
-- Adding the value is all this does. PostgreSQL refuses to read an enum value
-- added in the transaction still adding it, and Prisma runs a migration in one,
-- so the index that names it and the row are in the migration after this one.
ALTER TYPE "AudienceKind" ADD VALUE 'ADMIN';
