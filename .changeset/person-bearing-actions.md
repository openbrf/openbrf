---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A connected app can now read and record what the association says about itself,
the comment threads under its notices and the motion queue the board works - and
the rules for an action that names a person are settled before the first one
does.

An action that can return a field of somebody with protected personal data
(skyddade personuppgifter) is offered on this instance's own screens and nowhere
else, and the registry refuses to register one that says otherwise. Read as a
rule about what may be offered rather than about what must be declared, that
decides more than it looks: an action worth offering to a connected app is one
that cannot return such a field at all, which is a property of the service
behind it rather than of what the action declares about itself.

A withheld name now travels as a shape of its own rather than as an empty one.
Something reading the answer can tell "the association is not telling you" from
"the association holds nothing", which is the difference between asking a person
and concluding there is nobody to ask about. An action that returns what a
neighbour wrote says in its own description, in both languages, that the text is
written by people and is information rather than instructions.

Seven actions: reading and recording the association's own facts, reading a
notice's comment thread and striking a comment through, and reading the motion
queue, recording that the board has received a motion and recording which
general meeting takes it up. Putting an item to the meeting stays a member's own
act on their own screen.

The motion queue is read a page at a time. It answered with every motion the
association had ever received, bodies and all, in one payload; it now answers
with a page and a cursor, and the board's screen has a control that asks for the
rest.

Saving the association's facts is recorded in the audit log. Those facts are on
the broker information page the moment they are saved, so changing one changes
what the association tells a buyer - and until now nothing anywhere said who had
changed it.

Two repairs to what a plugin and an action may reach. No action's handler may be
bound to the service that writes the apartment register's append-only rows, and
the test that enforces that list now reads every registrar in the tree rather
than two named files. And the seal that decides what a plugin's own code may ask
the framework for now covers every provider the platform shares application-wide
rather than six of them - including the mailer, the text-message sender and the
job queue, which a plugin is offered already in a narrowed form that carries the
permission the board consented to. A check under `pnpm lint:guards` refuses a
new application-wide provider that nobody has classified.
