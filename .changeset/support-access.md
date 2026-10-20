---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

An administrator can now open support access from the settings, so that
whoever hosts the instance can send somebody to help (ADR 0028). The
administrator chooses how long it stays open, from one hour to seven days, and
gives a reason, which is kept in the audit log for good. Any administrator can
close it at once. It also ends at its end time, or when whoever opened it is no
longer an administrator.

While it is open, the host asks the management API for a sign-in link with the
new `POST /v1/support-sessions`. The link works once, for ten minutes. The
supporter is never added to the register and gets no account. Their session is
read-only and lasts at most eight hours, every screen says who they are and
when the access ends, and no screen offers them a control that would change
anything. They see what the administrator uses to run the instance,
and never a personal identity number, a lien, a protected person's details, the
association's casework or an apartment binder. Every request they make is in
the audit log on a new `SUPPORT` channel, against the administrator who opened
the access, and the settings screen lists each supporter and when they were
signed in.
