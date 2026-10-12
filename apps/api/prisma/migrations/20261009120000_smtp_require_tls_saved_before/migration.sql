-- Requires STARTTLS of the board's SMTP server on settings saved before saving
-- required it (20260928120000_smtp_require_tls left them false). The rule is the
-- save's (SettingsService.updateSmtp): true unless no host is stored or the host
-- is on loopback, compared exactly as isLoopbackHost compares it.
--
-- A server that offers no STARTTLS stops receiving mail from here on, and a send
-- to it fails with the reason mail-tls-unavailable, rather than the password
-- going to it in the clear.
UPDATE "association"
SET "smtpRequireTls" = true
WHERE NOT "smtpRequireTls"
  AND "smtpHost" IS NOT NULL
  AND "smtpHost" NOT IN ('localhost', '127.0.0.1', '[::1]', '::1');
