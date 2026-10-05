-- The mail an instance sends through is one of three recipients, not one: the
-- SMTP server the board entered, or the SMTP relay or HTTP mail API the host
-- sets in the environment (ADR 0024). Each gets its own kind, so an agreement
-- the board recorded with its own provider is never shown against the host's.
--
-- No row moves. The "smtp" key keeps meaning the board's own server, which is
-- what every row under it describes: no release let the environment choose the
-- mail before this change. While the environment chooses it, such a row is
-- simply not listed, and it applies again once the board's settings do.
ALTER TYPE "ProcessorKind" ADD VALUE IF NOT EXISTS 'HOST_SMTP' AFTER 'SMTP';
ALTER TYPE "ProcessorKind" ADD VALUE IF NOT EXISTS 'MAIL_API' AFTER 'HOST_SMTP';
