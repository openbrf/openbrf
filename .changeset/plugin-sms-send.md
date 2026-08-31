---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the `sms:send` plugin permission, so a plugin can send the members a text
message as well as mail them.

The permission set stopped at `mail:send` while the platform gained an SMS
adapter, which left a plugin able to write to a member and not able to send one
a text message. A plugin that declares `sms:send` receives `host.sms.send`,
which takes a number and a body and hands them to the same service the SMS
mailing uses: the sender name is the one on the housing cooperative's provider
contract and is not a parameter, and the host adds nothing to the body, because
a text message is billed by its length.

It is a permission of its own rather than part of `mail:send`, because the two
cost the housing cooperative different things. Mail leaves through a server the
instance is already set up for; a text message is billed per message against a
contract the board signed. The consent screen states that in as many words, so a
board agreeing to a plugin writing to its members is not thereby agreeing to it
spending that contract.

An instance with no SMS provider cannot send at all, and the send fails rather
than being dropped - the same answer the core's own SMS mailing gets, from the
same service. Having no provider is the ordinary state of a housing cooperative
that only ever mails its members, so a plugin whose work depends on SMS reads
`host.permissions` and degrades, or treats the failure as the answer.
