-- How the object at a stored file's storage key is held (ADR 0015).
--
-- A new type, so it is created and used in this one migration: the rule that a
-- value added to an existing enum cannot be used in the transaction that added
-- it concerns ALTER TYPE ... ADD VALUE, not CREATE TYPE.
CREATE TYPE "MediaEncryption" AS ENUM ('NONE', 'SECRETSTREAM_64K');

-- Every row written before this migration holds its bytes as uploaded. The
-- default exists only to give those rows their value and is dropped at once: a
-- row written from now on states how its bytes are held, so a way of writing
-- one that forgets to encrypt fails instead of storing a file in the clear.
ALTER TABLE "media_file"
  ADD COLUMN "encryption" "MediaEncryption" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "dataKeyCipher" TEXT;
ALTER TABLE "media_file" ALTER COLUMN "encryption" DROP DEFAULT;

-- An encrypted file has a wrapped key, and a file that is not encrypted has
-- none.
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_key_matches_encryption"
  CHECK (("encryption" = 'NONE') = ("dataKeyCipher" IS NULL));
