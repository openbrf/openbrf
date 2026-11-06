---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A news mailing's email copy and a meeting notice's copy no longer read as "not
sent" when the mail server may have taken the message before the error. When
the send fails, the copy is now recorded as not sent only if the mail driver
says the error came before the message reached the mail server: the message
could not be prepared or its address could not be read back, the server could
not be reached, or it refused the sign-in, the address or the message. Any
other mail error is recorded as unconfirmed, for example a connection that
broke or went quiet once the message was on its way.

An unconfirmed copy of a meeting notice still counts as failed. The member stays
on the board's list of members the notice did not reach, so the board calls
them another way. A member who is called twice loses nothing, but one who was
never called may not have been summoned to the meeting. The list now says that
for some of these members it is not known whether the notice reached them.

In the data subject access report, an unconfirmed copy of a news mailing or a
meeting notice is shown as unconfirmed, with the reason that the sending stopped
before the email server confirmed it. Before, it was shown as not sent. The
reason given for a copy that was not sent now also covers a message that could
not be prepared and a server that could not be reached.
The column that holds the reason is now headed "Why it was not confirmed as
sent", because it no longer holds only copies known not to have gone out.

A migration records the earlier "not sent" code on email copies of news
mailings and on meeting notice copies as unconfirmed, since nothing then told
whether the mail server had taken them. Text message copies of a news mailing
keep their code.
