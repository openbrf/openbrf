---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the open SMS adapter, so a board can reach the members by text message as
well as by email.

Open is the load-bearing word. Sending is behind one interface with a driver
behind it, the way file storage already is, and no SMS provider's package is a
dependency of the application. The driver this release ships posts each message
to an address the board provides, so the provider is whoever answers it - a
commercial route, a gateway on the association's own hardware, or a few lines in
front of either. A cooperative changes provider by changing a setting, and a
driver written against a particular provider is a file beside the one that
exists rather than a change to it. Nothing is sent until a board turns it on: an
instance starts with no provider, and that is not a fault - text messages are
billed per message, and an association that only mails its members is the
ordinary case.

Publishing a news item now offers both channels, and offers them separately.
The email is on by default because it costs nothing and reaches everyone in the
register with an address; the text message is off, because it is billed per
member and reaches only those who have given the association a number. Each is
claimed once and only once, by its own conditional update inside the publish
transaction, so a board that emailed the members in the morning can still text
them in the afternoon about the same notice and neither claim can be taken
twice. Editing a published item touches neither.

The delivery ledger carries the channel, so the two share one record of who the
board addressed while each keeps its own claim. Each worker claims a recipient's
row before it hands that recipient's message to a mail server or a provider,
which is what makes a second copy impossible; the cost is unchanged and it is
the other way round, a worker lost between the claim and the send takes that one
message with it. Neither worker can reach the other's rows, and neither channel's
retries or failures cost the other any: a gateway that is down does not spend
the mailing's attempts, and a mailing given up on marks only its own rows.

The recipients are the members the association can actually reach that way. A
member without a number is not among the people it can text, so they are absent
from that ledger rather than written into it and recorded as a failure. No
number is ever carried in a job: the payload is one news id, and the worker
decrypts each number where the message is composed, exactly as the mailing does
with an address.

On an instance with no SMS provider the news item is published all the same, and
the board's screen says which of the two did not go out. The two channels
are reported apart for that reason - a cooperative that mails its members and
has never bought SMS must not read a column of failures as though the mailing
had failed.

A text message is a headline and the address of the article, in the recipient's
own language, and never the announcement itself: it arrives unencrypted on a
lock screen over a network the association does not run, so it carries nothing
that was not published anyway. It is bounded, and the link is what survives the
bound - a long headline is cut, the address never is. Once the members have been
texted, the item's address is settled and a rename is refused, because that link
is the only copy of it they have.
