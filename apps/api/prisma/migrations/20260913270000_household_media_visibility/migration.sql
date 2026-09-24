-- AlterEnum
--
-- Two visibilities keyed on an apartment rather than on a group. A file marked
-- TENANT_OWNERS is readable by whoever holds a MEMBER residency in force today
-- on the apartment the file names, HOUSEHOLD by whoever holds any residency in
-- force there, and either by a holder of the capability the file names, whose
-- every serve is written to the audit log. The apartment binder
-- (lagenhetsparm) is what needs them: the three visibilities that existed are
-- groups - anyone, any account, any member - and a household's papers are
-- readable by the people living in one home.
--
-- Adding the values is all this does. A statement in this migration that also
-- USED one of them would fail: PostgreSQL refuses to read an enum value added
-- in the transaction still adding it, and Prisma runs a migration in one. The
-- column on media_file that says which apartment, and the CHECK tying the two
-- together, are in the migration after this one for that reason.
ALTER TYPE "MediaVisibility" ADD VALUE 'TENANT_OWNERS';
ALTER TYPE "MediaVisibility" ADD VALUE 'HOUSEHOLD';
