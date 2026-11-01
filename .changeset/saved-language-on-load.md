---
"@openbrf/web": patch
---

A signed-in person's saved language is now applied when a page loads. The
interface starts in Swedish and only the profile settings switched it, so after
saving English a fresh load or refresh read Swedish again. Once the person's
account has been read, the page switches to the language they saved; before
sign-in it stays Swedish as before. It adds no request, and a language
chosen in the settings is not undone by a read that began before it was saved.
