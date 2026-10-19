/**
 * Writes the code map: each API module with what it owns, and every name the
 * repository exports, by file.
 *
 * The map answers "does this already exist" for the whole repository with one
 * search over docs/code-map/, in a fresh clone and with nothing but a shell. It
 * is generated because a list kept by hand beside the code drifts the day
 * somebody adds a file, and a stale map is worse than none: it says a thing
 * does not exist when it does.
 *
 * `node scripts/code-map.mjs` writes it. `--check` writes nothing and fails
 * when the committed map differs from what the source gives, which is what
 * `pnpm lint:guards` runs.
 *
 * What the map says about a module is the first paragraph of the doc comment
 * above its `@Module`, so that comment is where to change it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as prettier from "prettier";

import {
  isGlobal,
  moduleArrays,
  withoutComments,
} from "./check-plugin-injections.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mapDirectory = "docs/code-map";

/** Directories that hold no source of the repository's own. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "generated",
  "coverage",
  ".turbo",
]);

/**
 * Whether a file is source the map lists: TypeScript that ships, or that a
 * suite imports, and not a suite itself.
 */
export function isMappedSource(name) {
  return (
    /\.tsx?$/.test(name) &&
    !name.endsWith(".d.ts") &&
    !/\.(spec|int-spec|test)\.tsx?$/.test(name)
  );
}

/** Every mapped file under a directory, as repository paths in code-unit order. */
function sourcesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(join(repoRoot, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...sourcesUnder(path));
      }
    } else if (entry.isFile() && isMappedSource(entry.name)) {
      found.push(path);
    }
  }
  return found.sort(byCodeUnits);
}

/** Ordering that does not depend on the machine's locale. */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The names a file declares as exports, in the order it declares them.
 *
 * A re-export from another file (`export { a } from "./a"`) is left out: the
 * name is listed where it is defined, which is where a reader has to go. A
 * local export list (`export { a }`) and a destructured declaration are read
 * like the declarations they name. A default export is listed by its name when
 * it has one, and as `default` when it does not.
 *
 * Read from statements that start a line, as the formatter leaves every
 * top-level export. Comments are not stripped from the whole file first: a
 * string such as `"**\/*.ts"` opens what a stripper takes for a block comment,
 * and the exports after it would vanish.
 *
 * A named declaration whose name this cannot read throws rather than being
 * skipped, because a skipped name is one the map says does not exist.
 */
export function declaredExports(source) {
  const names = [];
  const add = (name) => {
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !names.includes(name)) {
      names.push(name);
    }
  };
  const entriesOf = (list) => withoutComments(list).split(",");

  const statements =
    /^export\s+(?:type\s+)?\{([^}]*)\}(\s*from\b)?|^export\s+(?:declare\s+)?(default\s+)?(?:(?:abstract\s+)?class|(?:async\s+)?function|const\s+enum|enum|const|let|var|type|interface|namespace)\b\s*\*?\s*(\{|[A-Za-z_$][\w$]*)?|^export\s+default\b/gm;

  for (const match of source.matchAll(statements)) {
    const [statement, listed, reexport, isDefault, declared] = match;
    if (listed !== undefined) {
      if (reexport === undefined) {
        for (const entry of entriesOf(listed)) {
          add(
            entry
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)
              .at(-1),
          );
        }
      }
      continue;
    }
    if (declared === "{") {
      const start = match.index + statement.length;
      for (const entry of entriesOf(
        source.slice(start, source.indexOf("}", start)),
      )) {
        const [key, renamed] = entry.replace(/=[\s\S]*$/, "").split(":");
        add((renamed ?? key).trim().replace(/^\.\.\./, ""));
      }
      continue;
    }
    if (declared !== undefined) {
      add(declared);
    } else if (
      isDefault !== undefined ||
      /^export\s+default$/.test(statement)
    ) {
      add("default");
    } else {
      throw new Error(
        `cannot read the name this export declares: ${source.slice(match.index).split("\n")[0]}`,
      );
    }
  }
  return names;
}

/**
 * How one entry of a module's array reads in the map.
 *
 * A bare identifier is itself; `forwardRef(() => X)` is X; a dynamic module's
 * `X.forRoot(...)` is `X.forRoot()`; a `{ provide }` object is its token, with
 * the class it uses when it names one.
 */
export function moduleEntryName(entry) {
  const text = entry.replace(/\s+/g, " ").trim();
  const forward = /^forwardRef\(\s*\(\)\s*=>\s*([\w$.]+)\s*\)$/.exec(text);
  if (forward !== null) {
    return forward[1];
  }
  const provide = /^\{\s*provide:\s*([^,}]+?)\s*[,}]/.exec(text);
  if (provide !== null) {
    const uses = /\buse(?:Class|Existing):\s*([\w$.]+)/.exec(text);
    return uses === null ? provide[1] : `${uses[1]} as ${provide[1]}`;
  }
  const call = /^([\w$.]+)\(/.exec(text);
  if (call !== null) {
    return `${call[1]}()`;
  }
  return text;
}

/**
 * The first paragraph of the doc comment directly above a position, on one
 * line, or null when there is none. A `@Global()` between the comment and the
 * position belongs to the same declaration and is stepped over.
 */
export function summaryAbove(source, position) {
  const before = source
    .slice(0, position)
    .trimEnd()
    .replace(/@Global\(\)$/, "")
    .trimEnd();
  if (!before.endsWith("*/")) {
    return null;
  }
  const start = before.lastIndexOf("/**");
  if (start === -1) {
    return null;
  }
  const body = before
    .slice(start + 3, -2)
    .split("\n")
    .map((line) => line.replace(/^\s*\*( |$)/, ""))
    .join("\n")
    .trim();
  const paragraph = body
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  return paragraph === "" ? null : paragraph;
}

/**
 * What a module file declares: the class, whether it is global, the summary
 * from its doc comment, and the four arrays of its `@Module`. Null for a file
 * without one.
 */
export function moduleOf(source) {
  const at = source.indexOf("@Module(");
  if (at === -1) {
    return null;
  }
  const decorator = withoutComments(source.slice(at));
  const classAt = decorator.search(/\bclass\s/);
  const argument = classAt === -1 ? decorator : decorator.slice(0, classAt);
  const arrays = (key) =>
    moduleArrays(argument, key).flatMap((array) =>
      array.entries === undefined
        ? [array.other]
        : array.entries.map(moduleEntryName),
    );
  return {
    name: /\bclass\s+([A-Za-z_$][\w$]*)/.exec(decorator)?.[1] ?? null,
    global: isGlobal(withoutComments(source)),
    summary: summaryAbove(source, at),
    imports: arrays("imports"),
    controllers: arrays("controllers"),
    providers: arrays("providers"),
    exports: arrays("exports"),
  };
}

const code = (text) => `\`${text}\``;
const codeList = (items) => items.map(code).join(", ");

/** One list line per file that exports anything. */
function fileLines(paths) {
  const lines = [];
  for (const path of paths) {
    let names;
    try {
      names = declaredExports(readFileSync(join(repoRoot, path), "utf8"));
    } catch (error) {
      throw new Error(`${path}: ${error.message}`, { cause: error });
    }
    if (names.length > 0) {
      lines.push(`- ${code(path)}: ${codeList(names)}`);
    }
  }
  return lines;
}

/**
 * Sources grouped by the first directory under a root, the root's own files
 * first under the root itself.
 */
function groupedByDirectory(root) {
  const groups = new Map();
  for (const path of sourcesUnder(root)) {
    const rest = path.slice(root.length + 1);
    const key = rest.includes("/") ? `${root}/${rest.split("/")[0]}` : root;
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  return [...groups.entries()].sort(([a], [b]) => byCodeUnits(a, b));
}

const HEADER = (title, scope) => [
  `# ${title}`,
  "",
  `Generated from the source by \`pnpm code-map\`; \`pnpm lint:guards\` fails when it is stale. ${scope} Change the source and regenerate rather than editing this file.`,
  "",
];

function apiMap() {
  const lines = HEADER(
    "Code map: the API",
    "One section per directory of `apps/api/src`: the NestJS module it holds, if any, and every name each file exports. Suites are left out.",
  );
  for (const [directory, paths] of groupedByDirectory("apps/api/src")) {
    lines.push(`## ${code(directory)}`, "");
    for (const path of paths.filter((path) => path.endsWith(".module.ts"))) {
      const module = moduleOf(readFileSync(join(repoRoot, path), "utf8"));
      if (module === null) {
        continue;
      }
      lines.push(
        `${code(module.name ?? "(unnamed module)")} in ${code(path)}${module.global ? ", global" : ""}.${module.summary === null ? "" : ` ${module.summary}`}`,
        "",
      );
      const arrays = [
        ["Imports", module.imports],
        ["Controllers", module.controllers],
        ["Providers", module.providers],
        ["Exports", module.exports],
      ].filter(([, entries]) => entries.length > 0);
      if (arrays.length > 0) {
        for (const [label, entries] of arrays) {
          lines.push(`- ${label}: ${codeList(entries)}`);
        }
        lines.push("");
      }
    }
    const files = fileLines(paths);
    if (files.length > 0) {
      lines.push("Exports by file:", "", ...files, "");
    }
  }
  return lines.join("\n");
}

/** A map of one source root, a section per directory under it. */
function directoriesMap(title, root) {
  const lines = HEADER(
    title,
    `One section per directory of \`${root}\`, listing every name each file exports. Suites are left out.`,
  );
  for (const [directory, paths] of groupedByDirectory(root)) {
    const files = fileLines(paths);
    if (files.length > 0) {
      lines.push(`## ${code(directory)}`, "", ...files, "");
    }
  }
  return lines.join("\n");
}

function packagesMap() {
  const lines = HEADER(
    "Code map: the packages",
    "One section per package under `packages/`: whether it is published, its entry points, and every name each file exports. A name is importable from the package only when an entry point exports it.",
  );
  const directories = readdirSync(join(repoRoot, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byCodeUnits);
  for (const directory of directories) {
    const manifest = JSON.parse(
      readFileSync(
        join(repoRoot, "packages", directory, "package.json"),
        "utf8",
      ),
    );
    // A string or a top-level condition object (`import`, `default`) exports
    // the package root only; subpath keys all start with a dot.
    const subpaths =
      manifest.exports !== null &&
      typeof manifest.exports === "object" &&
      !Array.isArray(manifest.exports) &&
      Object.keys(manifest.exports).some((key) => key.startsWith("."))
        ? Object.keys(manifest.exports)
        : ["."];
    const entryPoints = subpaths.map((entry) =>
      entry === "."
        ? manifest.name
        : `${manifest.name}/${entry.replace(/^\.\//, "")}`,
    );
    lines.push(
      `## ${code(manifest.name)}`,
      "",
      `${manifest.private ? "Private" : "Published"}, in ${code(`packages/${directory}`)}. Entry points: ${codeList(entryPoints)}.`,
      "",
      ...fileLines(sourcesUnder(`packages/${directory}/src`)),
      "",
    );
  }
  return lines.join("\n");
}

/** Each map file, formatted the way `pnpm format:check` expects it. */
async function renderedMaps() {
  const maps = [
    ["api.md", apiMap()],
    ["e2e.md", directoriesMap("Code map: the end-to-end suite", "e2e/src")],
    ["packages.md", packagesMap()],
    ["web.md", directoriesMap("Code map: the web application", "apps/web/src")],
  ];
  const rendered = [];
  for (const [name, text] of maps) {
    const path = join(repoRoot, mapDirectory, name);
    const options = (await prettier.resolveConfig(path)) ?? {};
    rendered.push([
      path,
      await prettier.format(text, { ...options, filepath: path }),
    ]);
  }
  return rendered;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [path, text] of await renderedMaps()) {
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // A missing map file is a stale one.
    }
    if (current === text) {
      continue;
    }
    stale.push(relative(repoRoot, path));
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }

  if (check && stale.length > 0) {
    process.stderr.write(
      `The code map does not match the source: ${stale.join(", ")}.\n` +
        "Run `pnpm code-map` and commit the result. On a merge conflict in " +
        "the map, take either side and run it again.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    check
      ? "The code map matches the source.\n"
      : stale.length === 0
        ? "The code map was already current.\n"
        : `Wrote ${stale.join(", ")}.\n`,
  );
}
