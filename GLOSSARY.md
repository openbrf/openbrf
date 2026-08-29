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
| debiteringslängd | **debiting list** | In Open BRF: the export of charge basis per member or apartment, handed to whoever keeps the association's books as CSV or PDF. The statutory debiteringslängd of a joint facility association (samfällighetsförening) is a separate artifact governed by Lag (1973:1150) om förvaltning av samfälligheter, 42 §, which requires it to state the amount assessed, what falls on each member and when payment is due. |
| dokumentarkiv | **document archive** | The association's own documents - bylaws (stadgar), minutes (protokoll), house rules (trivselregler), the annual report (årsredovisning) - each carrying the audience it is for: the board, the members, or anyone. Association records rather than personal data, so outside the purge scope. Minutes of a general meeting name the members who spoke, so they are the members' unless the board publishes a particular set deliberately. |
| ekonomisk förvaltare | **economic manager** | The external bookkeeping and fee-invoicing service many associations buy (SBC, Nabo, Fastum and the like). Distinct from *property manager* (förvaltare/vicevärd), who handles the building and issues; an economic manager receives exports and has no account in Open BRF. |
| felanmälan | **issue report** | Resident-reported maintenance issue; the module is "issues". |
| föreningsstämma / stämma | **general meeting** | Annual or extraordinary meeting of members. Postal voting is prohibited in a BRF (BRL 9 kap. 14 §) and is never built. |
| förvaltare / vicevärd | **property manager** | External role with access to issue handling only, never the address book. |
| gallring | purging | GDPR retention deletion in the service tier; the statutory archive tier is exempt (7-year lock). |
| granskningslogg | **audit log** | The append-only record of accesses and changes (AuditLogEntry). Never "access log": the record covers changes as well as reads, and the retention screen has to say which record a retention policy cannot reach. |
| inflyttning / utflyttning | **move-in** / **move-out** | The flow that starts or ends a residency. A move-in as a member writes the member register entry; a move-out writes the exit entry when the person's last tenant-ownership ends. |
| insats | initial share capital | The original capital contribution tied to an apartment. |
| lägenhetsförteckning | **apartment register** | Statutory register of apartments incl. liens and share capital (BRL 9 kap.). Confidential - only the tenant-owner may see their own entry. Never blended with the member register. |
| lägenhetsnummer | apartment number | Lantmäteriet numbering (e.g. 1101). Always rendered in the mono grid. |
| Lantmäteriet | Lantmäteriet | Swedish mapping/cadastral authority; register export deadline Dec 2027. Keep the name. |
| mäklarinfo | broker information | The public page brokers and buyers expect: fees, transfer and lien note fees, building facts, links to bylaws and annual reports. Generated from association facts - never from the statutory registers. The transactional broker extract (mäklarbild) is a paid module, not core. |
| medlem | member | A person who is a member of the association. |
| medlemsförteckning | **member register** | Statutory register of members. BRL 9 kap. 8 § requires it and 9 § fixes its contents and its availability to anyone who asks; EFL 5 kap. 6-7 §§ apply through BRL 9 kap. 9 b §. Must never be blended with the apartment register in UI or data model. |
| motion | motion | Member proposal to the general meeting. |
| ordförande | chair | Board chair - a position of trust (brass in the design system). |
| pantsättning / pantnotering | **lien** / lien note | Recorded in the apartment register; confidential. |
| personnummer | personal identity number | Swedish national ID. Only where legally justified; never in public views. |
| publiceringssamtycke | **publication consent** | A person's recorded consent to appear on a page the association publishes. No personal data reaches a public page without one, and protected personal data never reaches one at all. An image upload therefore declares whether it shows identifiable persons: that declaration is what ties a photograph to this consent. One consent covers one scope - a photograph, a name on the website, or the published board roster - and agreeing to one is not agreeing to another. It is granted and withdrawn as dated facts: a withdrawal closes the consent with a date and never deletes the record that it stood, because the period it covered is what says a page published then was published lawfully. |
| pärm | **binder** | What a document in the archive is filed into - Protokoll, Stadgar, Trivselregler, Årsredovisning. The board names its own rather than picking from a fixed list, so it is free text the form only suggests from. Carried on the document as `category`, the archive's word for what a binder holds; the term for the binder itself is "binder", never "folder". |
| registerutdrag | data subject access report | Per-person GDPR report. |
| rättsligt bevarandekrav | **legal hold** | A recorded reason for keeping one person's service-tier data past its purge date: a dispute, an insurance matter, a request from an authority. GDPR art. 17.3 e is what makes the exception lawful. It suspends the gallring for that person alone rather than changing the association's retention policy, and it is released with a date rather than deleted, so the record explains why nothing was purged in that period. |
| samtycke | **consent** | A recorded agreement that is the legal basis for processing personal data (GDPR art. 6.1 a). The board's samtycke to a plugin's stated permissions and personal-data categories is what lets it run, and a republished version that widens either is refused until the board consents again. The per-person case of appearing on a published page is publiceringssamtycke, below. |
| skyddade personuppgifter | **protected personal data** | Persons with protected identity: masked in all public views, exports, and lists; access is logged. |
| stadgar | bylaws | The association's statutes. |
| styrelse | **board** | The elected board of the association. |
| styrelseledamot / ledamot | board member | |
| suppleant | deputy board member | |
| tema | **theme** | An installable package that restyles an instance. The other package type beside a plugin, and not a kind of one: a theme is pure data - a manifest, light and dark token sets, fonts, a logo and a choice of core view variants - and contains no JavaScript, so it declares no permissions, handles no personal data, and puts nothing in the running process. It decides what a token looks like and never what it means, because colour carries legal semantics in a statutory register. Checked against a contrast matrix at install time, and installed or switched without a restart, since there is no code to load. |
| tillägg | **plugin** | An installable package that adds behaviour or a view to an instance. Installed from the curated catalog, declares what it may do and which personal data it handles, and is consented to by the board before it runs. Its code runs in the instance's own process, so installing or switching one on ends by restarting it. A theme is the other package type and is not a plugin. |
| upphörande | termination | A bostadsrätt ceasing to exist. A register event in its own right, distinct from a transfer to a new holder; reported by the cooperative (Lag (2026:484), 3 kap.). |
| upplåtelse | grant | The act of first granting a bostadsrätt to a holder; reported by the cooperative (Lag (2026:484), 3 kap.). The contract that does so is the upplåtelseavtal (grant agreement). |
| upplåtelseavtal | grant agreement | The contract first granting a bostadsrätt. |
| utdrag ur förteckning | **register extract** | A copy of a statutory register, produced on request. The member register extract is public; the apartment register extract goes to the board and to the tenant-owner it concerns. Distinct from the GDPR registerutdrag, which is a data subject access report. |
| utflyttad | moved out | Register state with dashed outline + purge date in the UI. |
| årsavgift / månadsavgift | annual fee / monthly fee | The fee the tenant-owner pays the association. |
| ärende | **issue** | One reported problem with the building and the record of handling it, from new through in progress to done. The felanmälan (issue report) is how it arrives; the ärende is what the board and the property manager work. Service tier, and among the most sensitive free text the platform holds - a report about a leak or a neighbour carries health data and a third party's details without anybody intending it - so it is readable by its reporter and by whoever handles issues, and never published. |
| ärendetyp | **issue type** | The category an issue is reported under. Configured by the board, monolingual, and scoped to exactly one audience: non-member, member, or board (internal). The audience decides who is offered the type, and the filter is applied on the server for every caller - a resident is never shown the internal categories, and the form on the public website offers the non-member ones alone. |
| överlåtelse | transfer | Sale/transfer of a bostadsrätt between holders. |
| överlåtelseavtal | **transfer agreement** | The contract transferring a bostadsrätt, as the upplåtelseavtal (grant agreement) is the one that first grants it. |
| överlåtelseavtalets referens | **agreement reference** | What the apartment register records to identify a transfer's transfer agreement: the board's own reference - a case number, or where the paper copy is filed - or the path of an uploaded copy. Every transfer states one, because the register extract lists it and a transfer cannot be removed once written. Never "contract number": the reference need not be a number and need not come from the contract. |

## Adding terms

Add the term in the same PR that introduces it in code, keep the table alphabetized by the Swedish column, and cite the statute at chapter level (only cite an exact section when verified against the current text at [riksdagen.se](https://www.riksdagen.se)).

Alphabetized in the Swedish alphabet, where å, ä and ö are letters in their own right and sort after z rather than as variants of a and o. `årsavgift` therefore follows `utflyttad`, and the `överlåtelse` rows come last.
