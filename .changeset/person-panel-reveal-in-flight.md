---
"@openbrf/web": patch
---

On the person panel in the register, a reveal that answered after the board had
switched masking on for the person put the value back on the screen. Such an
answer is now dropped. Each masked field's Reveal button also stays busy until its
own reveal answers, where one field's answer used to re-enable another's button
while that reveal was still in flight, which invited a second audited reveal.
