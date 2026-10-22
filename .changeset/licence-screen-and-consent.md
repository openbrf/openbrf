---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the licence screen, and make a paid plugin's licence part of what the board
consents to (ADR 0042).

- **Licence screen.** At `/licences`, for the administrator who installs
  plugins (`association:manage`). It shows the instance line to give the issuer
  when ordering a licence, and each licence entered with its check: verified,
  not yet checked, changed since it was entered, or its issuer's plugin no
  longer installed. It also shows what each licensed plugin finds today. The
  administrator enters a licence by choosing the file or pasting it, and
  removes one. From thirty days before a licence's last day the screen says when
  it ends, and it says when the instance key cannot be read, as after a restore
  under another encryption key. A support session reads the screen and changes
  nothing.
- **Consent to a licence.** A catalog entry now repeats a plugin's `licence`
  and `released`. The consent screen says that the plugin needs a licence from
  its issuer and does nothing without one, and names each service it may show
  the licence to. The install request echoes the declaration back. The instance
  records the entitlement and the services the board consented to, and refuses
  at start, with the new finding `licence-widened`, a version that reads another
  entitlement or names another service. The catalog marks a plugin that needs a
  licence.
- **Updates the licence does not cover.** When a release is published after
  the last release the licence held covers, the update screen says so before
  the board updates, and the command-line tool prints the same notice.

A licensed plugin installed before this release has no recorded consent to its
licence and is refused as `licence-widened` until it is installed again from
the catalog.
