---
"@openbrf/api": patch
---

Make a meeting's children refuse its delete instead of following it.

The agenda, the attendance lines, the proxy authorisations and the notice all
cascaded from the meeting. Nothing in the platform deletes a meeting - no
endpoint offers it and the motions link has restricted since the motions
migration - so the guarantee held in practice, but it was a sentence in a
comment rather than something the database would enforce. One `DELETE` would
have taken the running order the members were summoned to deal with, the list
the votes were counted from, the authorisations behind those votes and the
document that summoned them, and left nothing behind saying the meeting had been
held.

The four foreign keys now restrict, so the delete is refused for as long as any
child stands. The two cascades inside the module that are load-bearing are kept
and now say why they are: a decision and a vote still go with the agenda item
they were recorded against, because replacing an agenda while the meeting is
being arranged is a real flow that deletes and rewrites the items, and a
notice's delivery ledger still goes with the notice.
