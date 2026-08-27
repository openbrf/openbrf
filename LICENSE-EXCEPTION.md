# Open BRF Module Exception

Version 1.0 (draft)

> **Status: draft.** This exception will be reviewed by counsel before the first public release. Until that review, its wording may change; the intent below is a settled project decision.

## The exception

As an additional permission under section 7 of the GNU Affero General Public License, version 3 ("AGPL-3.0"), the copyright holders of Open BRF give you permission to combine Open BRF with modules.

A "module" is a plugin, theme, or other extension package that interacts with the Open BRF core exclusively through the documented public extension interfaces: the plugin API, the theme/token contract, the public HTTP API, and the extension points declared in the module manifest format (together, the "Module API").

If you create and convey a module:

1. The module is **not** considered a work based on Open BRF for the purposes of AGPL-3.0, regardless of the linking or loading mechanism.
2. You may license the module under terms of your own choosing, including proprietary terms; nothing requires you to convey the module's source code.
3. Running a combined work consisting of an unmodified Open BRF core and one or more modules, including offering it to users over a network, does not extend the obligations of AGPL-3.0 (including section 13) to the modules.

This exception does **not** apply to:

- Modifications of the Open BRF core itself, which remain governed by AGPL-3.0 in full. A "module" that patches, replaces, or bundles modified core code is a modification of the core, not a module.
- The obligations of AGPL-3.0 regarding the core: anyone conveying or network-hosting a modified core must still offer its Corresponding Source.

As provided by section 7 of AGPL-3.0, you may remove this additional permission from your copy, but you may not add further restrictions.

## Why this exists

The legal status of in-process plugins to (A)GPL software is a decades-old gray zone. Rather than relying on it, Open BRF states the rule explicitly, in both directions: the core is and remains copyleft, and the module ecosystem - community and commercial alike - is legally safe to build in. Vendure pioneered this model for GPL; Open BRF applies it to AGPL.

This exception is granted by Apteo AB as copyright holder of Open BRF. Contributions are accepted under a [CLA](CLA.md) precisely so that this grant remains valid for the whole codebase.
