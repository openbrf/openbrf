---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A member can now let an app they chose act for them, and take it back.

A connected app is an external program - a chat client, an assistant, something
the association had written - that a member points at their own instance and
signs in to as themselves. It holds a token rather than the member's password,
and what it can do is exactly what that member can do: the token is looked up on
every call and the member's own permissions are read again from the register
each time. Nothing is remembered from when they connected it. A board term
ending therefore narrows every app that person connected on the same night it
narrows the person.

Connecting is the member's own decision and needs no permission from anybody.
Cutting a connection takes effect on the app's next call, not when its token
would have run out: the board sees every connection on the instance and can cut
any of them, and a member sees and cuts their own. Every connection made or cut
by somebody else is in the audit log, against the member, naming the app.

An app is told nothing about who it is acting for. It receives no name and no
address, only the ability to ask the platform to do things the member could
already do.

The address an app actually talks to belongs to a connector plugin, not to the
platform, so an instance needs one installed before anything can connect. Only
one plugin may serve it, and a second is refused when it is installed rather
than after: that address is what every token already granted is bound to, and
moving it would break every connection the members have.

Two settings matter to whoever runs the instance. `APP_URL` must now be an
https address or a loopback one, and the instance says so and stops rather than
failing later in a way that is hard to read. Changing it afterwards disconnects
every connected app, because a token issued for one address is not accepted at
another - members reconnect, and nothing is lost.
