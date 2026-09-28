---
"@openbrf/plugin-sdk": patch
---

`pluginPackageProblems` reads the require calls in a server bundle correctly
in more cases.

A method or accessor named `require`, as in `{ require(name) { ... } }` or
`this.#require(name)`, is no longer reported as a require whose target is not a
string literal. And a require is no longer missed when it comes after
`a++ / b`, after a comment, string or regular expression ended by CR, U+2028 or
U+2029, or when it is written as `require?.(...)`, `module?.require(...)` or
with an escaped letter in its name, such as `requ\u0069re`.
