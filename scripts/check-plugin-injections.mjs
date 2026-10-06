/**
 * Refuses a root-injector provider nobody has classified.
 *
 * A plugin contributes a real NestJS module into the application's own
 * injector, so everything a `@Global()` module exports is something a plugin's
 * constructor can ask for by token. The seal's denylist is what refuses that,
 * and the defect it was written to close was not a wrong entry but a missing
 * one: the list named six names while twelve global modules exported thirteen,
 * and three of the seven it missed are services the host deliberately wraps
 * before it hands them over.
 *
 * A list maintained by hand beside a set of modules maintained by hand drifts
 * the day somebody adds the thirteenth module, and nothing about that change
 * looks like a decision about plugins. This check makes it one: every name a
 * global module exports must appear in the seal's denied list or in its allowed
 * list, and the allowed list takes a sentence saying why the name is safe.
 *
 * It also checks the seal's own prose about how many modules are global, which
 * is the sentence that was wrong for as long as the list was.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = join(repoRoot, "apps/api/src");
const sealPath = "apps/api/src/plugins/plugin-module-seal.ts";

/** Written numbers, so the seal's prose can be checked against a count. */
const NUMBER_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
]);

/** Every `*.module.ts` under the API's source tree. */
function modulePaths(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") {
        continue;
      }
      found.push(...modulePaths(path));
      continue;
    }
    if (entry.endsWith(".module.ts")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Source with its comments removed.
 *
 * Prose about a global module naming `@Global()` is expected and is not a
 * finding, exactly as it is not one in the statutory guard check.
 */
export function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * What every `exports:` in a module names, split into the bare identifiers
 * this check can classify and the entries it cannot.
 *
 * Every occurrence is read, because a module can export statically and again
 * from a `forRoot()`, and each array is read to its own closing bracket, with
 * brackets, braces and parentheses inside it counted, so a nested `]` does not
 * end it early. Anything that is not a bare identifier - a spread, a
 * `{ provide }` object, an `exports:` that is not an array literal at all - is
 * returned as unreadable rather than dropped: the providers behind it are in
 * the root injector all the same, and a name nobody can see is a name nobody
 * classifies.
 */
export function exportedNames(source) {
  const names = [];
  const unreadable = [];
  for (const match of source.matchAll(/\bexports\s*:\s*/g)) {
    let at = match.index + match[0].length;
    if (source[at] !== "[") {
      unreadable.push(
        `exports: ${/^[^,}\n]*/.exec(source.slice(at))[0].trim()}`,
      );
      continue;
    }
    let depth = 0;
    let entry = "";
    const entries = [];
    for (at += 1; at < source.length; at += 1) {
      const character = source[at];
      if (depth === 0 && (character === "," || character === "]")) {
        entries.push(entry.trim());
        entry = "";
        if (character === "]") {
          break;
        }
        continue;
      }
      if ("[({".includes(character)) {
        depth += 1;
      } else if ("])}".includes(character)) {
        depth -= 1;
      }
      entry += character;
    }
    for (const found of entries.filter((text) => text !== "")) {
      (/^[A-Za-z_$][\w$]*$/.test(found) ? names : unreadable).push(found);
    }
  }
  return { names, unreadable };
}

/**
 * Whether a module puts its exports in the root injector: decorated
 * `@Global()`, or returned from a `forRoot()` as a dynamic module with
 * `global: true`, which Nest treats the same.
 */
export function isGlobal(source) {
  return /@Global\(\)|\bglobal\s*:\s*true\b/.test(source);
}

if (import.meta.main) {
  const failures = [];

  const globals = [];
  for (const path of modulePaths(apiSource)) {
    const source = withoutComments(readFileSync(path, "utf8"));
    if (!isGlobal(source)) {
      continue;
    }
    globals.push({ path: relative(repoRoot, path), ...exportedNames(source) });
  }

  if (globals.length === 0) {
    failures.push(
      "No @Global() module was found at all, which means this check is looking " +
        "in the wrong place rather than that the application has none.",
    );
  }

  const seal = readFileSync(join(repoRoot, sealPath), "utf8");

  /**
   * The names the seal classifies, read out of the two structures that hold
   * them.
   *
   * The denied entries are matched on their `exported:` field, which is the
   * identifier the exporting module lists, rather than on `token:` - the two
   * differ for `ENV` and `PROTECTED_RESOURCE`, whose tokens are a symbol's
   * description and a plain string.
   */
  const denied = new Set(
    [...seal.matchAll(/exported:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)].map(
      (match) => match[1],
    ),
  );
  const allowedBlock = seal.slice(seal.indexOf("const ALLOWED_INJECTIONS"));
  const allowed = new Set(
    [...allowedBlock.matchAll(/\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,/g)].map(
      (match) => match[1],
    ),
  );

  if (denied.size === 0) {
    failures.push(
      `${sealPath} names no denied provider, so this check cannot be reading the ` +
        "denylist it is meant to enforce.",
    );
  }

  for (const module of globals) {
    for (const entry of module.unreadable) {
      failures.push(
        `${module.path} is global and exports \`${entry}\`, which is not a ` +
          "bare identifier, so this check cannot tell which providers it puts " +
          "in the root injector or whether the seal classifies them. List " +
          "each exported provider by name.",
      );
    }
    if (module.names.length === 0 && module.unreadable.length === 0) {
      failures.push(
        `${module.path} is @Global() and this check read no exports from it. A ` +
          "global module exporting nothing is unusual enough to be worth saying " +
          "out loud; if it is deliberate, the module does not need @Global().",
      );
      continue;
    }
    for (const name of module.names) {
      if (denied.has(name) || allowed.has(name)) {
        continue;
      }
      failures.push(
        `${module.path} is @Global() and exports ${name}, which ${sealPath} ` +
          "neither denies nor allows. Every provider in the root injector is one " +
          "a plugin's constructor can ask for by token, so classify it: add it " +
          "to DENIED_INJECTIONS with the reason a plugin may not hold it, or to " +
          "ALLOWED_INJECTIONS with the reason it is safe.",
      );
    }
  }

  /** The seal's own sentence about how many modules are global. */
  const claim = /(\w+) of the platform's modules are `@Global\(\)`/.exec(seal);
  if (claim === null) {
    failures.push(
      `${sealPath} no longer says how many of the platform's modules are ` +
        "@Global(), and that sentence is what a reader of the denylist takes " +
        "its completeness from.",
    );
  } else {
    const claimed = NUMBER_WORDS.get(claim[1].toLowerCase());
    if (claimed !== globals.length) {
      failures.push(
        `${sealPath} says ${claim[1]} of the platform's modules are @Global(), ` +
          `and ${String(globals.length)} are. The sentence is what a reader of ` +
          "the denylist takes its completeness from.",
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure}\n\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `Every provider ${String(globals.length)} global modules export is classified.\n`,
  );
}
