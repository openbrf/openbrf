---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

The lien amount, the participation shares and the initial share capitals on the
apartment register refused a figure typed with a decimal comma or grouped with
spaces, such as "150 000,50", and a refused lien blamed the creditor and the
date. Such figures are now read as the number they state, and a refused lien
names the amount as well.

When the initial supply is refused because the association has no organisation
number, the message now says to record it in Settings, under the housing
cooperative, rather than on the apartment register, which only shows it.
