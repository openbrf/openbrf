---
"@openbrf/api": patch
---

Answer a magic-link sign-in request before the account is looked up or any
mail is sent, so the answer is the same, and as fast, for every address. A
delivery that fails is logged by its class and no longer turns the answer into
a server error.
