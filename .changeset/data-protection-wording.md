---
"@openbrf/i18n": patch
"@openbrf/api": patch
---

Correct three values in the data protection module that a board acts on or the
association has to stand behind.

The note above the breach register stated the art. 33(1) test with two
negations. It was a literal rendering of the English "unless the breach is
unlikely to result in a risk" and did mean that, but "om den inte sannolikt inte
medför någon risk" is not a sentence anybody should have to read twice while
deciding whether a statutory notification is owed on a 72-hour clock. It now
states the test the way the refusal beside it already does, so the two agree:
"om det inte är osannolikt att incidenten medför en risk för de registrerade".

The record of processing activities named the authority "Lantmateriet" in
English. That value is seeded into the persisted art. 30 record rather than only
rendered, so the misspelling was written into a document the association
produces on request. It is Lantmäteriet, as the register module has always
spelled it.

Correcting the string alone would have repaired nothing already written, because
the seed refreshed only the fields it derives from the configuration and left
the text it had authored where it was. It now refreshes every field it wrote, on
the same condition as before: only while nobody has edited the row. That
condition is what protects a board's own words, and it is set by any edit that
changes something, so a row the board has touched still comes out of a seed
exactly as the board left it.

The erasure ground for an upheld objection said an objection "nothing
overrides". GDPR art. 17(1)(c) turns on there being no overriding legitimate
grounds _for the processing_, which is what the label now says in both
languages. It is what an operator picks when recording why an erasure was
granted, and it prints on the data subject access report, so a ground that does
not match the article is a weak record of the decision.
