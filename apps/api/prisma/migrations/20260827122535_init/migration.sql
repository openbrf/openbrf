-- CreateEnum
CREATE TYPE "ResidencyRole" AS ENUM ('MEMBER', 'RESIDENT');

-- CreateEnum
CREATE TYPE "BoardPositionType" AS ENUM ('CHAIR', 'BOARD_MEMBER', 'DEPUTY_BOARD_MEMBER');

-- CreateEnum
CREATE TYPE "SystemRoleType" AS ENUM ('ADMIN', 'PROPERTY_MANAGER');

-- CreateEnum
CREATE TYPE "SignupRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MemberRegisterEventType" AS ENUM ('ENTRY', 'EXIT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PROTECTED_DATA_REVEALED', 'PROTECTED_FLAG_CHANGED', 'MEMBER_REGISTER_EXTRACT_GENERATED', 'APARTMENT_REGISTER_EXTRACT_GENERATED', 'DATA_EXPORTED', 'SYSTEM_ROLE_GRANTED', 'SYSTEM_ROLE_REVOKED', 'PLUGIN_INSTALLED', 'PLUGIN_REMOVED', 'THEME_INSTALLED', 'THEME_ACTIVATED');

-- CreateTable
CREATE TABLE "association" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "organizationNumber" TEXT,
    "defaultLocale" TEXT NOT NULL DEFAULT 'sv',
    "logoPath" TEXT,
    "primaryColor" TEXT,
    "retentionDaysAfterMoveOut" INTEGER NOT NULL DEFAULT 730,
    "selfSignupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpUser" TEXT,
    "smtpPasswordCipher" TEXT,
    "smtpFromAddress" TEXT,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "activeThemeId" TEXT,
    "setupCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "association_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address" (
    "id" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apartment" (
    "id" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "floor" INTEGER,
    "participationShare" DECIMAL(12,8),
    "initialShareCapital" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "postalStreet" TEXT,
    "postalCode" TEXT,
    "postalCity" TEXT,
    "alternativePostalAddress" TEXT,
    "emailCipher" TEXT,
    "emailIndex" TEXT,
    "phoneCipher" TEXT,
    "phoneIndex" TEXT,
    "personalIdentityNumberCipher" TEXT,
    "personalIdentityNumberIndex" TEXT,
    "protectedPersonalData" BOOLEAN NOT NULL DEFAULT false,
    "preferredLocale" TEXT NOT NULL DEFAULT 'sv',
    "emailVisibleToResidents" BOOLEAN NOT NULL DEFAULT false,
    "phoneVisibleToResidents" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residency" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "role" "ResidencyRole" NOT NULL,
    "movedInOn" DATE NOT NULL,
    "movedOutOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "residency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_position" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "position" "BoardPositionType" NOT NULL,
    "electedOn" DATE NOT NULL,
    "endedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_role" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "SystemRoleType" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_request" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "emailCipher" TEXT NOT NULL,
    "emailIndex" TEXT NOT NULL,
    "phoneCipher" TEXT,
    "claimedAddress" TEXT NOT NULL,
    "claimedApartmentNumber" TEXT NOT NULL,
    "matchedApartmentId" TEXT,
    "status" "SignupRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_register_entry" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "apartmentId" TEXT,
    "eventType" "MemberRegisterEventType" NOT NULL,
    "eventOn" DATE NOT NULL,
    "recordedFirstName" TEXT NOT NULL,
    "recordedLastName" TEXT NOT NULL,
    "recordedPostalStreet" TEXT,
    "recordedPostalCode" TEXT,
    "recordedPostalCity" TEXT,
    "note" TEXT,
    "correctsEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_register_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "fromPersonId" TEXT,
    "toPersonId" TEXT NOT NULL,
    "transferredOn" DATE NOT NULL,
    "price" DECIMAL(14,2),
    "agreementDocumentPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lien_note" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "creditor" TEXT NOT NULL,
    "notedOn" DATE NOT NULL,
    "releasedOn" DATE,
    "amount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lien_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log_entry" (
    "id" TEXT NOT NULL,
    "actorPersonId" TEXT,
    "action" "AuditAction" NOT NULL,
    "targetPersonId" TEXT,
    "targetKind" TEXT,
    "targetId" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installed_plugin" (
    "id" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consentedPermissions" TEXT[],
    "declaredPersonalData" TEXT[],
    "settings" JSONB,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installed_plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installed_theme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "extendsThemeId" TEXT,
    "checksum" TEXT NOT NULL,
    "lightTokens" JSONB NOT NULL,
    "darkTokens" JSONB NOT NULL,
    "viewVariants" JSONB,
    "fonts" JSONB,
    "logoPath" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installed_theme_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "address_street_number_key" ON "address"("street", "number");

-- CreateIndex
CREATE UNIQUE INDEX "apartment_addressId_number_key" ON "apartment"("addressId", "number");

-- CreateIndex
CREATE INDEX "person_emailIndex_idx" ON "person"("emailIndex");

-- CreateIndex
CREATE INDEX "person_phoneIndex_idx" ON "person"("phoneIndex");

-- CreateIndex
CREATE INDEX "person_personalIdentityNumberIndex_idx" ON "person"("personalIdentityNumberIndex");

-- CreateIndex
CREATE INDEX "person_lastName_firstName_idx" ON "person"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "residency_apartmentId_movedOutOn_idx" ON "residency"("apartmentId", "movedOutOn");

-- CreateIndex
CREATE INDEX "residency_personId_movedOutOn_idx" ON "residency"("personId", "movedOutOn");

-- CreateIndex
CREATE INDEX "board_position_personId_endedOn_idx" ON "board_position"("personId", "endedOn");

-- CreateIndex
CREATE UNIQUE INDEX "system_role_personId_role_key" ON "system_role"("personId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_tokenHash_key" ON "invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "invitation_personId_idx" ON "invitation"("personId");

-- CreateIndex
CREATE INDEX "signup_request_status_idx" ON "signup_request"("status");

-- CreateIndex
CREATE INDEX "signup_request_emailIndex_idx" ON "signup_request"("emailIndex");

-- CreateIndex
CREATE INDEX "member_register_entry_personId_eventOn_idx" ON "member_register_entry"("personId", "eventOn");

-- CreateIndex
CREATE INDEX "member_register_entry_apartmentId_eventOn_idx" ON "member_register_entry"("apartmentId", "eventOn");

-- CreateIndex
CREATE INDEX "transfer_apartmentId_transferredOn_idx" ON "transfer"("apartmentId", "transferredOn");

-- CreateIndex
CREATE INDEX "lien_note_apartmentId_releasedOn_idx" ON "lien_note"("apartmentId", "releasedOn");

-- CreateIndex
CREATE INDEX "audit_log_entry_actorPersonId_createdAt_idx" ON "audit_log_entry"("actorPersonId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entry_targetPersonId_createdAt_idx" ON "audit_log_entry"("targetPersonId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entry_action_createdAt_idx" ON "audit_log_entry"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "apartment" ADD CONSTRAINT "apartment_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "address"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residency" ADD CONSTRAINT "residency_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residency" ADD CONSTRAINT "residency_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_position" ADD CONSTRAINT "board_position_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_role" ADD CONSTRAINT "system_role_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_request" ADD CONSTRAINT "signup_request_matchedApartmentId_fkey" FOREIGN KEY ("matchedApartmentId") REFERENCES "apartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_register_entry" ADD CONSTRAINT "member_register_entry_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_register_entry" ADD CONSTRAINT "member_register_entry_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_fromPersonId_fkey" FOREIGN KEY ("fromPersonId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_toPersonId_fkey" FOREIGN KEY ("toPersonId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lien_note" ADD CONSTRAINT "lien_note_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- audit_log_entry."actorPersonId" and "targetPersonId" carry no foreign key on
-- purpose. Every referential action rewrites the audit log: SET NULL and SET
-- DEFAULT issue an UPDATE, CASCADE a DELETE, and the append-only trigger added
-- in the next migration rejects both, so deleting a person the log names would
-- fail. RESTRICT would instead let the log veto erasure. The log is evidence:
-- it keeps the id that acted, even once that person is gone.
