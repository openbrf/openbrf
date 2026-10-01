-- Whether the board's SMTP server must upgrade through STARTTLS before the
-- sign-in. Every save writes it; a row saved before keeps false, so a server
-- that offers no STARTTLS keeps sending, and the SMTP card flags it.
ALTER TABLE "association" ADD COLUMN "smtpRequireTls" BOOLEAN NOT NULL DEFAULT false;
