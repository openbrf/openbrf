-- The apartment binder (lagenhetsparm): one binder per apartment, holding the
-- papers about that apartment - its drawings, the board's permissions for
-- alterations under BRL 7 kap. 7 §, the work done in it, inspections and
-- manuals. The entries belong to the apartment rather than to whoever filed
-- them, so a change of hands copies and moves nothing: the next household reads
-- the binder from the day its residency begins and the last one stops on the
-- day its residency ends.
--
-- The column on media_file says which apartment a file readable by a household
-- belongs to. It is separated from the migration that added the two visibility
-- values because PostgreSQL refuses to read an enum value added in the
-- transaction still adding it, and the CHECK below reads both.
--
-- ADR 0017 is the decision and the whole of the reasoning.

-- CreateEnum
CREATE TYPE "ApartmentDocumentKind" AS ENUM ('DRAWING', 'ALTERATION_PERMISSION', 'WORK_RECORD', 'INSPECTION', 'INSTRUCTIONS', 'OTHER');

-- CreateEnum
CREATE TYPE "ApartmentDocumentAudience" AS ENUM ('TENANT_OWNERS', 'HOUSEHOLD');

-- CreateEnum
CREATE TYPE "ApartmentDocumentFiler" AS ENUM ('BOARD', 'TENANT_OWNER');

-- AlterTable
ALTER TABLE "media_file" ADD COLUMN     "apartmentId" TEXT;

-- CreateTable
CREATE TABLE "apartment_document" (
    "id" TEXT NOT NULL,
    "apartmentId" TEXT NOT NULL,
    "kind" "ApartmentDocumentKind" NOT NULL,
    "audience" "ApartmentDocumentAudience" NOT NULL,
    "title" TEXT NOT NULL,
    "datedOn" DATE,
    "filedAs" "ApartmentDocumentFiler" NOT NULL,
    "filedByPersonId" TEXT,
    "mediaFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "apartment_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "apartment_document_mediaFileId_key" ON "apartment_document"("mediaFileId");

-- CreateIndex
CREATE INDEX "apartment_document_apartmentId_kind_idx" ON "apartment_document"("apartmentId", "kind");

-- CreateIndex
CREATE INDEX "apartment_document_filedByPersonId_idx" ON "apartment_document"("filedByPersonId");

-- CreateIndex
CREATE INDEX "media_file_apartmentId_idx" ON "media_file"("apartmentId");

-- AddForeignKey
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apartment_document" ADD CONSTRAINT "apartment_document_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apartment_document" ADD CONSTRAINT "apartment_document_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A file readable by one apartment's household names the apartment, and no
-- other file names one: a visibility that says "this apartment's household"
-- without saying which apartment is a file nobody can be decided about, and an
-- apartment on a file held any other way would be a second access rule that
-- never runs.
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_apartment_matches_visibility"
  CHECK (("visibility" IN ('TENANT_OWNERS', 'HOUSEHOLD')) = ("apartmentId" IS NOT NULL));

-- The board's permission under BRL 7 kap. 7 § is the board's own decision, and
-- it has the day the board took it. What the binder is worth to the next holder
-- is that "tillstand" means the board said so, so the pairing is held here
-- rather than only in the service: an entry of that kind filed as a
-- tenant-owner, or without its date, is not a state the table can be left in.
ALTER TABLE "apartment_document" ADD CONSTRAINT "apartment_document_permission_is_the_boards"
  CHECK ("kind" <> 'ALTERATION_PERMISSION' OR ("filedAs" = 'BOARD' AND "datedOn" IS NOT NULL));

-- A title is what the entry is called on the screen. Blank is not a name.
ALTER TABLE "apartment_document" ADD CONSTRAINT "apartment_document_title_is_not_blank"
  CHECK (btrim("title") <> '');
