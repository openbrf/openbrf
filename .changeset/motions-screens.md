---
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the motion screens: a member puts an item to the general meeting from the
application, and the board works the queue it arrives in.

Two halves on one screen, and which one a viewer gets is the statute rather than
a layout decision. `motions:submit` is derived from membership - EFL 6 kap. 15 §
via BRL 9 kap. 14 § gives the right to put an item to a general meeting to a
member - so a partner, an adult child or a tenant living in the house is offered
no form and no navigation entry at all. `motions:handle` is the board's, because
a motion is addressed to it, so a board member who holds no tenant-ownership
reaches the screen to work the queue and finds no form on it. A board member who
is also a member holds both, which is the ordinary case, so neither half assumes
it is alone on the page. Hiding a panel is courtesy: the API refuses every call
either way, and the membership question is asked again by the server before a
motion is written.

The deadline the association's own bylaws set is stated on both halves and never
enforced, because it decides which meeting an item can reach rather than whether
the association may receive one - a form that showed the date without saying so
would leave a member believing a late item was on the coming agenda. An
association whose bylaws are silent is told exactly that, rather than shown a
date the platform invented. A settings panel records the clause: read by the
board, who answer for it, and changed by an administrator.

Withdrawing is offered only while a motion is still open, which is the only state
the API accepts it in, and a withdrawn motion stays on the member's list with its
date. There is no control that rejects a motion, because refusing to take up a
member's item is not the board's decision to make. A member with protected
personal data is not named in the queue.

The end-to-end suite drives the statute where a person would meet it: the shared
register fixture holds two people in one apartment, one a member and one not, and
they get different answers from the same screen.
