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

/** Whitespace and comments, which may stand between the parts of a call. */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;

/** `require` and its opening parenthesis, however they are spaced. */
const REQUIRE_CALL = new RegExp(String.raw`\brequire${GAP}\(`, "g");

/**
 * One plain string literal and the closing parenthesis, read from where a call
 * opened. Anything else there - a template, a concatenation, a name - is an
 * argument whose value is only known when the bundle runs.
 */
const LITERAL_ARGUMENT = new RegExp(
  String.raw`${GAP}(["'])((?:(?!\1)[^\\\n])+)\1${GAP}\)`,
  "y",
);

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
    const names = dependencyNames(packageJson[field]);
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
          !HOST_SHARED_PACKAGES.includes(specifier) &&
          !isNodeBuiltinModule(specifier),
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
 * Every call to require in a bundle: the specifiers written as plain string
 * literals, and whether any call's argument is something else.
 *
 * One pass finds the calls and reads each argument, so a spelling of the call
 * is either seen by both questions or by neither, and a call the literal
 * reading does not recognise is a computed one rather than no call at all.
 */
function requireCalls(source: string): {
  specifiers: string[];
  computed: boolean;
} {
  const specifiers: string[] = [];
  let computed = false;

  for (const call of source.matchAll(REQUIRE_CALL)) {
    LITERAL_ARGUMENT.lastIndex = call.index + call[0].length;
    const specifier = LITERAL_ARGUMENT.exec(source)?.[2];
    if (specifier === undefined) {
      computed = true;
    } else {
      specifiers.push(specifier);
    }
  }

  return { specifiers, computed };
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
