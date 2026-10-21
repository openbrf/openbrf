---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
---

`host.actions.client(request)` tells a plugin which connected app a request on
its route was authenticated with, or `null` for a signed-in session. It answers
from what the host established when it authenticated the request, as the
dispatch does, so writing a `token` on the request or removing it does not
change the answer. A connector uses it to refuse a request that did not come
from a connected app, without reading the request's own properties.
