---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the two remaining resident-initiated forms: subletting applications
(andrahandsupplåtelse) and key orders (nyckelbeställning). Each arrives whole -
the table, its two capabilities, the resident's intake, the board's queue, the
screens, the section on the data subject access report and the nightly purge -
and the pair is one change because the interesting thing about them is the
contrast.

Subletting is the tenant-owner's. BRL 7 kap. 10 § första stycket lets a
bostadsrättshavare let _sin lägenhet_ in andra hand for självständigt brukande
only with the board's consent, so `sublets:apply` is derived from membership the
way `motions:submit` is: a partner, an adult child or a tenant living in the flat
is offered no form. The apartment named in a request has to be one the applicant
holds, asked of the register at the moment of the request, which is what settles
the administrator case - a grant on an instance carries every capability the
model defines and no tenant-ownership at all.

Ordering a key is the household's. Nothing in BRL or EFL gives anybody a right to
one, so `keyOrders:place` follows residency the way `bookings:book` does and the
same person who is offered no subletting form orders a tag exactly as a member
would. The board may decline an order, which the motion queue has no equivalent
of: refusing to take up a member's item is not the board's to decide under EFL
6 kap. 15 §, and refusing a household a fourth tag to the bike room plainly is.
Neither decision follows from the other, and both are stated where they are made.

What the platform does not decide is stated instead of guessed. 10 § andra
stycket (Lag 2026:776) makes a letting of the apartment or part of it always
count as independent use where the holder no longer uses it as a permanent home
or otherwise in beaktansvärd utsträckning - a fact about how somebody lives, so
the form states the rule and nothing here concludes that consent was needed. The
two cases in 10 a § where no consent is needed at all are outside the module and
said to be: both holders are juridical persons - a lienholding company after a
forced sale, and a kommun or a region - and neither has a resident account to
reach a form with. And where the board refuses, 7 kap. 11 § lets the hyresnämnd
permit the letting anyway; the platform cannot know that unless somebody records
it, so a permission is written down beside the refusal and changes nothing else.
The status stays refused, because the association did not consent and the
tribunal permitted, and those are two facts about one letting. Only a permission
is recorded: a refusal by the tribunal leaves the board's own refusal standing,
which the row already says.

Both forms carry the personal identity number guardrail on the way in and on
every later edit, against the resident's own text and against the board's note
alike - both are quoted back and both are printed in full on an access report -
with the field named and the value never echoed.

A key order carries no amount, no price and no invoice. What a key costs the
member is a charge, with its own model, its own VAT treatment and its own export
to whoever keeps the association's books, and a second place recording a sum
would be a second answer to what the member owes. The same holds for the avgift
för andrahandsupplåtelse BRL 7 kap. 14 § lets the bylaws provide for. The
handover is its own audit action, so once the order has been purged the
association can still answer that somebody was given a key to the building on a
day.

Retention is decided per feature rather than inherited. A key order is erased a
year after it closed: the purpose ends when the key is in somebody's hand, and
the year covers the accounting cycle the charge is settled in. A subletting
application is erased two years after the _later_ of the answer and the end of
the period applied for, so the association's record of a consent outlives the
letting it covers - letting without consent is a forfeiture ground under 7 kap.
18 § 2, and a purge anchored on the answer alone would erase the evidence while
the tenant was still in the flat. An open request of either kind is never purged,
and a legal hold stops both for the person it stands against, re-checked inside
the deleting transaction under the advisory lock so a hold placed while a run is
in flight wins.
