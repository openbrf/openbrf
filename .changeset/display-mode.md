---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/plugin-sdk": minor
---

The display mode for screens (ADR 0050). A board member who manages the
website opens the new display screen, names a screen, chooses what it shows -
the news, the coming events, the notice of the next general meeting and free
and busy times for bookable resources - and how, and is given a display link,
once, as text and as a QR code. Opened in any browser on a screen in the
building, the link shows those in a rotation, refreshed every minute, with no
account and no sign-in. The choices are in the link and kept nowhere else; the
link's device token is listed on the devices screen under "Display mode",
where any board member who manages the website can revoke it, and the screen
then says that its display link is no longer valid.

A news item, and an event with all its dates, now has a "Show on screens" mark
in its editor, off on every item until the board sets it. Only published items
marked for screens are shown, and an item whose text names somebody in the
register, or an apartment number, is left out, as on every device. Setting or
clearing the mark is part of the item's own change in the audit log. Plugins
read the mark as `onScreens` on `PluginNewsItem` and `PluginOccurrence`.

The display link's token is a device token for the core's new display route,
`/api/display/`, with no plugin: it is refused on every plugin's device route,
and a plugin's token is refused there. Issuing and revoking one are
`DEVICE_TOKEN_ISSUED` and `DEVICE_TOKEN_REVOKED` entries with no plugin. The
screen content the route serves is the contract in
`docs/screen-content-contract.md`, which moved there from ADR 0034, and the
display page is built from the new `@openbrf/display` package.

The migration makes a device token's plugin optional, held to the display route
by a check, and adds the mark to news items and events, off on every existing
row, in one transaction. It runs on its own when the instance starts.
