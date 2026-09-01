---
"@openbrf/api": patch
---

Refuse a field no block type declares on the contact form, the issue report
form and the news teaser, as the other eight blocks already did.

The write path is strict about keys as well as about values, for one reason: a
body accepted without the part that was sent is the one answer a write path must
not give. Those three schemas stripped instead. A block written with a
misspelled key was accepted, the board was answered that the page had been
saved, and the field was gone. A body naming fields for a form to ask for was
accepted the same way, and stored as the form this platform fixes the fields of,
with nothing said about what had been dropped. The route now names the field path
back as an invalid body, and never the value.

Nothing already stored is at risk. The strict schema is on the write path alone.
The renderer and the board's own editor read a stored body through the total
parser, which has never looked at a key it does not declare: a page carrying one
renders exactly as it did, and is handed to the editor without it, so a save
sends back only the keys the schema knows. The tightening can refuse a body being
written; it cannot refuse a page an instance already has.
