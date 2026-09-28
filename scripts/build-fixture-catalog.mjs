/**
 * Builds the fixture plugin and themes, and the one catalog index that offers
 * them.
 *
 * The integration and end-to-end suites install a plugin and a theme the same
 * way a board does - read a catalog, download a tarball, verify its digest,
 * unpack it, load or lint it - and they do it with no network. That is what
 * this script produces: real tarballs on disk and a catalog index in the format
 * the plugin contract documents, listing both kinds, whose artifact URLs point
 * at them. Nothing in the install path is stubbed, so a change that breaks
 * packaging, integrity or manifest parsing fails a test instead of failing an
 * instance.
 *
 * Options:
 *
 *   --out <dir>         Write the tarballs and catalog.json into <dir>. Without
 *                       it, tarballs go to fixtures/.artifacts and the index to
 *                       fixtures/catalog/catalog.json.
 *   --url-prefix <url>  What each tarball's file name is appended to in the
 *                       index. Defaults to the file URL of the directory the
 *                       tarballs are written to; a harness that mounts that
 *                       directory elsewhere passes where it is mounted.
 *   --kind <kind>       plugin, theme or all (the default). Only the plugin
 *                       needs its own toolchain installed and built; the
 *                       themes are packed with nothing but theme-tools.
 *
 * Safe to re-run: every output is removed before it is written, and each
 * digest is recomputed from the bytes that were actually packed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "fixtures");
const pluginDir = join(fixtureRoot, "example-plugin");
const themesDir = join(fixtureRoot, "themes");
const distDir = join(pluginDir, "dist");
const sdkEntry = join(repoRoot, "packages", "plugin-sdk", "dist", "index.js");
const themeToolsEntry = join(
  repoRoot,
  "packages",
  "theme-tools",
  "dist",
  "index.js",
);

const { values: options } = parseArgs({
  options: {
    out: { type: "string" },
    "url-prefix": { type: "string" },
    kind: { type: "string", default: "all" },
  },
});

if (!["plugin", "theme", "all"].includes(options.kind)) {
  throw new Error(`--kind is plugin, theme or all, not ${options.kind}.`);
}

const artifactsDir =
  options.out === undefined
    ? join(fixtureRoot, ".artifacts")
    : resolve(options.out);
const catalogPath =
  options.out === undefined
    ? join(fixtureRoot, "catalog", "catalog.json")
    : join(artifactsDir, "catalog.json");
const urlPrefix =
  options["url-prefix"] ?? `${pathToFileURL(artifactsDir).href}/`;

/**
 * The catalog's own text.
 *
 * A curated catalog is written by whoever curates it, not generated from the
 * package it lists, so the wording lives here rather than being lifted out of
 * the plugin's locale files or a theme's manifest. Everything a board consents
 * to - the id, the version, the permissions, the personal data categories - is
 * read from the manifest below instead, because a catalog that disagreed with
 * the manifest would show a consent screen the loader then refuses to honour.
 */
const PLUGIN_TEXT = {
  name: {
    sv: "Boende och lägenheter",
    en: "Occupancy",
  },
  description: {
    sv: "Visar antalet lägenheter, boende och medlemmar i föreningen.",
    en: "Shows the number of apartments, residents and members in the cooperative.",
  },
};

/** Keyed by theme id; a fixture theme without text here is refused. */
const THEME_TEXT = {
  "example-theme": {
    name: { sv: "Exempeltema", en: "Example theme" },
    description: {
      sv: "Ärver standardtemat, gör förtroendeaccenten grön och har med sig ett eget typsnitt.",
      en: "Inherits the default theme, turns the trust accent green and bundles its own typeface.",
    },
  },
  "illegible-theme": {
    name: { sv: "Oläsligt tema", en: "Illegible theme" },
    description: {
      sv: "Visar registret med kontrasten 1,1:1 och finns för att installationsspärren ska ha något att vägra.",
      en: "Renders the register at 1.1:1, and exists so the install gate has something to refuse.",
    },
  },
};

/**
 * The environment the fixture's own toolchain builds in.
 *
 * This script is run both by hand and as a child of the integration suites,
 * and a test runner announces itself in the environment it hands its children:
 * `VITEST`, `JEST_WORKER_ID`, `NODE_ENV=test`. Build tools read those markers
 * and change what they do - the Module Federation plugin disables itself
 * outright, which leaves the view build with no entry point to emit and no
 * remote entry in `dist`. What is built here is a package, not a test, so it
 * is given a build environment rather than the caller's.
 */
const buildEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("VITEST") && !name.startsWith("JEST"),
  ),
);
// Left unset rather than forced to `production`, which pnpm reads as `--prod`
// and would install none of the devDependencies the fixture builds with.
if (buildEnv.NODE_ENV === "test") delete buildEnv.NODE_ENV;

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, env: buildEnv, stdio: "inherit" });
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, env: buildEnv, encoding: "utf8" });
}

/**
 * Builds a workspace package this script imports, when it is not built yet.
 *
 * Built on demand rather than assumed, so a fresh clone can run this script as
 * its first build. The `...` selector builds the package's own workspace
 * dependencies first: theme-tools needs the tokens.
 */
async function load(entry, name) {
  if (!existsSync(entry)) {
    console.log(`Building ${name}, which this script uses.`);
    run("pnpm", ["--filter", `${name}...`, "build"], repoRoot);
  }
  return import(pathToFileURL(entry).href);
}

function digestOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Removes what an earlier run wrote, and nothing else in the directory. */
function clearOutputs() {
  if (options.out === undefined) {
    rmSync(artifactsDir, { recursive: true, force: true });
  } else if (existsSync(artifactsDir)) {
    for (const name of readdirSync(artifactsDir)) {
      if (name.endsWith(".tgz") || name === "catalog.json") {
        rmSync(join(artifactsDir, name), { force: true });
      }
    }
  }
  rmSync(catalogPath, { force: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(dirname(catalogPath), { recursive: true });
}

async function buildPlugin() {
  const { pluginPackageProblems } = await load(sdkEntry, "@openbrf/plugin-sdk");

  // The fixture is not a workspace member: it is packaged and installed exactly
  // like a third-party plugin, so it carries its own dependency tree. Its own
  // pnpm-workspace.yaml makes its directory a workspace root, which is what lets
  // a plain install resolve the fixture's dependencies and apply the fixture's
  // settings. Without that file, pnpm 12 resolves an install here against the
  // repository's workspace two directories up and links none of the fixture's
  // dependencies - `vite` included. `--ignore-workspace` is no substitute: it
  // skips the fixture's settings along with the repository's.
  console.log("Installing the fixture's build dependencies.");
  run("pnpm", ["install"], pluginDir);

  const packageJson = JSON.parse(
    readFileSync(join(pluginDir, "package.json"), "utf8"),
  );
  const manifest = packageJson.openbrf;

  rmSync(distDir, { recursive: true, force: true });

  // The view first. Vite owns the whole output directory while it runs, so the
  // server bundle is emitted into it afterwards.
  console.log("Building the Module Federation remote entry.");
  run("pnpm", ["exec", "vite", "build"], pluginDir);

  // From the fixture's own directory, like every other command here. Run from
  // the repository root it would resolve the workspace's compiler, which is not
  // the one a third-party plugin has: the fixture is packaged and installed
  // exactly as an outside package is, so it has to build with what it declares.
  console.log("Compiling the server bundle.");
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.server.json"], pluginDir);

  // tsc names its output after the source file. The manifest declares
  // `dist/server.cjs`, and the extension is what makes the file CommonJS inside
  // a package whose type is module - which is what the host's `require` needs.
  const emitted = join(distDir, "server.js");
  const serverBundle = join(distDir, "server.cjs");
  if (existsSync(emitted)) {
    renameSync(emitted, serverBundle);
  }

  console.log("Packing the tarball.");
  const [packed] = JSON.parse(
    capture(
      "npm",
      ["pack", "--pack-destination", artifactsDir, "--json", "--silent"],
      pluginDir,
    ),
  );
  const tarball = join(artifactsDir, packed.filename);

  // The contract's checks, on what was packed: the file list is npm's own
  // account of the tarball, so an entry or a locale file left out of `files`
  // is caught here rather than by the loader after an install. The same
  // function a plugin's own CI and the catalog's check run.
  const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  const bundleSource = existsSync(serverBundle)
    ? readFileSync(serverBundle, "utf8")
    : null;
  const problems = pluginPackageProblems({
    packageJson,
    files: packed.files.map((file) => file.path),
    serverBundle: bundleSource,
    locales: {
      sv: readJson(join(pluginDir, "locales", "sv.json")),
      en: readJson(join(pluginDir, "locales", "en.json")),
    },
  });
  if (problems.length > 0) {
    throw new Error(
      `The fixture plugin fails the package check:\n  ${problems.join("\n  ")}`,
    );
  }

  // Not a contract rule, a property of this fixture: the bridge is what makes a
  // plugin's requires resolve at all, so a reference plugin that stopped making
  // them would stop exercising it.
  if (!/\brequire\(\s*["']@nestjs\/common["']\s*\)/.test(bundleSource ?? "")) {
    throw new Error(
      `${serverBundle} does not require @nestjs/common. The reference plugin ` +
        "contributes a NestJS module, which is the contract it exists to prove.",
    );
  }

  const bytes = readFileSync(tarball);
  console.log(`Plugin:  ${tarball}`);

  return {
    type: "plugin",
    id: manifest.id,
    packageName: packageJson.name,
    version: packageJson.version,
    apiVersion: manifest.apiVersion,
    ...PLUGIN_TEXT,
    permissions: manifest.permissions,
    personalData: manifest.personalData,
    // The third part of the declaration, copied for the same reason: the
    // consent screen renders from the catalog, before anything is
    // downloaded, and the install echo compares what it showed.
    actions: manifest.actions ?? [],
    // Copied for the same reason, and it decides a refusal rather than a
    // display: an install is refused outright when a second plugin declares
    // the sign-in address, so a fixture that lost the field would make that
    // refusal look untested end to end.
    ...(manifest.oauthProtectedResource === undefined
      ? {}
      : { oauthProtectedResource: manifest.oauthProtectedResource }),
    artifact: {
      url: `${urlPrefix}${packed.filename}`,
      sha512: digestOf(bytes),
      bytes: bytes.byteLength,
    },
  };
}

/** Every file under a directory, keyed by its package path. */
function collectFiles(directory, base = directory) {
  const files = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [path, contents] of collectFiles(full, base)) {
        files.set(path, contents);
      }
      continue;
    }
    files.set(
      relative(base, full).split(sep).join("/"),
      new Uint8Array(readFileSync(full)),
    );
  }
  return files;
}

/**
 * Packs every theme under fixtures/themes.
 *
 * A fixture directory holds the theme's own files plus an optional
 * `fixture.json` naming files to copy in from elsewhere in the repository. That
 * exists for exactly one thing: the example theme bundles a real font, and
 * committing a second copy of a font the core already ships would be dead
 * weight. `fixture.json` is not part of the theme package format and never
 * reaches the archive.
 */
async function buildThemes() {
  const { writeThemeArchive } = await load(
    themeToolsEntry,
    "@openbrf/theme-tools",
  );

  const entries = [];
  for (const directory of readdirSync(themesDir, { withFileTypes: true })) {
    if (!directory.isDirectory()) {
      continue;
    }

    const files = collectFiles(join(themesDir, directory.name));
    const sidecar = files.get("fixture.json");
    files.delete("fixture.json");
    if (sidecar !== undefined) {
      const { include = {} } = JSON.parse(new TextDecoder().decode(sidecar));
      for (const [path, from] of Object.entries(include)) {
        files.set(path, new Uint8Array(readFileSync(join(repoRoot, from))));
      }
    }

    const manifestFile = files.get("theme.json");
    if (manifestFile === undefined) {
      throw new Error(`Fixture ${directory.name} has no theme.json.`);
    }
    const manifest = JSON.parse(new TextDecoder().decode(manifestFile));
    const text = THEME_TEXT[manifest.name];
    if (text === undefined) {
      throw new Error(
        `Fixture theme ${manifest.name} has no catalog text. Add its Swedish ` +
          "and English name and description to THEME_TEXT.",
      );
    }

    const archive = writeThemeArchive(files);
    const fileName = `${manifest.name}-${manifest.version}.tgz`;
    writeFileSync(join(artifactsDir, fileName), archive);
    console.log(`Theme:   ${join(artifactsDir, fileName)}`);

    entries.push({
      type: "theme",
      id: manifest.name,
      version: manifest.version,
      ...text,
      contract: manifest.contract,
      ...(manifest.extends === undefined ? {} : { extends: manifest.extends }),
      artifact: {
        url: `${urlPrefix}${fileName}`,
        sha512: digestOf(archive),
        bytes: archive.byteLength,
      },
    });
  }
  return entries;
}

clearOutputs();

const entries = [
  ...(options.kind === "theme" ? [] : [await buildPlugin()]),
  ...(options.kind === "plugin" ? [] : await buildThemes()),
].sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(
  catalogPath,
  `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  "utf8",
);

console.log(`Catalog: ${catalogPath}`);
