---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let a plugin open a stored picture and read the association's addresses
(ADR 0032).

Two new permissions, each its own consent:

- `media:read` gives `host.media.open(mediaFileId)`: a picture's type, size,
  checksum and bytes, as a web stream. Only a picture held for anyone or for the
  members whose upload declared that it shows no identifiable person opens. A
  document, a household's or the board's file, a picture in the feed and a
  picture of people answer `null`, exactly as a file that does not exist. The
  name it was uploaded under is not handed over. A manifest asking for
  `media:read` must declare `photograph`.
- `addresses:read` gives `host.addresses.list()`: each address's street and
  number, and never an apartment or anybody living there.

The consent screen states both in Swedish and English. Neither raises the
capability floor of the plugin's routes.
