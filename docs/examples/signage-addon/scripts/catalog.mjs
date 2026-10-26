import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  formatSha512,
  parseCatalogIndex,
  pluginPackageProblems,
} from "@openbrf/plugin-sdk";

/**
 * Packs the addon and writes a catalog index that lists it, so an instance can
 * install it the way it installs anything from the catalog: consent screen,
 * download, digest check, npm, boot.
 *
 *   node scripts/catalog.mjs [--out <dir>] [--url-prefix <url>] [--merge <index>]
 *
 * --out         Where the tarball and catalog-v2.json go. `catalog/` by default.
 * --url-prefix  What the tarball's file name is appended to in the index. The
 *               file URL of --out by default; pass where an instance reaches
 *               the directory when it is served or mounted elsewhere.
 * --merge       Another index whose entries are listed beside this one, such
 *               as one that lists the `signage` plugin itself. An instance
 *               reads one index, and the addon serves only beside its host.
 *
 * Point the instance at the index with OPENBRF_CATALOG_URL, and turn on
 * OPENBRF_UNCURATED_PLUGINS_ENABLED, which an index other than the curated one
 * needs.
 *
 * The package is held to the SDK's own check first, the one the catalog runs
 * before it lists a plugin, and the index to the parser an instance reads it
 * with.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values: options } = parseArgs({
  options: {
    out: { type: "string", default: join(root, "catalog") },
    "url-prefix": { type: "string" },
    merge: { type: "string" },
  },
});

const out = resolve(options.out);
const urlPrefix = options["url-prefix"] ?? `${pathToFileURL(out).href}/`;
mkdirSync(out, { recursive: true });

execFileSync("node", ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });

const [packed] = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--pack-destination", out, "--json", "--silent"],
    { cwd: root, encoding: "utf8" },
  ),
);

const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const packageJson = readJson("package.json");
const problems = pluginPackageProblems({
  packageJson,
  files: packed.files.map((file) => file.path),
  serverBundle: readFileSync(join(root, "dist", "server.cjs"), "utf8"),
  locales: { sv: readJson("locales/sv.json"), en: readJson("locales/en.json") },
});
if (problems.length > 0) {
  throw new Error(`The package fails the check:\n  ${problems.join("\n  ")}`);
}

const bytes = readFileSync(join(out, packed.filename));
const manifest = packageJson.openbrf;
const entry = {
  type: "plugin",
  id: manifest.id,
  packageName: packageJson.name,
  version: packageJson.version,
  apiVersion: manifest.apiVersion,
  // A curated catalog's name and description are the curator's words, not
  // the package's; these stand in for them.
  name: { sv: "Regler för tvättstugan", en: "Laundry room rules" },
  description: {
    sv: "Ett exempel på en utökning till digital skyltning: visar tvättstugans regler och öppettider på skärmarna inne i huset.",
    en: "A sample addon to digital signage: shows the laundry room's rules and opening hours on the screens inside the building.",
  },
  // What the board consents to is copied from the manifest, so the consent
  // screen shows what the loader then holds the package to.
  permissions: manifest.permissions,
  personalData: manifest.personalData,
  actions: [],
  extends: manifest.extends,
  artifact: {
    url: `${urlPrefix}${packed.filename}`,
    sha512: formatSha512(createHash("sha512").update(bytes).digest()),
    bytes: bytes.byteLength,
  },
};

const merged =
  options.merge === undefined
    ? []
    : JSON.parse(readFileSync(resolve(options.merge), "utf8")).entries.filter(
        (other) => other.id !== entry.id,
      );
const index = {
  version: 2,
  entries: [...merged, entry].sort((a, b) => a.id.localeCompare(b.id)),
};
const parsed = parseCatalogIndex(index);
if (!parsed.ok) {
  throw new Error(
    `An instance would refuse the index:\n  ${parsed.issues.join("\n  ")}`,
  );
}

const catalogPath = join(out, "catalog-v2.json");
writeFileSync(catalogPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`Package: ${join(out, packed.filename)}`);
console.log(`Catalog: ${catalogPath}`);
