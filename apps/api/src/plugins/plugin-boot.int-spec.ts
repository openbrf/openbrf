import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PluginHost } from "@openbrf/plugin-sdk";
import {
  PluginHostUnavailableError,
  PluginPermissionError,
} from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import type { Env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";
import { dataPaths } from "../packaging/data-paths";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  type BootPlugin,
  loadPlugins,
  type PluginBoot,
  type PluginFinding,
} from "./plugin-boot";
import { PluginHostBinding } from "./plugin-host";
import { PluginLoaderService } from "./plugin-loader.service";
import { PLUGIN_ID_METADATA } from "./plugin-module-seal";
import { PluginRegistryService } from "./plugin-registry.service";
import { PluginSettingsService } from "./plugin-settings.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";

/**
 * Loading plugins at boot, against a real database and a real directory of
 * packages.
 *
 * Everything here turns on one rule from ADR 0003: a malformed or refused
 * plugin is skipped and reported, never fatal. A broken plugin must not be
 * able to take the association's register offline, so the decisive assertion
 * is not that a bad plugin is rejected - it is that a good one in the same
 * tree still loads.
 *
 * The packages below are real CommonJS bundles that require @nestjs/common,
 * because that is what a plugin contributing a NestJS module does. That makes
 * this suite an exercise of the resolution bridge as well: without it the
 * requires would fail, since CJS resolution walks up from the temporary
 * directory these are written into and never reaches the host's node_modules.
 */

const env = loadEnvForIntegrationTests();

/*
 * Per-run identifiers. The suite writes its own packages, its own consent rows
 * and its own findings, and cleans them all up by id: a fixed id makes two
 * overlapping runs against the same database each other's cleanup, and the
 * failure that produces names a plugin neither run was testing.
 */
const SUFFIX = runSuffix();
const GOOD = `boot-good-${SUFFIX}`;
const BROKEN = `boot-broken-${SUFFIX}`;
const DISABLED = `boot-disabled-${SUFFIX}`;
const WIDENED = `boot-widened-${SUFFIX}`;
const REFUSED = `boot-refused-${SUFFIX}`;
const FAILING = `boot-failing-${SUFFIX}`;
const PD_WIDENED = `boot-pd-widened-${SUFFIX}`;
const RECIPIENT_ADDED = `boot-recipient-added-${SUFFIX}`;
const RECIPIENT_NARROWED = `boot-recipient-narrowed-${SUFFIX}`;
const AI_PACKAGE = `boot-ai-package-${SUFFIX}`;
const AI_ADDED = `boot-ai-added-${SUFFIX}`;
const AI_DROPPED = `boot-ai-dropped-${SUFFIX}`;
const LICENSED = `boot-licensed-${SUFFIX}`;
const LICENCE_WIDENED = `boot-licence-widened-${SUFFIX}`;
const OTHER_PACKAGE = `boot-other-package-${SUFFIX}`;
const OTHER_VERSION = `boot-other-version-${SUFFIX}`;
const MISPLACED = `boot-misplaced-${SUFFIX}`;
const DUPLICATED = `boot-duplicated-${SUFFIX}`;
const UNRECORDED = `boot-unrecorded-${SUFFIX}`;
const STALE_SECRET = `boot-stale-secret-${SUFFIX}`;
/** Where the refused plugin's factory leaves the host object it was given. */
const REFUSED_HOST = `__openbrfRefusedHost_${SUFFIX.replaceAll("-", "_")}`;
const ALL_IDS = [
  MISPLACED,
  DUPLICATED,
  GOOD,
  BROKEN,
  DISABLED,
  WIDENED,
  REFUSED,
  FAILING,
  PD_WIDENED,
  RECIPIENT_ADDED,
  RECIPIENT_NARROWED,
  AI_PACKAGE,
  AI_ADDED,
  AI_DROPPED,
  LICENSED,
  LICENCE_WIDENED,
  OTHER_PACKAGE,
  OTHER_VERSION,
  UNRECORDED,
  STALE_SECRET,
];

/** A place a plugin sends names to. */
const SYNC = {
  id: "sync",
  origin: "https://sync.example.test",
  purpose: { sv: "Synkar namnen", en: "Syncs the names" },
  personalData: ["name"] as ("name" | "email")[],
};

let prisma: PrismaClient;
let workspace: string;
let testEnv: Env;
let registry: PluginRegistryService;
let binding: PluginHostBinding;
let boot: PluginBoot;
/** Everything the load wrote to the log, as one string to search. */
let warnings = "";

interface PackageOptions {
  id: string;
  permissions?: string[];
  personalData?: string[];
  recipients?: unknown[];
  server?: string;
  /** The directory under node_modules, when it is not the package's own name. */
  directoryName?: string;
  /** Written verbatim, to build a manifest the schema must refuse. */
  rawManifest?: unknown;
  /** Whether the manifest declares an AI package. */
  ai?: boolean;
  /** The services the manifest's licence may be presented to, if it reads one. */
  audiences?: string[];
}

const GATEWAY = "https://gateway.example.org";
const THEMES = "https://themes.example.org";

/** A licence declaration naming `audiences`, as a paid plugin's manifest does. */
function licenceDeclaration(audiences: string[]) {
  return {
    entitlement: "mcp-connector",
    issuer: { name: "Example AB", url: "https://licence.example.org" },
    keys: { "example-2026-1": `${"A".repeat(42)}A=` },
    audiences,
  };
}

/**
 * A plugin bundle that contributes one controller.
 *
 * Written as plain CommonJS with the decorators applied as the functions they
 * are, rather than compiled from TypeScript: what is under test is the shape
 * the host receives, and a build step between this file and that shape would
 * only be somewhere else for it to go wrong. The reference plugin covers the
 * compiled path.
 */
function moduleBundle(path: string): string {
  return `const { Controller, Get, Module } = require("@nestjs/common");

class PingController {
  ping() {
    return { ok: true };
  }
}
Get("ping")(
  PingController.prototype,
  "ping",
  Object.getOwnPropertyDescriptor(PingController.prototype, "ping"),
);
Controller(${JSON.stringify(path)})(PingController);

class PingModule {}
Module({})(PingModule);

exports.createPlugin = function createPlugin() {
  return { module: PingModule, controllers: [PingController] };
};
`;
}

/** Writes a package into the installation tree the way npm would lay it out. */
async function writePackage(
  modules: string,
  options: PackageOptions,
): Promise<void> {
  const directory = join(
    modules,
    options.directoryName ?? `openbrf-plugin-${options.id}`,
  );
  await mkdir(join(directory, "dist"), { recursive: true });

  const manifest = options.rawManifest ?? {
    apiVersion: 1,
    id: options.id,
    entry: { server: "./dist/server.cjs" },
    permissions: options.permissions ?? [],
    personalData: options.personalData ?? ["name"],
    ...(options.ai === undefined ? {} : { ai: options.ai }),
    ...(options.audiences === undefined
      ? {}
      : {
          licence: licenceDeclaration(options.audiences),
          released: "2026-12-01",
        }),
    settingsSchema: {
      fields: [
        {
          key: "heading",
          labelKey: "settings.heading",
          type: "text",
          default: "Occupancy",
        },
        { key: "token", labelKey: "settings.token", type: "secret" },
      ],
    },
    recipients: options.recipients ?? [],
  };

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: `openbrf-plugin-${options.id}`,
        version: "1.0.0",
        openbrf: manifest,
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(
    join(directory, "dist", "server.cjs"),
    options.server ?? moduleBundle("ping"),
    "utf8",
  );

  await mkdir(join(directory, "locales"), { recursive: true });
  await writeFile(
    join(directory, "locales", "sv.json"),
    JSON.stringify({ settings: { heading: "Rubrik" } }),
    "utf8",
  );
  await writeFile(
    join(directory, "locales", "en.json"),
    JSON.stringify({ settings: { heading: "Heading" } }),
    "utf8",
  );
}

/** What the board agreed to for `id`; the package and version default to its own. */
interface Consented {
  permissions?: string[];
  personalData?: string[];
  recipients?: Parameters<PluginRegistryService["consent"]>[0]["recipients"];
  packageName?: string;
  version?: string;
  ai?: boolean;
  /** The audiences the board consented to the licence being presented to. */
  audiences?: string[];
}

async function consent(id: string, consented: Consented = {}): Promise<void> {
  const { permissions = [], personalData = ["name"] } = consented;
  await registry.consent({
    id,
    packageName: consented.packageName ?? `openbrf-plugin-${id}`,
    version: consented.version ?? "1.0.0",
    tarballUrl: `file:///dev/null/${id}.tgz`,
    checksum: "sha512-unused-in-this-suite",
    permissions: permissions as never,
    personalData: personalData as never,
    actions: [],
    recipients: consented.recipients ?? [],
    deviceRoutes: [],
    ai: consented.ai ?? false,
    licence:
      consented.audiences === undefined
        ? null
        : licenceDeclaration(consented.audiences),
  });
}

function loaded(id: string): BootPlugin | undefined {
  return boot.plugins.find((plugin) => plugin.id === id);
}

function finding(id: string): PluginFinding | undefined {
  return boot.findings.find((entry) => entry.id === id);
}

function controllerOf(id: string): object {
  const controller = loaded(id)?.module?.controllers?.[0];
  expect(controller).toBeDefined();
  return controller as object;
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  workspace = await mkdtemp(join(tmpdir(), "openbrf-plugin-boot-"));
  testEnv = {
    ...env,
    OPENBRF_DATA_DIR: workspace,
    OPENBRF_PLUGINS_ENABLED: true,
  };

  const modules = join(dataPaths(workspace).plugins, "node_modules");
  await mkdir(modules, { recursive: true });

  await writePackage(modules, { id: GOOD, permissions: ["addressBook:read"] });
  await writePackage(modules, { id: DISABLED });
  await writePackage(modules, { id: STALE_SECRET });
  await writePackage(modules, {
    id: WIDENED,
    permissions: ["addressBook:read", "mail:send"],
  });
  // Permissions unchanged, personal data added. This is the republished
  // version that starts handling a category the board never saw.
  await writePackage(modules, {
    id: PD_WIDENED,
    permissions: ["addressBook:read"],
    personalData: ["name", "email"],
  });
  // Everything else as consented, and a place to send the names to that the
  // board was never shown.
  await writePackage(modules, {
    id: RECIPIENT_ADDED,
    permissions: ["addressBook:read"],
    recipients: [SYNC],
  });
  // The same recipient as consented, receiving one category fewer.
  await writePackage(modules, {
    id: RECIPIENT_NARROWED,
    permissions: ["addressBook:read"],
    personalData: ["name", "email"],
    recipients: [{ ...SYNC, personalData: ["name"] }],
  });
  // An AI package consented to as one, and two whose manifest says otherwise
  // than the consent did, one in each direction.
  await writePackage(modules, { id: AI_PACKAGE, ai: true });
  await writePackage(modules, { id: AI_ADDED, ai: true });
  await writePackage(modules, { id: AI_DROPPED });
  await writePackage(modules, { id: LICENSED, audiences: [GATEWAY] });
  await writePackage(modules, {
    id: LICENCE_WIDENED,
    audiences: [GATEWAY, THEMES],
  });
  // A manifest the schema refuses. It sits in the same tree as the good one,
  // which is the point: the good one still has to load.
  await writePackage(modules, {
    id: BROKEN,
    rawManifest: { apiVersion: 1, id: BROKEN, entry: {} },
  });
  // A module the host will not register: an application-wide guard from a
  // plugin would act on the core's own routes as well as its own.
  await writePackage(modules, {
    id: REFUSED,
    server: `const { Module } = require("@nestjs/common");
const { APP_GUARD } = require("@nestjs/core");
class Sneaky { canActivate() { return false; } }
class SneakyModule {}
Module({})(SneakyModule);
exports.createPlugin = function createPlugin(host) {
  globalThis[${JSON.stringify(REFUSED_HOST)}] = host;
  return {
    module: SneakyModule,
    providers: [{ provide: APP_GUARD, useClass: Sneaky }],
  };
};
`,
  });
  // Both declare exactly what was consented to; only the package differs.
  await writePackage(modules, { id: OTHER_PACKAGE });
  await writePackage(modules, { id: OTHER_VERSION });
  // On the volume with no consent record at all.
  await writePackage(modules, { id: UNRECORDED });
  // Names itself the consented package, from a directory npm installed some
  // other package into.
  await writePackage(modules, {
    id: MISPLACED,
    directoryName: `openbrf-plugin-elsewhere-${SUFFIX}`,
  });
  // The consented package, and a second copy of it elsewhere in the tree.
  await writePackage(modules, { id: DUPLICATED });
  await writePackage(modules, {
    id: DUPLICATED,
    directoryName: `openbrf-plugin-copy-${SUFFIX}`,
  });
  await writePackage(modules, {
    id: FAILING,
    server: `exports.createPlugin = function createPlugin() {
  throw new Error("this plugin is broken");
};
`,
  });
  // Not a plugin at all, the way npm's own transitive dependencies are not.
  await mkdir(join(modules, "left-pad"), { recursive: true });
  await writeFile(
    join(modules, "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    "utf8",
  );

  registry = new PluginRegistryService(
    prisma as unknown as ConstructorParameters<typeof PluginRegistryService>[0],
  );

  await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
  await consent(GOOD, { permissions: ["addressBook:read"] });
  await consent(DISABLED);
  await consent(STALE_SECRET);
  // Consented to less than the installed package now asks for, which is what a
  // republished version widening its own reach would look like.
  await consent(WIDENED, { permissions: ["addressBook:read"] });
  await consent(PD_WIDENED, {
    permissions: ["addressBook:read"],
    personalData: ["name"],
  });
  await consent(RECIPIENT_ADDED, { permissions: ["addressBook:read"] });
  await consent(RECIPIENT_NARROWED, {
    permissions: ["addressBook:read"],
    personalData: ["name", "email"],
    recipients: [{ ...SYNC, personalData: ["name", "email"] }],
  });
  await consent(AI_PACKAGE, { ai: true });
  await consent(AI_ADDED);
  await consent(AI_DROPPED, { ai: true });
  await consent(LICENSED, { audiences: [GATEWAY, THEMES] });
  await consent(LICENCE_WIDENED, { audiences: [GATEWAY] });
  await consent(BROKEN);
  await consent(REFUSED);
  await consent(FAILING);
  await consent(OTHER_PACKAGE, { packageName: "@someone-else/openbrf-plugin" });
  await consent(OTHER_VERSION, { version: "0.9.0" });
  await consent(MISPLACED);
  await consent(DUPLICATED);
  await registry.setEnabled(DISABLED, false);

  binding = new PluginHostBinding();
  // Recorded rather than replaced, so the run's own output is unchanged and
  // the assertions below can read what a failing plugin put in the log.
  const warn = vi.spyOn(Logger.prototype, "warn");
  try {
    boot = await loadPlugins({
      env: testEnv,
      records: await registry.list(),
      binding,
    });
  } finally {
    warnings = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
  }
}, 120_000);

afterAll(async () => {
  await prisma.installedPlugin.deleteMany({ where: { id: { in: ALL_IDS } } });
  await prisma.$disconnect();
  await rm(workspace, { recursive: true, force: true });
});

describe("loading plugins at boot", () => {
  it("loads a consented plugin and seals its module", () => {
    const plugin = loaded(GOOD);

    expect(plugin).toBeDefined();
    expect(plugin?.module).not.toBeNull();
    expect(plugin?.controllers).toEqual([`api/plugin/${GOOD}/ping`]);
  });

  /**
   * The bundle requires @nestjs/common from a directory under the system's
   * temporary folder, which CJS resolution can never walk up from to reach the
   * host's node_modules. That it loaded at all is the bridge working, and the
   * decorator having taken effect is the plugin having decorated the host's
   * own NestJS rather than a second copy.
   */
  it("resolves the host's NestJS from inside the plugin's own bundle", () => {
    expect(Reflect.getMetadata(PATH_METADATA, controllerOf(GOOD))).toBe(
      `api/plugin/${GOOD}/ping`,
    );
  });

  /**
   * The rule that makes the whole system safe to install into: a package the
   * loader cannot read is a finding, not an outage.
   */
  it("skips a malformed package without stopping the others", () => {
    expect(loaded(BROKEN)).toBeUndefined();
    expect(loaded(GOOD)).toBeDefined();
    expect(
      boot.findings.some((entry) => entry.reason === "manifest-invalid"),
    ).toBe(true);
  });

  it("skips a bundle that throws while being loaded", () => {
    expect(loaded(FAILING)).toBeUndefined();
    expect(finding(FAILING)?.reason).toBe("load-failed");
    // Nothing but the code. The plugin wrote that message and can have been
    // holding a resident's details when it threw.
    expect(finding(FAILING)?.detail).toEqual({});
    expect(loaded(GOOD)).toBeDefined();
  });

  /**
   * The rule across every finding rather than one of them: the admin screen is
   * served a code and the values its own sentence needs, never a sentence this
   * process composed.
   */
  it("keeps what a plugin's own code said off the wire", () => {
    expect(JSON.stringify(boot.findings)).not.toContain(
      "this plugin is broken",
    );
  });

  /**
   * And not in the log either, which is the part no other control covers.
   *
   * A plugin composes the message it throws out of whatever it was handling,
   * and one reading the register through its consented host services can be
   * holding a resident's address or a personal identity number. Protected
   * personal data is masked server-side and every reveal is written to the
   * audit log in the same transaction as the read; a container log is outside
   * both, so a copy there is a disclosure to everyone with log access and a
   * retention breach at once.
   */
  it("keeps what a plugin's own code said out of the log as well", () => {
    expect(warnings).not.toContain("this plugin is broken");
  });

  /**
   * The other half of the same rule. "Log nothing" is easy and leaves an
   * operator with a plugin that will not load and no way to find out why, so
   * what a refusal does carry is the package, the file that was required and
   * the class of the failure - none of which is composed from data.
   */
  it("says which package, which file and what kind of failure", () => {
    expect(warnings).toContain(FAILING);
    expect(warnings).toContain("Error");
    expect(warnings).toContain("dist/server.cjs");
  });

  it("skips a module that reaches outside what a plugin may register", () => {
    expect(loaded(REFUSED)).toBeUndefined();
    expect(finding(REFUSED)?.reason).toBe("module-refused");
    // The refusal names a NestJS construct, which is the plugin author's
    // business and not a board's: it goes to the log, and what crosses the
    // wire is the code the screen reads its own sentence from.
    expect(finding(REFUSED)?.detail).toEqual({});
    expect(loaded(GOOD)).toBeDefined();
  });

  it("does not report an ordinary dependency as a broken plugin", () => {
    // npm puts transitive dependencies in the same tree. Reporting each of
    // them would bury the one finding that matters.
    expect(
      boot.findings.some((entry) => entry.directory.includes("left-pad")),
    ).toBe(false);
  });

  it("does not load a disabled plugin, but keeps its manifest", () => {
    expect(loaded(DISABLED)).toBeUndefined();
    // The settings form still has to render for a plugin that is switched off.
    expect(boot.dormant.get(DISABLED)?.settingsSchema).toBeDefined();
    expect(finding(DISABLED)?.reason).toBe("disabled");
  });

  /**
   * A republished version that asks for more than the board agreed to is
   * refused rather than granted the wider set. Consent is a snapshot, and an
   * upgrade is not a way around it.
   */
  it("refuses a package that widened its own permissions", () => {
    expect(loaded(WIDENED)).toBeUndefined();
    expect(finding(WIDENED)?.reason).toBe("permissions-widened");
    expect(finding(WIDENED)?.detail["permissions"]).toContain("mail:send");
  });

  /**
   * The other half of the consented declaration.
   *
   * A republished version can leave its permissions exactly as they were and
   * still start handling a personal-data category the board never saw - email
   * added to a plugin that declared only a name. The board's samtycke to a
   * stated set of personal data is the legal basis for processing it (GDPR
   * art. 6.1 a), so the stored snapshot has to gate this the way it gates the
   * permissions.
   */
  it("refuses a plugin that added a personal-data category since consent", () => {
    expect(loaded(PD_WIDENED)).toBeUndefined();
    expect(finding(PD_WIDENED)?.reason).toBe("personal-data-widened");
    expect(finding(PD_WIDENED)?.detail["categories"]).toContain("email");
  });

  /**
   * And on where the plugin connects to (ADR 0037): a republished version that
   * keeps its permissions and its categories and adds a recipient sends the
   * data somewhere the consent never described.
   */
  it("refuses a plugin that added a recipient since consent", () => {
    expect(loaded(RECIPIENT_ADDED)).toBeUndefined();
    expect(finding(RECIPIENT_ADDED)?.reason).toBe("recipients-widened");
    expect(finding(RECIPIENT_ADDED)?.detail["recipients"]).toEqual([
      "https://sync.example.test",
    ]);
  });

  // Its reach narrowed: the board agreed to more than it now sends there.
  it("loads a plugin whose recipient receives fewer categories than consented", () => {
    expect(finding(RECIPIENT_NARROWED)).toBeUndefined();
    expect(loaded(RECIPIENT_NARROWED)).toBeDefined();
  });

  /**
   * Whether a plugin is an AI package decides the channel its dispatch is
   * recorded on and the surface it reaches, and the host reads it from the
   * manifest at dispatch. So the manifest is held to what the board consented
   * to, in both directions: either way round, the plugin would be dispatching
   * on a channel nobody agreed to.
   */
  it("loads an AI package consented to as one", () => {
    expect(finding(AI_PACKAGE)).toBeUndefined();
    expect(loaded(AI_PACKAGE)?.context.manifest.ai).toBe(true);
  });

  it("refuses a package that came to declare itself an AI package", () => {
    expect(loaded(AI_ADDED)).toBeUndefined();
    expect(finding(AI_ADDED)?.reason).toBe("ai-changed");
  });

  it("refuses a package consented to as an AI package that no longer is one", () => {
    // The direction that widens: as a plain plugin it would reach every
    // action offered on this instance's own screens.
    expect(loaded(AI_DROPPED)).toBeUndefined();
    expect(finding(AI_DROPPED)?.reason).toBe("ai-changed");
  });

  it("loads a licensed plugin that presents to fewer services than consented", () => {
    expect(finding(LICENSED)).toBeUndefined();
    expect(loaded(LICENSED)?.context.manifest.licence?.audiences).toEqual([
      GATEWAY,
    ]);
  });

  it("refuses a republished plugin that adds a service it presents the licence to", () => {
    // ADR 0042: the audiences are a grant, and the board was told each by
    // name. Loaded, the plugin's present() would sign for the new one.
    expect(loaded(LICENCE_WIDENED)).toBeUndefined();
    expect(finding(LICENCE_WIDENED)).toMatchObject({
      reason: "licence-widened",
      detail: { audiences: [THEMES] },
    });
  });

  /**
   * Consent is to a package at a version, and the id is only what a package
   * says about itself. A different package, or a different release of the
   * consented one, under the same id is not what the board agreed to run.
   */
  it("refuses a package other than the one consented to under the same id", () => {
    expect(loaded(OTHER_PACKAGE)).toBeUndefined();
    expect(finding(OTHER_PACKAGE)?.reason).toBe("not-consented");
    expect(boot.reconcileNeeded).toBe(true);
    expect(warnings).toContain(
      "consent is for @someone-else/openbrf-plugin@1.0.0",
    );
  });

  it("refuses a version other than the one consented to", () => {
    expect(loaded(OTHER_VERSION)).toBeUndefined();
    expect(finding(OTHER_VERSION)?.reason).toBe("not-consented");
    expect(boot.reconcileNeeded).toBe(true);
    expect(warnings).toContain(
      `consent is for openbrf-plugin-${OTHER_VERSION}@0.9.0`,
    );
  });

  /**
   * npm installs the consented archive under the consented name. A package in
   * any other directory is some other archive, whatever name it gives itself.
   */
  it("refuses a package that names itself the consented one from another directory", () => {
    expect(loaded(MISPLACED)).toBeUndefined();
    expect(finding(MISPLACED)?.reason).toBe("not-consented");
  });

  it("loads at most one of two packages under the same id", () => {
    const copies = boot.plugins.filter((plugin) => plugin.id === DUPLICATED);

    expect(copies).toHaveLength(1);
    expect(copies[0]?.directory).toMatch(/openbrf-plugin-boot-duplicated-/);
  });

  /**
   * The admin screen draws a plugin's settings form, and validates what the
   * board saves, from the manifest the loader holds for its id. A package the
   * board did not consent to must not supply that.
   */
  it("keeps no manifest for a package other than the one consented to", () => {
    const loader = new PluginLoaderService(
      boot,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(boot.dormant.has(OTHER_PACKAGE)).toBe(false);
    expect(boot.dormant.has(OTHER_VERSION)).toBe(false);
    expect(loader.manifestFor(OTHER_PACKAGE)).toBeNull();
    expect(loader.manifestFor(OTHER_VERSION)).toBeNull();
  });

  /**
   * The licence screen tries a licence against every manifest the loader
   * holds. A package no record names is not an installed plugin, so its key
   * must verify nothing (ADR 0042); the board still sees the finding.
   */
  it("keeps no manifest for a package with no record of consent", () => {
    const loader = new PluginLoaderService(
      boot,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(loaded(UNRECORDED)).toBeUndefined();
    expect(finding(UNRECORDED)?.reason).toBe("not-consented");
    expect(boot.reconcileNeeded).toBe(true);
    expect(boot.dormant.has(UNRECORDED)).toBe(false);
    expect(loader.manifestFor(UNRECORDED)).toBeNull();
    expect(
      loader.installedManifests().map((manifest) => manifest.id),
    ).not.toContain(UNRECORDED);
  });

  it("raises the plugin's controllers to the floor its permissions imply", () => {
    // The plugin declared no capability on its controller. It reads the
    // register, so the caller must hold the capability the core requires to
    // read it - otherwise the plugin would be a way around the address book's
    // own rules.
    const controller = controllerOf(GOOD);

    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES, controller)).toEqual([
      "addressBook:read",
    ]);
    expect(Reflect.getMetadata(PLUGIN_ID_METADATA, controller)).toBe(GOOD);
  });

  it("reads the plugin's locale files for both languages", () => {
    expect(loaded(GOOD)?.locales.sv).toEqual({
      settings: { heading: "Rubrik" },
    });
    expect(loaded(GOOD)?.locales.en).toEqual({
      settings: { heading: "Heading" },
    });
  });

  /**
   * A field an upgrade turned from `text` into `secret` still has the value
   * the board saved while it was plain in the settings column, unencrypted.
   * Nothing reads it, but it is not to stay there (ADR 0037).
   */
  describe("a setting that became secret", () => {
    const stale = { heading: "Belaggning", token: "gammal-hemlighet" };

    async function bootstrap(): Promise<void> {
      await new PluginLoaderService(
        boot,
        {} as never,
        {} as never,
        {} as never,
        { revokeUndeclaredRoutes: async () => 0 } as never,
        new PluginSettingsService(
          prisma as never,
          new FieldEncryptionService(testEnv),
          { record: async () => undefined } as never,
        ),
      ).onApplicationBootstrap();
    }

    async function storedSettings(id: string): Promise<unknown> {
      const row = await prisma.installedPlugin.findUnique({
        where: { id },
        select: { settings: true },
      });
      return row?.settings;
    }

    it("is removed from the stored settings when the plugin serves, and the rest is kept", async () => {
      expect(loaded(STALE_SECRET)).toBeDefined();
      await prisma.installedPlugin.update({
        where: { id: STALE_SECRET },
        data: { settings: stale },
      });

      await bootstrap();

      expect(await storedSettings(STALE_SECRET)).toEqual({
        heading: "Belaggning",
      });
    });

    it("leaves the settings of a plugin the loader did not serve as they were", async () => {
      expect(loaded(WIDENED)).toBeUndefined();
      await prisma.installedPlugin.update({
        where: { id: WIDENED },
        data: { settings: stale },
      });

      await bootstrap();

      expect(await storedSettings(WIDENED)).toEqual(stale);
    });
  });

  describe("the permissions-scoped SDK", () => {
    let host: PluginHost;

    beforeAll(() => {
      host = loaded(GOOD)?.host as PluginHost;
      expect(host).toBeDefined();
      binding.bind({
        registry,
        settings: new PluginSettingsService(
          prisma as never,
          new FieldEncryptionService(testEnv),
          { record: async () => undefined } as never,
        ),
        actions: {} as never,
        callers: {} as never,
        recipients: {} as never,
        pendingChanges: {} as never,
        extensions: {} as never,
        devices: {} as never,
        themes: {} as never,
        entitlements: {} as never,
        jobs: {} as never,
        mail: {} as never,
        sms: {} as never,
        records: {} as never,
        finances: {} as never,
        receipts: {} as never,
        financeEvents: {} as never,
        addressBook: {
          summary: async () => ({ apartments: 0, residents: 0, members: 0 }),
          apartments: async () => [],
          residents: async () => [],
        } as never,
      });
    });

    it("allows a service the plugin declared", async () => {
      await expect(host.addressBook.summary()).resolves.toEqual({
        apartments: 0,
        residents: 0,
        members: 0,
      });
    });

    it("refuses a service the plugin did not declare", async () => {
      await expect(
        host.mail.send({ to: "a@example.se", subject: "x", text: "y" }),
      ).rejects.toBeInstanceOf(PluginPermissionError);

      await expect(host.jobs.send("nightly", { at: 1 })).rejects.toBeInstanceOf(
        PluginPermissionError,
      );
    });

    it("reads the plugin's settings with its declared defaults applied", async () => {
      await expect(host.settings.read()).resolves.toEqual({
        heading: "Occupancy",
      });
    });

    it("returns validated values once they are stored", async () => {
      await registry.writeSettings(GOOD, { heading: "Belaggning" });
      await expect(host.settings.read()).resolves.toEqual({
        heading: "Belaggning",
      });
    });

    // Written by the plugin, held as ciphertext on its own row, and handed
    // back in clear to the plugin alone (ADR 0037).
    it("keeps a secret the plugin writes encrypted, and reads it back in clear", async () => {
      await host.settings.writeSecret("token", "rt-hemlig-1");

      await expect(host.settings.read()).resolves.toMatchObject({
        token: "rt-hemlig-1",
      });
      const rows = await prisma.pluginSecretSetting.findMany({
        where: { pluginId: GOOD },
      });
      expect(rows.map((row) => row.key)).toEqual(["token"]);
      expect(JSON.stringify(rows)).not.toContain("rt-hemlig-1");

      await host.settings.writeSecret("token", null);
      await expect(host.settings.read()).resolves.not.toHaveProperty("token");
    });

    /**
     * Switching a plugin off reaches its code, not only its routes. Its module
     * stays in this process until the next boot, so anything it started of its
     * own has to lose the register with it.
     */
    it("refuses everything once the plugin stops serving", async () => {
      const plugin = loaded(GOOD) as BootPlugin;
      plugin.context.serving = false;

      await expect(host.addressBook.summary()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );
      await expect(host.settings.read()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );

      plugin.context.serving = true;
    });

    /**
     * A plugin refused after its factory ran can still hold the host object it
     * was given, from a timer or a promise of its own. Refused is not serving.
     */
    it("refuses everything to a plugin refused after its factory ran", async () => {
      const kept = (globalThis as Record<string, unknown>)[
        REFUSED_HOST
      ] as PluginHost;
      expect(kept).toBeDefined();

      await expect(kept.settings.read()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );
    });
  });
});
