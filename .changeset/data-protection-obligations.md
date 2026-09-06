---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/shared": minor
"@openbrf/i18n": minor
---

Do the rest of what a controller has to do: the record of processing
activities, the breach register, processor agreements, the privacy notice
measured against art. 13, and the requests a person makes about their own data.

The hard half of data protection was already here - encryption at rest, access
control, masking, the audit log, retention with a nightly purge, the data
subject access report. What was missing was the half a supervisory authority
asks to see: the records. A board could run this platform lawfully and have
nothing written down to show for it. This is the writing down, and it is in
Core and free, because what an association must do to process personal data
lawfully is part of the product rather than something to pay for.

**The record of processing activities (art. 30) is seeded, not typed in.** A
board cannot be expected to enumerate its own processings from memory, and a
register somebody typed once goes stale the day a setting changes. So the
instance writes down what it already knows it does - the statutory registers,
the address book, the mailings, the issue queue, the document archive, the
bookings, the events, the meetings, sixteen processings in all - each with its
purpose, its legal basis, the categories of personal data and of people, the
recipients, the retention and the security measures. Every one of them is
editable and the board can add its own, because an association processes things
outside the application too. The controller's contact details, the joint
controller where there is one, and the data protection officer where the
association has appointed one are recorded once and read from there.

**The breach register runs a clock rather than holding a form.** GDPR art. 33
starts counting from the moment the board became aware of a breach, which is
not the moment somebody sat down to write it up, so those two dates are
separate columns and the deadline is derived from the first. The board is
mailed when a day of the 72 hours is left. Recording a breach is one act;
deciding it is another, and the decision carries its ground: IMY is notified,
or it is not because the breach is unlikely to result in a risk to the people
concerned (art. 33(1)); the people affected are told (art. 34(1)), or they are
not under one of the exceptions in art. 34(3). A record whose notification went
out after 72 hours will not close without the reasons for the delay art. 33(1)
requires. The notification itself goes through IMY's own e-service - what
belongs here is the record, the clock and the evidence of the decision.

**A recipient is classified before an agreement is asked for.** Not everything
that receives personal data is a processor, and asking a board to sign an
art. 28 agreement with its own hard drive would teach it that these records are
paperwork. So each recipient the instance actually has - read from the
configuration rather than from a list somebody maintains - is classified first:
a processor, no processor because it runs on the association's own
infrastructure, or an independent controller. Only a processor needs an
agreement, with the terms art. 28(3) requires and the prior authorisation of
sub-processors art. 28(2) requires. The SMTP server, the SMS provider and the
object storage are each there when they exist and absent when they do not; the
local disk is listed with "no processor" already suggested; and hosting is
listed because somebody runs the machine and only the board knows who. A plugin
is a recipient too, and the consent step now asks the one question the instance
cannot answer for itself: whether this plugin sends personal data outside the
instance, and to whom.

**The privacy notice is measured against art. 13 rather than assumed to
satisfy it.** The seeded page grew from six headings to fifteen - the legal
basis behind each purpose, the legitimate interest where that is the basis, the
recipients, transfers to a third country, automated decisions with the logic
involved and what they mean for the person, the data protection officer, the
right to withdraw a consent, whether giving the data is a statutory or a
contractual requirement and what follows from not giving it, and the right to
complain to IMY. The screen names the headings the published page has not
answered yet and can append the missing ones for the board to fill in, and the
controller's contact details are a block the page reads from the instance
rather than something retyped into prose that then goes stale.

**A person can ask for more than a copy.** Erasure ahead of the retention
window on one of the grounds in art. 17(1), granted only where none of the
exceptions in art. 17(3) applies - which for a cooperative means no statutory
duty to keep the record and no legal claim, the ground a legal hold already
records. An objection to a processing (art. 21). A restriction of it
(art. 18). Each is recorded against the person with the ground the board relied
on, answered inside the month art. 12(3) allows - a due date derived from the
calendar rather than stored - and each reaches the screens the processing
actually runs from: an objection stops the news mail and the text message, a
granted erasure brings the nightly purge forward to the next run, and a
restriction stops every purge from touching the person at all, because art.
18(2) says the association may store the data, which makes erasing it the one
act the person asked it not to perform.

**Data portability (art. 20) hands the person a file.** A machine-readable
export of what they gave the association under the membership contract or under
their consent, and nothing else: no statutory register content, no audit trail,
no personal identity number, no legal holds. It is separate from the data
subject access report, which is a printed document by design and stays one. The
export says in words that it is handed to the person to transmit themselves,
because a direct transfer to another controller under art. 20(2) is required
only where technically feasible and no receiving standard exists between
housing cooperative platforms.

**The nightly purge reaches issues and the document archive.** Both are service
tier and both were listed on the access report without ever being erased. An
issue or a document is detached from the person rather than deleted: the link
and the personal data on the row go, the record stays. The description is not
rewritten - it is free text the reporter wrote about the building, it is the
record of the problem, and a job editing prose on a schedule would be the
association quietly editing its own history. A report filed through the public
form is keyed to nobody, so no person's clock would ever reach it; it is
detached on a clock of its own, a year after the board closed it.

**One screen, and a strip at the top of it that answers "do we owe anybody
anything today".** Four sentences rather than four numbers, each reading as a
word when it is zero, because a board that has nothing waiting should be told
so - an empty strip looks like a screen that has not finished loading.

Everything here is service tier and inside the retention policy, except the
audit entries, which are outside every purge as they have always been. The
statutory registers are untouched.
