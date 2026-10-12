---
"@openbrf/web": patch
---

On the fees screen, the previous day's fee register stayed on screen with working "Ta bort" buttons while the register for a newly chosen date was loading, so the board could remove a fee while believing it was looking at the new date. The register is now shown only for the date on the control, and a loading line stands in its place meanwhile.
