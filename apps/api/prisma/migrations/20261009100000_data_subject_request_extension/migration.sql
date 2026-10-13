-- GDPR art. 12(3): the two-month extension of a data subject request.
--
-- When the association extended, and what it told the person was the reason.
-- Both null on every request that has not been extended, which is all of the
-- ones that exist: nothing could record it before.

ALTER TABLE "data_subject_request" ADD COLUMN "extendedAt" TIMESTAMP(3);
ALTER TABLE "data_subject_request" ADD COLUMN "extensionReason" TEXT;
