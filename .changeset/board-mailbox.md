---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the shared board mailbox: mail to the board's address as a conversation the
whole board works.

Mail sent to the address the board publishes arrives as a thread every board
member can see. One board member takes it on, which writes their name onto the row the
others are reading, and answers it from the application; the answer goes out
through the instance's own mail server with the board's address in Reply-To, so
the correspondent's reply lands back on the same thread. The thread stays as the
record of what the association was asked and what it said. Taking a thread is
deliberately not exclusive - a letter locked to whoever opened it first, who then
goes on holiday, is the failure the module exists to end.

Mail comes in by collecting a mailbox the board already has, over POP3, on the
job schedule and on demand from the screen. That follows from the deployment
promise rather than from a preference: the platform installs with one Compose
command, and receiving mail directly would need port 25 open to the internet, an
MX record, a public hostname with a certificate and a spam defence. The POP3
client and the MIME reader are written against the specifications over the
runtime's own sockets and `TextDecoder`, so the feature adds no dependency.
Nothing is deleted from the mailbox; collecting the same letter twice is
prevented by its unique identifier under a unique constraint.

Everything that arrives is untrusted input from outside the association. The
body is stored as text and an HTML part is converted as it is read, so no markup
is ever kept; attachments go through the ordinary upload path and are identified
from their own bytes rather than from the declared type; and the sender is the
address the envelope asserted, never resolved to a person in the register. A
thread is service tier: it appears in the data subject access report for the
address it is with, it is erased two years after the last message on it, and a
legal hold against the person whose address that is suspends the erasure.

The inbox and a conversation are both read a page at a time, the inbox from the
end that is still owed something and a thread from its newest message, with the
page before each one a press away. How much there is to read is decided by how
much mail is sent to an address the association publishes, which is not a number
this instance chooses.

The board's screen is behind `boardMailbox:handle`, which the external property
manager deliberately does not hold. Where the mail is collected from, and with
which credentials, is an administrator's setting beside SMTP.
