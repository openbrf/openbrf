# Glossary

The canonical mapping between Swedish domain terms and the English terms used in code, APIs, and documentation. Swedish cooperative law is the spec for Open BRF, so precision here matters: **use these English terms and no others** for identifiers, i18n keys, and docs. When the legal concept is the point, mention the Swedish term in a doc comment.

Statutes referenced below:

- **BRL** - Bostadsrättslagen (1991:614), the Swedish Tenant-Ownership Act
- **EFL** - Lag om ekonomiska föreningar (2018:672), the Swedish Economic Associations Act

| Swedish | English (canonical) | Meaning / notes |
| --- | --- | --- |
| andelstal | participation share | The apartment's share of the association, used for fee allocation. |
| avisering | fee notification | Issuing payment notices (OCR numbers etc.). |
| boende | resident | Anyone living in the building: members, partners, tenants, children 13+. Not every resident is a member. |
| bostadsrätt | tenant-ownership; cooperative apartment | The ownership form: a share in the association tied to the right to use an apartment. |
| bostadsrättsförening (BRF) | housing cooperative; keep **BRF** as abbreviation | The association itself. "BRF" is established and used as-is in names and prose. |
| bostadsrättsregister | cooperative housing register | The state register of cooperative apartments kept by Lantmäteriet (Lag (2026:484) om bostadsrättsregister, 3 kap.). The cooperative reports grant, transfer and termination, each within two weeks, though the transfer window runs from the membership decision and the statute assigns the report to a juridical person in defined cases; liens are reported by the lienholder, not the cooperative. |
| dataskyddsförordningen | GDPR | Keep "GDPR". |
| debitering | **charge** | A one-off cost put on a named member or apartment: a key to the bike room, a replacement tag, a subletting fee, a repair charged on. Open BRF records the basis for the charge - amount, date, reason, VAT treatment - and never the payment; the ledger belongs to the accounting system. |
| debiteringslängd | **debiting list** | The list of charges per apartment handed to whoever keeps the books. Exported as CSV or PDF; also the statutory list a joint facility association (samfällighet) works from. |
| ekonomisk förvaltare | **economic manager** | The external bookkeeping and fee-invoicing service many associations buy (SBC, Nabo, Fastum and the like). Distinct from *property manager* (förvaltare/vicevärd), who handles the building and issues; an economic manager receives exports and has no account in Open BRF. |
| felanmälan | **issue report** | Resident-reported maintenance issue; the module is "issues". |
| föreningsstämma / stämma | **general meeting** | Annual or extraordinary meeting of members. Postal voting is prohibited in a BRF (BRL 9 kap. 14 §) and is never built. |
| förvaltare / vicevärd | **property manager** | External role with access to issue handling only, never the address book. |
| gallring | purging | GDPR retention deletion in the service tier; the statutory archive tier is exempt (7-year lock). |
| granskningslogg | **audit log** | The append-only record of accesses and changes (AuditLogEntry). Never "access log": the record covers changes as well as reads, and the retention screen has to say which record a retention policy cannot reach. |
| insats | initial share capital | The original capital contribution tied to an apartment. |
| lägenhetsförteckning | **apartment register** | Statutory register of apartments incl. liens and share capital (BRL 9 kap.). Confidential - only the tenant-owner may see their own entry. Never blended with the member register. |
| lägenhetsnummer | apartment number | Lantmäteriet numbering (e.g. 1101). Always rendered in the mono grid. |
| Lantmäteriet | Lantmäteriet | Swedish mapping/cadastral authority; register export deadline Dec 2027. Keep the name. |
| mäklarinfo | broker information | The public page brokers and buyers expect: fees, transfer and lien note fees, building facts, links to bylaws and annual reports. Generated from association facts - never from the statutory registers. The transactional broker extract (mäklarbild) is a paid module, not core. |
| medlem | member | A person who is a member of the association. |
| medlemsförteckning | **member register** | Statutory register of members. BRL 9 kap. 8 § requires it and 9 § fixes its contents and its availability to anyone who asks; EFL 5 kap. 6-7 §§ apply through BRL 9 kap. 9 b §. Must never be blended with the apartment register in UI or data model. |
| motion | motion | Member proposal to the general meeting. |
| ordförande | chair | Board chair - a position of trust (brass in the design system). |
| överlåtelse | transfer | Sale/transfer of a bostadsrätt between holders. |
| pantsättning / pantnotering | **lien** / lien note | Recorded in the apartment register; confidential. |
| personnummer | personal identity number | Swedish national ID. Only where legally justified; never in public views. |
| publiceringssamtycke | **publication consent** | A person's recorded consent to appear on a page the association publishes. No personal data reaches a public page without one, and protected personal data never reaches one at all. An image upload therefore declares whether it shows identifiable persons: that declaration is what ties a photograph to this consent. |
| registerutdrag | data subject access report | Per-person GDPR report. |
| skyddade personuppgifter | **protected personal data** | Persons with protected identity: masked in all public views, exports, and lists; access is logged. |
| stadgar | bylaws | The association's statutes. |
| styrelse | **board** | The elected board of the association. |
| styrelseledamot / ledamot | board member | |
| suppleant | deputy board member | |
| upphörande | termination | A bostadsrätt ceasing to exist. A register event in its own right, distinct from a transfer to a new holder; reported by the cooperative (Lag (2026:484), 3 kap.). |
| upplåtelse | grant | The act of first granting a bostadsrätt to a holder; reported by the cooperative (Lag (2026:484), 3 kap.). The contract that does so is the upplåtelseavtal (grant agreement). |
| upplåtelseavtal | grant agreement | The contract first granting a bostadsrätt. |
| utflyttad | moved out | Register state with dashed outline + purge date in the UI. |
| årsavgift / månadsavgift | annual fee / monthly fee | The fee the tenant-owner pays the association. |

## Adding terms

Add the term in the same PR that introduces it in code, keep the table alphabetized by the Swedish column, and cite the statute at chapter level (only cite an exact section when verified against the current text at [riksdagen.se](https://www.riksdagen.se)).
