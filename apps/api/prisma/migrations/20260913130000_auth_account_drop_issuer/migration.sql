-- Better Auth identifies an account by `providerId` and `accountId` and writes
-- no issuer from 1.7.3 on, so a NOT NULL `issuer` column refuses every account
-- the application creates. Every existing row holds the issuer derived from the
-- credential provider, which nothing reads, so the column is dropped rather than
-- left behind nullable.
ALTER TABLE "auth_account" DROP COLUMN "issuer";
