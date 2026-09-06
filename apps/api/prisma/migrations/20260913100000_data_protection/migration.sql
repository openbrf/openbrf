-- The association's own data protection obligations as controller:
-- the personal data breach register (GDPR art. 33), the record of processing
-- activities (art. 30), the classification of every recipient of personal data
-- and the agreements art. 28 requires, and the requests a person makes about
-- their own data (art. 17, 18 and 21).
--
-- Service tier throughout. No append-only trigger and no REVOKE in
-- sql/harden-runtime-role.sql: art. 33(5) and art. 30 require these records to
-- be kept and to be correctable, and nothing in BRL or EFL makes them statutory
-- archive. Rows are closed with a date rather than deleted, which is why every
-- table carries an endedAt, a closedAt or both.
--
-- The two foreign keys are deliberate and different. A breach subject cascades
-- from its breach, because the row is part of the breach record and means
-- nothing without it. A data subject request restricts deletion of its person,
-- because the request is about that person and must not be able to outlive them
-- silently. Every other person reference here is a plain column, so that no
-- referential action can rewrite a record or veto an erasure.
--
-- issue.closedAt is backfilled from updatedAt for issues already closed. It is
-- an approximation for rows written before the column existed, and the honest
-- one available: the alternative is a null that would keep those issues out of
-- the retention clock for ever.

-- CreateEnum
CREATE TYPE "BreachRisk" AS ENUM ('UNLIKELY', 'LIKELY', 'HIGH');

-- CreateEnum
CREATE TYPE "LegalBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'VITAL_INTERESTS', 'PUBLIC_TASK', 'LEGITIMATE_INTEREST');

-- CreateEnum
CREATE TYPE "ProcessingActivitySource" AS ENUM ('STATUTORY_REGISTER', 'SERVICE_DATA', 'PLUGIN', 'BOARD');

-- CreateEnum
CREATE TYPE "ProcessorKind" AS ENUM ('SMTP', 'SMS', 'STORAGE', 'HOSTING', 'PLUGIN', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ProcessorClassification" AS ENUM ('PROCESSOR', 'NOT_A_PROCESSOR', 'INDEPENDENT_CONTROLLER');

-- CreateEnum
CREATE TYPE "ProcessorAgreementStatus" AS ENUM ('IN_PLACE', 'PENDING');

-- CreateEnum
CREATE TYPE "DataSubjectRequestKind" AS ENUM ('ERASURE', 'OBJECTION', 'RESTRICTION');

-- CreateEnum
CREATE TYPE "DataSubjectRequestDecision" AS ENUM ('GRANTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ErasureGround" AS ENUM ('NO_LONGER_NECESSARY', 'CONSENT_WITHDRAWN', 'OBJECTION_UPHELD', 'UNLAWFUL_PROCESSING', 'LEGAL_OBLIGATION_TO_ERASE');

-- CreateEnum
CREATE TYPE "ErasureException" AS ENUM ('NONE', 'LEGAL_OBLIGATION_TO_KEEP', 'LEGAL_CLAIMS');


-- AlterTable
ALTER TABLE "association" ADD COLUMN     "controllerContactEmail" TEXT,
ADD COLUMN     "controllerPostalAddress" TEXT,
ADD COLUMN     "dataProtectionOfficerEmail" TEXT,
ADD COLUMN     "dataProtectionOfficerName" TEXT,
ADD COLUMN     "dataProtectionOfficerPhone" TEXT,
ADD COLUMN     "jointControllerContact" TEXT,
ADD COLUMN     "jointControllerName" TEXT;

-- AlterTable
ALTER TABLE "issue" ADD COLUMN     "closedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "person" ADD COLUMN     "communicationObjectionAt" TIMESTAMP(3),
ADD COLUMN     "processingRestrictedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "personal_data_breach" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL,
    "personalDataCategories" TEXT[],
    "dataSubjectCategories" TEXT[],
    "dataDescription" TEXT NOT NULL,
    "affectedCount" INTEGER,
    "effects" TEXT NOT NULL,
    "measures" TEXT NOT NULL,
    "risk" "BreachRisk",
    "imyNotificationRequired" BOOLEAN,
    "imyDecisionGround" TEXT,
    "imyNotifiedAt" TIMESTAMP(3),
    "imyReference" TEXT,
    "delayReasons" TEXT,
    "subjectsInformationRequired" BOOLEAN,
    "subjectsDecisionGround" TEXT,
    "subjectsInformedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByPersonId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedByPersonId" TEXT,
    "recordedByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_data_breach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_data_breach_subject" (
    "id" TEXT NOT NULL,
    "breachId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "informedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_data_breach_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_activity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "legalBasis" "LegalBasis" NOT NULL,
    "legalBasisNote" TEXT,
    "dataSubjectCategories" TEXT[],
    "personalDataCategories" TEXT[],
    "recipients" TEXT,
    "thirdCountryTransfer" BOOLEAN NOT NULL DEFAULT false,
    "thirdCountrySafeguards" TEXT,
    "retention" TEXT NOT NULL,
    "securityMeasures" TEXT,
    "source" "ProcessingActivitySource" NOT NULL,
    "sourceKey" TEXT,
    "endedAt" TIMESTAMP(3),
    "recordedByPersonId" TEXT,
    "updatedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processor_agreement" (
    "id" TEXT NOT NULL,
    "processorKind" "ProcessorKind" NOT NULL,
    "processorKey" TEXT NOT NULL,
    "classification" "ProcessorClassification" NOT NULL,
    "status" "ProcessorAgreementStatus",
    "counterparty" TEXT,
    "reference" TEXT,
    "signedOn" DATE,
    "termsConfirmed" BOOLEAN,
    "subProcessorsAuthorised" BOOLEAN,
    "subProcessorNote" TEXT,
    "note" TEXT,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "endedByPersonId" TEXT,
    "recordedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processor_agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_subject_request" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "DataSubjectRequestKind" NOT NULL,
    "requestedOn" DATE NOT NULL,
    "ground" TEXT NOT NULL,
    "erasureGround" "ErasureGround",
    "issueId" TEXT,
    "decision" "DataSubjectRequestDecision",
    "erasureException" "ErasureException",
    "decisionGround" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByPersonId" TEXT,
    "executedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "closedByPersonId" TEXT,
    "recordedByPersonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_subject_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personal_data_breach_discoveredAt_idx" ON "personal_data_breach"("discoveredAt");

-- CreateIndex
CREATE INDEX "personal_data_breach_decidedAt_closedAt_idx" ON "personal_data_breach"("decidedAt", "closedAt");

-- CreateIndex
CREATE INDEX "personal_data_breach_subject_personId_idx" ON "personal_data_breach_subject"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "personal_data_breach_subject_breachId_personId_key" ON "personal_data_breach_subject"("breachId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "processing_activity_sourceKey_key" ON "processing_activity"("sourceKey");

-- CreateIndex
CREATE INDEX "processing_activity_source_endedAt_idx" ON "processing_activity"("source", "endedAt");

-- CreateIndex
CREATE INDEX "processor_agreement_processorKind_processorKey_endedAt_idx" ON "processor_agreement"("processorKind", "processorKey", "endedAt");

-- CreateIndex
CREATE INDEX "data_subject_request_personId_kind_closedAt_idx" ON "data_subject_request"("personId", "kind", "closedAt");

-- CreateIndex
CREATE INDEX "data_subject_request_kind_decision_closedAt_idx" ON "data_subject_request"("kind", "decision", "closedAt");

-- CreateIndex
CREATE INDEX "data_subject_request_issueId_idx" ON "data_subject_request"("issueId");

-- CreateIndex
CREATE INDEX "document_uploadedByPersonId_idx" ON "document"("uploadedByPersonId");

-- CreateIndex
CREATE INDEX "media_file_uploadedByPersonId_idx" ON "media_file"("uploadedByPersonId");

-- AddForeignKey
ALTER TABLE "personal_data_breach_subject" ADD CONSTRAINT "personal_data_breach_subject_breachId_fkey" FOREIGN KEY ("breachId") REFERENCES "personal_data_breach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: issues already closed get the best available closing date.
UPDATE "issue" SET "closedAt" = "updatedAt" WHERE "status" = 'DONE';
