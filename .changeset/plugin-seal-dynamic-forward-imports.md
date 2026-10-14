---
"@openbrf/api": patch
---

A plugin module whose dynamic module lists a forward reference in its
`imports`, as `{ module: PluginModule, imports: [forwardRef(() => Shared)] }`,
now builds. The seal puts the module the reference resolved to in its place,
and NestJS builds that module once. Before, the build failed with a
`TypeError` and the plugin was skipped as `module-failed`. A list that cannot
take the module, such as a frozen array, is refused with `module-refused`.
