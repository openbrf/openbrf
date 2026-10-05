---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Name the mail recipient in the processor register by the mail the instance
actually sends through.

The register listed the mail as "Mail server" under the key `smtp` whichever
driver `OPENBRF_MAIL_DRIVER` chose. With the mail set in the environment, an
agreement the board had recorded with its own former provider was shown against
the host's SMTP relay or HTTP mail API, which it does not cover.

The mail row is now one of three recipients, each with its own key and label:
the server the board entered (`smtp`, "Mail server"), the host's SMTP relay
(`hostSmtp`, "Host's mail server") and the host's mail API (`mailApi`, "Host's
mail API"). While the host's mail is in use, the host's service is a recipient
the board has not classified yet, and the board's own agreement is not listed.
That agreement stays recorded and applies again once the board's settings send
the mail. Existing rows are not migrated: every row under `smtp` describes the
board's own server.
