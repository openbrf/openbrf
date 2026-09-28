import { parsePluginPackage } from "./manifest.ts";

/**
 * The checks a plugin package passes before it is listed.
 *
 * Everything here is something an instance would otherwise find out after the
 * board had consented and the application had restarted: a dependency the
 * installer cannot fetch without a registry, a bundle reaching for a module it
 * cannot resolve from the data volume, an entry the loader cannot find. Run
 * against the packed tarball rather than the working tree, it answers whether
 * what is published is installable, which is what a plugin's own CI and the
 * catalog's check both need to know.
 *
 * It answers nothing about whether the package is safe. A plugin runs in the
 * host's process with its privileges (ADR 0003), every Node built-in is open
 * to it, and code has more ways to load a module than any reading of the
 * source can follow. A package that passes installs and loads; what it does
 * once loaded is for a person reading its code before it is listed.
 *
 * Pure: the caller reads the package and hands its contents in, so the same
 * function serves a script, a test and a check that has the archive in
 * memory.
 */

/**
 * Packages a plugin must share with the host rather than carry its own copy of.
 *
 * Two reasons a package belongs here, and they are different.
 *
 * The Nest packages hold process-wide state - a DI container, a metadata
 * registry - so a second copy is not a duplicate but a second and disconnected
 * system: decorators from one are invisible to the other.
 *
 * zod holds no state at all, and is here for a reason about identity rather
 * than about state. An action's input and output schemas cross from the plugin
 * into the host, which converts them to the JSON Schema a caller is published
 * and validates against them on every call. A schema built by a second copy
 * carries that copy's internals, so the host's realm check refuses it and its
 * converter could not read it. What matters here is therefore which module the
 * object came from, not what that module remembers.
 *
 * With Node's built-in modules, they are also the only modules a server bundle
 * may require: an installed plugin sits on the data volume, where nothing but
 * these, bridged in from the host, and the built-ins can be resolved.
 */
export const HOST_SHARED_PACKAGES: readonly string[] = [
  "@nestjs/common",
  "@nestjs/core",
  "zod",
];

/** A plugin package as the check reads it. */
export interface PluginPackageContents {
  /** The package's `package.json`, parsed. */
  packageJson: unknown;
  /**
   * Every file in the package, relative to its root and separated by forward
   * slashes: `package.json`, `dist/server.cjs`, `locales/sv.json`.
   */
  files: readonly string[];
  /** The source of the declared server entry, or null when there is none. */
  serverBundle: string | null;
  /** The two locale files, parsed; a missing file is left undefined. */
  locales: { sv?: unknown; en?: unknown };
}

/**
 * Dependency fields npm installs at install time.
 *
 * The installer omits peer, dev and optional dependencies and runs no scripts,
 * but it still hands npm the package: anything listed here would send that npm
 * to a registry, which an instance never contacts. optionalDependencies is
 * listed although it is omitted, because a package relying on one being
 * present works in development and quietly not on an instance.
 */
const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

/**
 * Words after which a `/` opens a regular expression rather than dividing.
 *
 * After any other word, a number, a string or a closing bracket it divides.
 * Getting this wrong only matters inside the one line the misread literal
 * sits on, because a string never runs past the end of its line.
 */
const KEYWORDS_BEFORE_EXPRESSION: ReadonlySet<string> = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$‌‍]/u;

/**
 * Every problem that would stop a package installing or loading, one English
 * sentence each, for an author's terminal. Empty when there is none.
 */
export function pluginPackageProblems(
  contents: PluginPackageContents,
): readonly string[] {
  const problems: string[] = [];
  const packageJson = asRecord(contents.packageJson);

  const parsed = parsePluginPackage(contents.packageJson);
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      problems.push(`The manifest in package.json is invalid at ${issue}.`);
    }
  }

  problems.push(...dependencyProblems(packageJson));

  if (parsed.ok) {
    const entries = parsed.value.openbrf.entry;
    const files = new Set(contents.files.map(normalizedPath));
    for (const [kind, declared] of [
      ["server", entries.server],
      ["client", entries.client],
    ] as const) {
      if (declared !== undefined && !files.has(normalizedPath(declared))) {
        problems.push(
          `The manifest declares ${declared} as the ${kind} entry, and the package does not contain it.`,
        );
      }
    }

    if (entries.server !== undefined && contents.serverBundle !== null) {
      problems.push(...serverBundleProblems(contents.serverBundle));
    }
  }

  problems.push(...localeProblems(contents));

  return problems;
}

function dependencyProblems(
  packageJson: Record<string, unknown> | null,
): string[] {
  if (packageJson === null) {
    return [];
  }

  const problems: string[] = [];
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    // A host package gets its own sentence below, which says what to do
    // instead; naming it here as well would report one entry twice.
    const names = dependencyNames(packageJson[field]).filter(
      (name) => !HOST_SHARED_PACKAGES.includes(name),
    );
    if (names.length > 0) {
      problems.push(
        `package.json lists ${names.join(", ")} under ${field}. A plugin declares no runtime dependencies: the installer's npm would fetch them from a registry, which an instance never contacts.`,
      );
    }
  }

  for (const host of HOST_SHARED_PACKAGES) {
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      if (dependencyNames(packageJson[field]).includes(host)) {
        problems.push(
          `package.json lists ${host} under ${field}. The host shares its own copy, so declare it under peerDependencies and never bundle it.`,
        );
      }
    }
  }

  return problems;
}

/** Package names in a dependency field, whether a map or npm's bundle list. */
function dependencyNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((name): name is string => typeof name === "string");
  }
  const record = asRecord(value);
  return record === null ? [] : Object.keys(record);
}

function serverBundleProblems(source: string): string[] {
  const problems: string[] = [];
  const { specifiers, computed } = requireCalls(source);

  const foreign = [
    ...new Set(
      specifiers.filter(
        (specifier) =>
          !isHostPackage(specifier) && !isNodeBuiltinModule(specifier),
      ),
    ),
  ];
  if (foreign.length > 0) {
    problems.push(
      `The server bundle requires ${foreign.join(", ")}. Its only externals may be the host packages (${HOST_SHARED_PACKAGES.join(", ")}) and Node's built-in modules; an installed plugin cannot resolve anything else.`,
    );
  }

  if (computed) {
    problems.push(
      "The server bundle calls require with something other than a string literal, so what it loads cannot be checked.",
    );
  }

  if (!source.includes("exports.createPlugin")) {
    problems.push(
      "The server bundle does not assign exports.createPlugin. The host loads it with require and reads that export.",
    );
  }

  return problems;
}

/**
 * Whether a specifier names a host package or a path inside one.
 *
 * `zod/v4` resolves through the same bridge as `zod`: the bridge makes the
 * host's node_modules a fallback for every lookup, not for a list of names.
 */
function isHostPackage(specifier: string): boolean {
  return HOST_SHARED_PACKAGES.some(
    (host) => specifier === host || specifier.startsWith(`${host}/`),
  );
}

/**
 * Every call to require in a bundle: the specifiers written as plain string
 * literals, and whether any call's argument is something else.
 *
 * One pass finds the calls and reads each argument, so a spelling of the call
 * is either seen by both questions or by neither, and a call the literal
 * reading does not recognise is a computed one rather than no call at all.
 *
 * A scanner rather than a regular expression, for two reasons. The bundle is
 * a file someone outside the project submits, and a pattern that lets
 * comments stand between `require` and its parenthesis can be made to
 * backtrack for hours; this reads each character a bounded number of times.
 * And it knows where code is: `require(` inside a comment, a string, template
 * text or a regular expression is not a call, and neither is a method of that
 * name on some other object. `module.require` is the one exception, since it
 * is the same loader under another name.
 */
function requireCalls(source: string): {
  specifiers: string[];
  computed: boolean;
} {
  const specifiers: string[] = [];
  let computed = false;

  /** The last three words or punctuators seen, newest last. */
  const recent: string[] = [];
  const remember = (token: string): void => {
    recent.push(token);
    if (recent.length > 3) {
      recent.shift();
    }
  };
  const previous = (back: number): string | undefined => recent.at(-back);

  /** Brace depth, and the depths at which a template's `${` was opened. */
  let depth = 0;
  const substitutions: number[] = [];

  /** Skips template text; code resumes after it, inside a `${` or not. */
  const templateText = (from: number): number => {
    const end = afterTemplateText(source, from);
    if (source[end - 1] === "{") {
      depth += 1;
      substitutions.push(depth);
      remember("{");
    } else {
      remember("literal");
    }
    return end;
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "/" && (next === "/" || next === "*")) {
      index = afterComment(source, index);
    } else if (char === '"' || char === "'") {
      index = afterString(source, index).end;
      remember("literal");
    } else if (char === "`") {
      index = templateText(index + 1);
    } else if (char === "/" && startsExpression(previous(1))) {
      index = afterRegularExpression(source, index);
      remember("literal");
    } else if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (
        end < source.length &&
        IDENTIFIER_PART.test(source[end] as string)
      ) {
        end += 1;
      }
      const word = source.slice(index, end);
      if (word === "require" && isLoaderReference(previous)) {
        const argument = requireArgument(source, end);
        if (argument === "not-a-call") {
          // `typeof require`, `require.resolve`: named, not called.
        } else if (argument === null) {
          computed = true;
        } else {
          specifiers.push(argument);
        }
      }
      remember(word);
      index = end;
    } else if (/[0-9]/.test(char)) {
      index += 1;
      while (index < source.length && /[\w.]/.test(source[index] as string)) {
        index += 1;
      }
      remember("literal");
    } else if (char === "}" && substitutions.at(-1) === depth) {
      // The end of a template's `${ }`: its text resumes here.
      substitutions.pop();
      depth -= 1;
      index = templateText(index + 1);
    } else {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      remember(source.startsWith("...", index) ? "..." : char);
      index += source.startsWith("...", index) ? 3 : 1;
    }
  }

  return { specifiers, computed };
}

/**
 * Whether a `require` the scanner reached names the loader: a bare name, or
 * `module.require`, but not `function require` or another object's method.
 */
function isLoaderReference(
  previous: (back: number) => string | undefined,
): boolean {
  if (previous(1) === "function") {
    return false;
  }
  if (previous(1) !== ".") {
    return true;
  }
  return previous(2) === "module" && previous(3) !== ".";
}

/** Whether a `/` after this token opens a regular expression. */
function startsExpression(token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  if (token === "literal" || token === ")" || token === "]" || token === "}") {
    return false;
  }
  if (IDENTIFIER_START.test(token.charAt(0))) {
    return KEYWORDS_BEFORE_EXPRESSION.has(token);
  }
  return true;
}

/**
 * What a `require` is called with, read from just after the word: the
 * specifier when it is one plain string literal and nothing else, null when
 * it is anything else, and "not-a-call" when no parenthesis follows.
 */
function requireArgument(source: string, from: number): string | null {
  let index = afterGap(source, from);
  if (source[index] !== "(") {
    return "not-a-call";
  }
  index = afterGap(source, index + 1);
  const quote = source[index];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const literal = afterString(source, index);
  if (!literal.plain || literal.end - index <= 2) {
    return null;
  }
  if (source[afterGap(source, literal.end)] !== ")") {
    return null;
  }
  return source.slice(index + 1, literal.end - 1);
}

/** Past whitespace and comments, which may stand between parts of a call. */
function afterGap(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
    } else if (
      char === "/" &&
      (source[index + 1] === "/" || source[index + 1] === "*")
    ) {
      index = afterComment(source, index);
    } else {
      break;
    }
  }
  return index;
}

/** Past the comment starting at `from`, which is a `/` followed by `/` or `*`. */
function afterComment(source: string, from: number): number {
  if (source[from + 1] === "/") {
    const end = source.indexOf("\n", from + 2);
    return end === -1 ? source.length : end + 1;
  }
  const end = source.indexOf("*/", from + 2);
  return end === -1 ? source.length : end + 2;
}

/**
 * Past the string literal opening at `from`, and whether it was plain: no
 * escape inside it, and closed on the line it opened on. An unclosed string
 * ends at the line break, so a misread quote costs one line at most.
 */
function afterString(
  source: string,
  from: number,
): { end: number; plain: boolean } {
  const quote = source[from];
  let plain = true;
  let index = from + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      plain = false;
      index += 2;
    } else if (char === quote) {
      return { end: index + 1, plain };
    } else if (char === "\n") {
      return { end: index, plain: false };
    } else {
      index += 1;
    }
  }
  return { end: source.length, plain: false };
}

/**
 * Past template text starting at `from`: to just after the closing backtick,
 * or just after a `${`, where code resumes.
 */
function afterTemplateText(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
    } else if (char === "`") {
      return index + 1;
    } else if (char === "$" && source[index + 1] === "{") {
      return index + 2;
    } else {
      index += 1;
    }
  }
  return source.length;
}

/** Past the regular expression literal opening at `from`, flags included. */
function afterRegularExpression(source: string, from: number): number {
  let index = from + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      return index;
    }
    if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /\w/.test(source[index] as string)) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return source.length;
}

/**
 * Whether a specifier names one of Node's built-in modules.
 *
 * A built-in resolves from any directory, the data volume included, and a
 * plugin already runs in the host's process, so requiring one is outside what
 * the host-package rule exists for.
 */
function isNodeBuiltinModule(specifier: string): boolean {
  return specifier.startsWith("node:") || nodeBuiltinModules().has(specifier);
}

let builtinModules: ReadonlySet<string> | undefined;

/**
 * `module.builtinModules`, read through `process.getBuiltinModule`.
 *
 * Not imported from `node:module`: this package is also bundled into the
 * browser for its constants, where that module does not exist. Outside Node
 * the set is empty, and only a `node:` specifier is recognised.
 */
function nodeBuiltinModules(): ReadonlySet<string> {
  if (builtinModules === undefined) {
    const host = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => unknown };
      }
    ).process;
    const moduleApi = host?.getBuiltinModule?.("node:module") as
      { builtinModules?: readonly string[] } | undefined;
    builtinModules = new Set(moduleApi?.builtinModules ?? []);
  }
  return builtinModules;
}

function localeProblems(contents: PluginPackageContents): string[] {
  const problems: string[] = [];
  const files = new Set(contents.files.map(normalizedPath));

  const keys: Partial<Record<"sv" | "en", ReadonlySet<string>>> = {};
  for (const language of ["sv", "en"] as const) {
    const path = `locales/${language}.json`;
    const parsed = contents.locales[language];
    if (!files.has(path) || parsed === undefined) {
      problems.push(`The package has no ${path}.`);
      continue;
    }
    const record = asRecord(parsed);
    if (record === null) {
      problems.push(`${path} is not a JSON object of translation keys.`);
      continue;
    }
    keys[language] = new Set(leafKeys(record));
  }

  const { sv, en } = keys;
  if (sv !== undefined && en !== undefined) {
    const missingFromSv = [...en].filter((key) => !sv.has(key));
    const missingFromEn = [...sv].filter((key) => !en.has(key));
    if (missingFromSv.length > 0) {
      problems.push(
        `locales/sv.json lacks ${missingFromSv.join(", ")}, which locales/en.json has. The two carry identical keys.`,
      );
    }
    if (missingFromEn.length > 0) {
      problems.push(
        `locales/en.json lacks ${missingFromEn.join(", ")}, which locales/sv.json has. The two carry identical keys.`,
      );
    }
  }

  return problems;
}

/** Dotted paths to every value that is not itself a nested object. */
function leafKeys(record: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const nested = asRecord(value);
    return nested === null ? [path] : leafKeys(nested, path);
  });
}

/** A package path without `./` or empty segments, as a file list spells it. */
function normalizedPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
