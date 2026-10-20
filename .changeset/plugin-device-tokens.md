---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A plugin can now serve a screen in the stairwell, or any other device nobody
signs in to, without borrowing a person's session and without a public route
(ADR 0031).

A manifest declares `deviceRoutes`: paths under the plugin's own mount that
answer `GET` and `HEAD` to a device token and to nothing else. The plugin issues
a token through `host.devices`, only on a request from a board member who manages
the website, and the token reaches that one route of that one plugin. It is
stored as a digest, rate limited, and revoked at once from the plugin or from the
new Devices screen, where the board sees every live token on the instance and
when it was last used. A plugin with a device route may not read the address
book or the finances. `@Public()` on a plugin route still has no effect.

Device routes, and every path the board consented to as one that a later
version dropped or moved, are the only place the API sends CORS headers, so a
player packaged as a TV app can read them, the refusal that says its token is
gone included.
`OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE` (default 120) bounds what one device may
spend.

The catalog index gains version 2, which adds `deviceRoutes` to a plugin entry.
This instance reads versions 1 and 2. A version that adds or moves a device
route is held as `device-routes-widened` until the board consents again, and
one that drops a route revokes the tokens issued for it.
