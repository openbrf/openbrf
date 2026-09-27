-- The mailbox the board mailbox collects from is a recipient the configuration
-- names, so the processor register lists it beside the mail server and the
-- storage.
ALTER TYPE "ProcessorKind" ADD VALUE IF NOT EXISTS 'MAILBOX' AFTER 'HOSTING';
