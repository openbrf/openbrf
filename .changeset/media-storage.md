---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add file uploads and media storage, and the housing cooperative's logo on top
of it.

One storage interface with two drivers, both shipped and both covered by tests:
the local disk under `OPENBRF_DATA_DIR`, and any S3-compatible bucket. Which
one an instance uses is configuration and changes nothing above the driver.

Files are always served from the association's own origin. The API streams the
bytes; it never answers with a link or a redirect to the storage endpoint,
because either would hand the storage provider the IP address, the timing and
the referring page of every visitor - the same disclosure the platform refuses
to make for typefaces. The S3 path is tested for exactly that, against an
S3-compatible server running in the test process.

An upload is identified from its own bytes rather than from the content type or
the file name the request declared, and its storage key is generated rather than
taken from either. Size is enforced while the body is read. An image upload
declares whether it shows identifiable persons; the declaration is recorded so
the publication guardrails can use it, and the consent engine itself comes with
the public website.

Serving is authorized per file: public files reach anyone, which is what a mail
client rendering the association's logo needs, and a file may be narrowed to
holders of one capability, in which case each serve is written to the audit log.
A file that may not be read is answered exactly as one that does not exist.

The logo is uploaded in settings under appearance and in the setup wizard's
appearance step. There are two slots because the application's top band is dark
and a mark drawn in dark ink disappears on it: a variant for dark surfaces is
optional, and without one the band puts the mark on a light plate, which the
settings screen previews rather than leaving the board to discover.
