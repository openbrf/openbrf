/**
 * Builds the reference plugin and the catalog that offers it.
 *
 * The integration and end-to-end suites install a plugin the same way a board
 * does - read a catalog, download a tarball, verify its digest, unpack it, load
 * it - and they do it with no network. That is what this script produces: a
 * real npm tarball on disk and a catalog index whose artifact URL is a `file:`
 * URL pointing at it. Nothing in the install path is stubbed, so a change that
 * breaks packaging, integrity or manifest parsing fails a test instead of
 * failing an instance.
 *
 * Safe to re-run: every output is removed before it is written, and the digest
 * is recomputed from the bytes that were actually packed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "fixtures");
const pluginDir = join(fixtureRoot, "example-plugin");
const distDir = join(pluginDir, "dist");
const artifactsDir = join(fixtureRoot, ".artifacts");
const catalogDir = join(fixtureRoot, "catalog");
const catalogPath = join(catalogDir, "catalog.json");
const sdkTypes = join(repoRoot, "packages", "plugin-sdk", "dist", "index.d.ts");

/**
 * The catalog's own text.
 *
 * A curated catalog is written by whoever curates it, not generated from the
 * package it lists, so the wording lives here rather than being lifted out of
 * the plugin's locale files. Everything a board consents to - the id, the
 * version, the permissions, the personal data categories - is read from the
 * manifest below instead, because a catalog that disagreed with the manifest
 * would show a consent screen the loader then refuses to honour.
 */
const NAME = {
  sv: "Boende och lägenheter",
  en: "Occupancy",
};

const DESCRIPTION = {
  sv: "Visar antalet lägenheter, boende och medlemmar i föreningen.",
  en: "Shows the number of apartments, residents and members in the cooperative.",
};

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

// The SDK is a build-time dependency of the fixture's server source, which
// imports its types and nothing else. Built on demand rather than assumed,
// so a fresh clone can run this script as its first build.
if (!existsSync(sdkTypes)) {
  console.log("Building @openbrf/plugin-sdk, which the fixture types need.");
  run("pnpm", ["--filter", "@openbrf/plugin-sdk", "build"], repoRoot);
}

// The fixture is not a workspace member: it is packaged and installed exactly
// like a third-party plugin, so it carries its own dependency tree.
console.log("Installing the fixture's build dependencies.");
run("pnpm", ["install", "--ignore-workspace"], pluginDir);

rmSync(distDir, { recursive: true, force: true });

// The view first. Vite owns the whole output directory while it runs, so the
// server bundle is emitted into it afterwards.
console.log("Building the Module Federation remote entry.");
run("pnpm", ["exec", "vite", "build"], pluginDir);

console.log("Compiling the server bundle.");
run(
  "pnpm",
  ["exec", "tsc", "-p", join(pluginDir, "tsconfig.server.json")],
  repoRoot,
);

// tsc names its output after the source file. The manifest declares
// `dist/server.cjs`, and the extension is what makes the file CommonJS inside
// a package whose type is module - which is what the host's `require` needs.
const emitted = join(distDir, "server.js");
const serverBundle = join(distDir, "server.cjs");
if (existsSync(emitted)) {
  renameSync(emitted, serverBundle);
} else if (!existsSync(serverBundle)) {
  throw new Error(
    `tsc emitted neither ${emitted} nor ${serverBundle}. The manifest ` +
      "declares dist/server.cjs, and the loader refuses a plugin whose " +
      "declared entry is not in the package.",
  );
}

const bundleSource = readFileSync(serverBundle, "utf8");
if (!bundleSource.includes("exports.createPlugin")) {
  throw new Error(
    `${serverBundle} does not export createPlugin as CommonJS. The host ` +
      "loads it with require and reads that export.",
  );
}
// ADR 0003: a plugin ships a prebuilt bundle whose only externals are host
// packages. The check is here rather than in a test because the property is a
// property of the emit: a bundle reaching for anything else would resolve it
// from /data/plugins, where the host's node_modules cannot be seen and the
// install deliberately places no copy.
const HOST_PACKAGES = new Set(["@nestjs/common", "@nestjs/core"]);
const required = [
  ...bundleSource.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
].map(([, specifier]) => specifier);
const foreign = required.filter((specifier) => !HOST_PACKAGES.has(specifier));
if (foreign.length > 0) {
  throw new Error(
    `${serverBundle} requires ${foreign.join(", ")}. A plugin's only ` +
      `externals may be the host packages (${[...HOST_PACKAGES].join(", ")}).`,
  );
}
if (/\brequire\s*\(\s*[^"']/.test(bundleSource)) {
  throw new Error(
    `${serverBundle} contains a require call whose target is not a string ` +
      "literal, so what it resolves cannot be checked here.",
  );
}
// The bridge is what makes those requires resolve at all, so a reference
// plugin that stopped making them would stop exercising it.
if (!required.includes("@nestjs/common")) {
  throw new Error(
    `${serverBundle} does not require @nestjs/common. The reference plugin ` +
      "contributes a NestJS module, which is the contract it exists to prove.",
  );
}

rmSync(artifactsDir, { recursive: true, force: true });
mkdirSync(artifactsDir, { recursive: true });

console.log("Packing the tarball.");
const packed = capture(
  "npm",
  ["pack", "--pack-destination", artifactsDir, "--json", "--silent"],
  pluginDir,
);
const [packResult] = JSON.parse(packed);
const tarball = join(artifactsDir, packResult.filename);

const bytes = readFileSync(tarball);
const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const manifestSource = JSON.parse(
  readFileSync(join(pluginDir, "package.json"), "utf8"),
);
const manifest = manifestSource.openbrf;

const catalog = {
  version: 1,
  entries: [
    {
      type: "plugin",
      id: manifest.id,
      packageName: manifestSource.name,
      version: manifestSource.version,
      apiVersion: manifest.apiVersion,
      name: NAME,
      description: DESCRIPTION,
      permissions: manifest.permissions,
      personalData: manifest.personalData,
      artifact: {
        // Absolute, and computed here rather than written down: the harness
        // resolves it with no network, and a checked-in path would be wrong on
        // every machine but the one it was written on.
        url: pathToFileURL(tarball).href,
        sha512: digest,
        bytes: bytes.byteLength,
      },
    },
  ],
};

mkdirSync(catalogDir, { recursive: true });
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

console.log(`\nCatalog: ${catalogPath}`);
console.log(`Tarball: ${tarball}`);
console.log(`Digest:  ${digest}`);
console.log(`Bytes:   ${String(bytes.byteLength)}`);
