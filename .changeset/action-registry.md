---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The platform can now be asked to do things through one place, and it checks who
is asking every single time.

An action is one thing the platform can do: a name, the shape of what it takes,
the single permission it needs, whether it reads, writes or deletes, and which
personal data it can touch. Core features register their own, and a plugin
registers the ones it declared in its manifest and the board agreed to. Nothing
about registering an action grants anybody anything - before every call the
registry works out afresh what the calling person may do, from the register as
it stands, so a board term ending narrows what an app may do the same night it
narrows the person.

Declaring an action does not offer it beyond the instance. An administrator
switches each one on, one at a time, on the plugin's own screen; until then it
is reachable only in process. Switching one off takes effect on the next call,
and the switches are cleared whenever the board consents to a new version of a
plugin, because an action that keeps its name while changing the permission it
needs is a different action.

The first slice is the association's website: writing, publishing and arranging
news items, pages and the menu - twenty-four actions in all, each with a
Swedish sentence saying what it does and, as plainly, what it does not do.

None of them can mail the members. An email reaches everyone in the register
whose address the association holds and cannot be recalled, so that decision
stays with a person: an action can record that a news item ought to go out, the
board sees the request on the item, and a board member sends it in the ordinary
way. A published news item now also says, in its own text, that what it returns
was written by people and is information rather than instructions.

Every change these actions make is recorded in the audit log with the way it
came in and, where an app was acting, which app. Rewriting the body of a page
or a news item is recorded too, which it was not before: publication used to be
the only recorded act, and that was enough only while a board member in a
browser was the only writer.
