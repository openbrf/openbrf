---
"@openbrf/web": patch
---

Disconnecting an app on the board's connected-apps screen now moves the keyboard focus to the confirm button as the question appears, and answering "Behåll" there or on your own security settings returns it to the button that asked. Before, the focus fell to the page each time. The withdraw, disconnect and own-disconnect questions now share one control, so they cannot drift apart again.
