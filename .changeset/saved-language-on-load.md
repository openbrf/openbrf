---
"@openbrf/web": patch
---

A signed-in person's saved language is now applied when a page loads. The
interface starts in Swedish and only the profile settings switched it, so after
saving English a fresh load or refresh read Swedish again. Once the person's
account has been read, the page switches to the language they saved; before
sign-in it stays Swedish as before, and signing out, or a session that expired,
puts the sign-in screen back in Swedish without a reload. It adds no request.
When reads of the account end out of order, only the newest one counts, and a read that started
before a successful language save in the settings is ignored.
