-- The text of a work order as a part of an issue the board weighs under GDPR
-- art. 15(4) for a person's access report (ADR 0057, question 7).
--
-- Its own migration because PostgreSQL will not let a value added to an enum
-- be used in the transaction that added it, and the checks that follow name
-- it.
ALTER TYPE "IssueAccessPart" ADD VALUE IF NOT EXISTS 'WORK_ORDER';
