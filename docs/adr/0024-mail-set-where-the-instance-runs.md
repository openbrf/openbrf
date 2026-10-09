# ADR 0024: Mail set where the instance runs

Date: 2026-09-27

## Status

Accepted

## Context

An instance sends invitations, sign-in links, notices, the board mailbox's
answers and every other message through one transport: an SMTP server the board
enters in the setup wizard or the settings, stored on the association's row with
the password encrypted (`apps/api/src/settings/settings.service.ts`,
`updateSmtp`). Nothing else could set it.

On an instance somebody else runs for the association, that somebody answers for
delivery and for the sending domain's SPF, DKIM and DMARC. A board that could
replace the transport from the settings screen would be the first to find out it
had broken either, and nothing on the instance would say so before a bounce.

The service a host sends through may offer an HTTP API before it offers SMTP.
The common shape takes a message as JSON with a bearer key and answers with the
id it gave the message. A service of that shape owns the `Message-ID` header: it
refuses one from the caller and writes its own from that id, as
`<id>@<its domain>`. It passes `In-Reply-To` and `References` through.

The board mailbox threads by `Message-ID`. An answer is given an identifier
before it is handed over, the identifier is stored on the answer's row, and the
collector recognises a copy of the answer and joins a correspondent's reply to
its thread by finding the identifier the reply names in `In-Reply-To` on a row of
that thread (`apps/api/src/board-mailbox/board-mailbox-collector.service.ts`).
An answer delivered under an identifier the row does not hold is a reply that
opens a new thread.

Hosted associations start on one sending domain they share. The sender's address
is then not on the association's own domain, so the association's name and a
Reply-To to the association are what tell a correspondent who wrote and where
an answer goes.

## Decision

### The environment chooses the driver, and wins

`OPENBRF_MAIL_DRIVER` is `settings` (the default: what the board enters, as
before), `smtp` or `http-api`. A driver set in the environment is used for every
message and locks the settings: `GET /api/settings` reports the mail with
`source: "environment"`, the host it goes through and the sender, and no user,
port or password field; `PUT /api/settings/smtp` answers 409
`mail-managed-by-environment` and writes nothing. SMTP settings a board stored
before stay in their columns and apply again once the environment chooses no
driver.

Each driver's variables are checked at boot (`apps/api/src/config/env.ts`):

| Variable                                     | Driver               | Meaning                                                                          |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `OPENBRF_MAIL_FROM_ADDRESS`                  | both, required       | the sender's bare address                                                        |
| `OPENBRF_MAIL_FROM_NAME`                     | both                 | the display name, one line, not blank, at most 255 characters                    |
| `OPENBRF_MAIL_REPLY_TO`                      | both                 | the Reply-To for messages that name none                                         |
| `OPENBRF_SMTP_HOST`                          | `smtp`, required     |                                                                                  |
| `OPENBRF_SMTP_PORT`                          | `smtp`               | 465 with implicit TLS, 587 without                                               |
| `OPENBRF_SMTP_SECURE`                        | `smtp`               | implicit TLS, `true` or `false` exactly; unset is false                          |
| `OPENBRF_SMTP_REQUIRE_TLS`                   | `smtp`               | STARTTLS before the sign-in, `true` or `false`; unset, required off loopback     |
| `OPENBRF_SMTP_USER`, `OPENBRF_SMTP_PASSWORD` | `smtp`               | both or neither                                                                  |
| `OPENBRF_MAIL_API_URL`                       | `http-api`, required | https, or http on loopback; no credentials, query or fragment; a path is allowed |
| `OPENBRF_MAIL_API_KEY`                       | `http-api`, required | the bearer key                                                                   |
| `OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN`         | `http-api`, required | the domain the service writes its `Message-ID` under                             |

A variable of a driver other than the chosen one is a boot error naming it,
including every one of them under `settings`: a configuration half switched from
one driver to another is a mistake, and one ignored without a word would send
through something the operator did not mean.

The secrets are in the environment in plain text, as the S3 keys are: the
operator supplies them where the instance runs. A secret the board types is
encrypted at rest, as before.

### One resolver

`MailSettingsResolver` (`apps/api/src/mail/mail-settings.ts`) answers which mail
the instance uses: `current()` for sending, with the stored password decrypted
when the settings decide, and `describe()` - source, driver, host and sender,
decrypting nothing - for the settings screen and for `ProcessorFactsService`.
The processor register's mail row and the mail rows of the record of processing
activities therefore name the host mail actually goes through: the environment's
SMTP host, or the mail API's host.

The register keys the mail row by driver, because the three are different
parties: `smtp` (kind `SMTP`) for the server the board entered, `hostSmtp`
(`HOST_SMTP`) for the environment's SMTP relay and `mailApi` (`MAIL_API`) for the
mail API. An agreement the board recorded with its own provider stays under
`smtp`, is not listed while the environment chooses the mail, and applies again
once the settings do. Rows under `smtp` are not migrated: no release let the
environment choose the mail before the keys were split, so every one describes
the board's own server.

### Two drivers behind one interface

`MailDriver` (`apps/api/src/mail/mail-driver.ts`) takes a sender as a name and an
address, one recipient, the subject, the HTML and plain-text bodies, a Reply-To,
the message's own identifier and the one it answers - named fields and no header
bag - and reports `SentMail { messageId }`, the identifier the message was
delivered with. `SmtpMailDriver` holds the nodemailer transport and its timeouts;
`HttpApiMailDriver` speaks this wire contract:

```
POST <OPENBRF_MAIL_API_URL>/emails
Authorization: Bearer <OPENBRF_MAIL_API_KEY>
Content-Type: application/json
Idempotency-Key: <the caller's message identifier, or a random UUID>

{"from": "\"<display name>\" <address>", "to": ["..."], "subject": "...",
 "html": "...", "text": "...", "reply_to": ["..."],
 "headers": {"In-Reply-To": "<...>", "References": "<...>"}}

2xx {"id": "<id>"}  ->  delivered as Message-ID <id@OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN>
```

- The display name is a quoted string with `"` and `\` escaped; `reply_to` and
  each header only when set.
- The subject is one line. The mail service replaces every run of control
  characters in it with a space before any driver sees it, because an answer's
  subject quotes one an outside sender wrote, and a service may write the field
  into the header as it is given.
- `Message-ID` is never sent. The driver reports `<id>@<domain>` from the
  response's `id`, and none for a 2xx without one.
- The idempotency key is the caller's identifier where there is one, so a
  retried board mailbox answer is sent once for as long as the service keeps the
  key.
- Any other status is a failure carrying the status and never the body, which
  quotes the recipient back. A redirect is not followed and is a failure. The
  whole request is bounded at 20 seconds, the SMTP socket's bound.

A driver written against one vendor's own API is a sibling file and a branch in
the selection.

`SmtpMailDriver` requires STARTTLS before it signs in to the environment's relay,
unless the relay is on loopback, so a relay whose offer of STARTTLS an attacker
on the path strips gets no password in the clear. `OPENBRF_SMTP_REQUIRE_TLS=false`
lets a host vouch for the network to a relay that offers none, such as a sidecar
on the Compose network, and the instance logs a warning at start while it is set.
A server the board enters is held to the same rule from the save on: every save of
the SMTP settings stores `smtpRequireTls`, true unless the host is on loopback,
whichever field changed.
Settings saved before that are migrated to the same rule: the upgrade sets
`smtpRequireTls` on every row whose host is not on loopback. A connection that
starts in cleartext to a server that offers no STARTTLS then stops sending mail
until the board switches to implicit TLS or a port that offers STARTTLS. A row
with implicit TLS is unaffected: its connection never asks for STARTTLS. A row that does not require it
anyway, such as one a data-only restore of an older backup brought back, is
used as stored. The SMTP card warns that the password can go out unencrypted
until the board saves the settings again, and the instance logs a warning
naming the host and port, never the user or the password, the first time it
sends through it. Where STARTTLS is required, a send that finds no TLS fails
with the reason `mail-tls-unavailable`, which the card explains as a port and
TLS mode to fix rather than a password.

_Amended 2026-10-09._ Settings saved before saving required TLS were first left
as they were and only flagged, so that an instance whose server offers no
STARTTLS would not lose its mail with nothing on screen to say why. That left a
password that could go out in the clear for as long as nobody opened the SMTP
card, and an attacker on the path who strips STARTTLS is not something a board
would notice. A send that fails says why, on the card's test message and in the
reason `mail-tls-unavailable`, so the migration trades a silent exposure for a
failure that names its fix. The SMTP driver
also reports the `Message-ID` it handed over as the delivered one, so the
environment's relay must keep it; one that rewrites it belongs behind
`http-api`.

### The sender a host sets

With a driver set in the environment the mail service gives every message the
display name `OPENBRF_MAIL_FROM_NAME`, or else the association's registered name,
read at each send and kept to one line. A message that names its own Reply-To
keeps it; otherwise the Reply-To is `OPENBRF_MAIL_REPLY_TO`, or else the board
mailbox's published address while the board mailbox is configured, or else none.
With `settings`, the sender and the Reply-To are as the board configured them,
with nothing added.

### The delivered identifier is the one the board mailbox keeps

An answer is still handed over with the identifier minted for it, and with
`In-Reply-To` and `References` naming the letter it answers. When the answer is
marked sent, the identifier it was delivered with replaces the minted one on its
row where the two differ
(`apps/api/src/board-mailbox/board-mailbox-mailer.service.ts`). The collector
then recognises a copy of the answer and joins the correspondent's reply to its
thread, because both carry the identifier the service wrote. A send that reports
no identifier leaves the minted one, and the log line names the reply and says
threading may fail.

## Consequences

- A board on an instance whose mail is set in the environment cannot change its
  mail, and the settings and the setup wizard say who sends it, through which
  host and from which address.
- Emptying `OPENBRF_MAIL_DRIVER` restores the SMTP settings the board stored.
- Associations sending from one shared domain share its reputation: one
  association's complaints weigh on all of them. Unless the host sets
  `OPENBRF_MAIL_FROM_NAME`, the display name is the one the board registered, so
  a board can send under another association's name from the shared domain. A correspondent sees the shared
  address under the association's name, and one who answers the address rather
  than the Reply-To writes to the shared address.
- DMARC holds: the sender is on the domain the service has verified, and a
  Reply-To needs no alignment.
- The processor register and the record of processing activities name the mail
  API's host, and the board classifies it as it classifies an SMTP provider -
  as a recipient of its own, with no agreement carried over from the board's
  server.
- The instance sees no delivery events from the service; what it knows is that
  the service accepted the message.
- The board mailbox is still collected over POP3. Collecting it through a
  service's inbound API, and an association's own sending domain, are not part
  of this decision.
