---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

Give a new association a ready-made website when it finishes the setup wizard.

Instead of one front page, setup now writes Home (the front page, with a
welcome text), About us, the board (with the board roster), the documents
(with the document list) and Contact (with the contact form). Each page is
public and carries placeholder text, in the language the wizard was finished
in, that says what the board writes there. The menu is filled in with those
five pages and then the broker information page, in that order. The privacy
notice is written as before.

An association that already has a page of its own is given none of these, so
an existing website keeps its pages, its menu and its front page; running the
wizard again from settings adds nothing either.
