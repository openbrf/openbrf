---
"@openbrf/api": patch
---

Uploaded images are stored without their EXIF, XMP and IPTC metadata. A photo
used to be kept and served exactly as it arrived, so the position and capture
time a phone writes into it reached everyone allowed to open the file, such as a
property manager looking at an issue photo whose apartment is masked. JPEG, PNG,
WebP and GIF now lose their metadata, comments and anything appended after the
image, and the picture itself is copied unchanged, without being re-encoded. The
orientation is kept, so a portrait photo still shows upright. An image whose
structure cannot be followed to its end, or that is made of more than 65,536
segments, chunks or blocks, is refused instead of stored. The colour profile is
kept as it came. Images already stored are not changed.
