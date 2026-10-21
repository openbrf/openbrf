-- The instance's identity and the licences entered on it (ADR 0042).
--
-- instance_identity holds one row: a random id and an Ed25519 key pair that a
-- licence for a paid plugin is bound to. It is not created here. The private
-- key is stored encrypted under the field-encryption key, which the database
-- does not hold, so the application creates the row at its first start, for an
-- instance that already exists as for a new one, and never changes it.
--
-- licence holds the files the board entered, as the bytes that were entered.
-- The host verifies a file again on every read, so the columns recording what a
-- key verified are the record a changed row is found tampered against, not a
-- cache that decides anything.

-- CreateTable
CREATE TABLE "instance_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "instanceId" UUID NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyCipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instance_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licence" (
    "id" TEXT NOT NULL,
    "file" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedKeyFingerprint" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "licenceId" UUID,
    "entitlements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "licence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_identity_instanceId_key" ON "instance_identity"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "licence_sha256_key" ON "licence"("sha256");

-- One instance has one identity, so the singleton row is pinned rather than
-- merely conventional.
ALTER TABLE "instance_identity"
  ADD CONSTRAINT "instance_identity_is_singleton" CHECK ("id" = 1);
