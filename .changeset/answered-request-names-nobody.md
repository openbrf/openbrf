---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

A plugin can no longer act for a person on a request it kept past its response.
The host's mark on an authenticated request now ends when the response is sent
or its connection closes, and `host.actions.invoke` and `host.actions.list`
refuse a request whose response has ended, as does a caller handle minted from
it. Before this a plugin could keep a board member's request and pass it again
from a job or while serving somebody else, and the action and its audit entry
named the board member as the one who acted.
