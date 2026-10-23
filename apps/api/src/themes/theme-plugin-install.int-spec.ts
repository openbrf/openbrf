import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { CatalogClient } from "../packaging/catalog.client";
import { sha512 } from "../packaging/integrity";
import { PackageLock } from "../packaging/package-lock";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  buildThemeFixtureCatalog,
  type FixtureCatalogEntry,
} from "../testing/theme-fixtures";
import {
  ThemeInstallError,
  ThemeInstallService,
} from "./theme-install.service";
import { CatalogThemeSource } from "./theme-source";
import { ThemeStore } from "./theme-store";
import { ThemeService } from "./theme.service";

/**
 * A theme a plugin hands over, installed through `host.themes.install`
 * (ADR 0046), against a real database and the repository's fixture packages.
 *
 * What the suite proves is that the source changes nothing about the gate: the
 * package is checked against the digest the plugin states before anything is
 * unpacked, the same lint refuses the same theme with the same findings, and
 * nothing reaches the data volume or the table on a refusal. And the rule on
 * sources: a plugin installs over a theme it installed itself and nothing
 * else, and neither the catalog nor the composer installs over a plugin's.
 */

const baseEnv = loadEnvForIntegrationTests();

const PLUGIN = "premium-themes";
const OTHER_PLUGIN = "other-themes";
/** Who asked; a plain column in the audit log, so no person row is needed. */
const ACTOR = "plugin-theme-installer";
const THEME_IDS = ["example-theme", "illegible-theme"];

let prisma: PrismaClient;
let themes: ThemeService;
let installer: ThemeInstallService;
let dataDirectory: string;
let catalogDirectory: string;
let example: FixtureCatalogEntry;
let illegible: FixtureCatalogEntry;
let exampleBytes: Buffer;
let illegibleBytes: Buffer;

let associationExisted = false;
let previousActiveThemeId: string | null = null;
/** Every audit entry after this one is this run's; see theme-install.int-spec. */
let auditBoundary = new Date(0);

beforeAll(async () => {
  catalogDirectory = await mkdtemp(
    join(tmpdir(), "openbrf-plugin-theme-catalog-"),
  );
  dataDirectory = await mkdtemp(join(tmpdir(), "openbrf-plugin-theme-data-"));
  const catalog = await buildThemeFixtureCatalog(catalogDirectory);
  const entry = (id: string): FixtureCatalogEntry => {
    const found = catalog.entries.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new Error(`The fixture catalog has no ${id} entry.`);
    }
    return found;
  };
  example = entry("example-theme");
  illegible = entry("illegible-theme");
  exampleBytes = await readFile(fileURLToPath(example.artifact.url));
  illegibleBytes = await readFile(fileURLToPath(illegible.artifact.url));

  const env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: dataDirectory,
    OPENBRF_CATALOG_URL: pathToFileURL(catalog.catalogPath).href,
    OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
  } as Env;

  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  const service = prisma as unknown as PrismaService;
  const audit = new AuditLogService(service);
  const store = new ThemeStore(env);
  const packageLock = new PackageLock(env);
  themes = new ThemeService(service, audit, store, packageLock);
  installer = new ThemeInstallService(
    service,
    audit,
    new CatalogThemeSource(new CatalogClient(env)),
    store,
    themes,
    packageLock,
  );

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { activeThemeId: true },
  });
  associationExisted = existing !== null;
  previousActiveThemeId = existing?.activeThemeId ?? null;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: { activeThemeId: null },
  });

  const latest = await prisma.auditLogEntry.findFirst({
    where: { action: "THEME_INSTALLED", targetId: { in: THEME_IDS } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  auditBoundary = latest?.createdAt ?? new Date(0);
});

/** Each case starts from no theme under either id, on disk or in the table. */
beforeEach(async () => {
  await removeThemes();
});

afterAll(async () => {
  if (prisma !== undefined) {
    await removeThemes();
    if (associationExisted) {
      await prisma.association.update({
        where: { id: 1 },
        data: { activeThemeId: previousActiveThemeId },
      });
    } else {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
    await prisma.$disconnect();
  }
  await rm(catalogDirectory, { recursive: true, force: true });
  await rm(dataDirectory, { recursive: true, force: true });
});

async function removeThemes(): Promise<void> {
  await prisma.installedTheme.deleteMany({ where: { id: { in: THEME_IDS } } });
  for (const id of THEME_IDS) {
    await rm(join(dataDirectory, "themes", id), {
      recursive: true,
      force: true,
    });
  }
}

/** The refusal an install produced; fails the test if it succeeded. */
async function refusal(install: Promise<unknown>): Promise<ThemeInstallError> {
  try {
    await install;
  } catch (cause) {
    if (cause instanceof ThemeInstallError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("The install was expected to be refused, and was not.");
}

async function nothingWritten(themeId: string): Promise<void> {
  expect(
    await prisma.installedTheme.findUnique({ where: { id: themeId } }),
  ).toBeNull();
  await expect(stat(join(dataDirectory, "themes", themeId))).rejects.toThrow();
}

function installAsPlugin(
  pluginId: string,
  bytes: Uint8Array = exampleBytes,
  digest: string = example.artifact.sha512,
) {
  return installer.installFromPlugin(pluginId, bytes, digest, ACTOR);
}

describe("a plugin installing a theme", () => {
  it("installs the package through the catalog's admission, and records the plugin", async () => {
    const result = await installAsPlugin(PLUGIN);

    expect(result.theme).toMatchObject({
      id: "example-theme",
      version: example.version,
      composed: false,
      installedByPlugin: PLUGIN,
    });

    const row = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: "example-theme" },
    });
    expect(row).toMatchObject({
      catalogId: null,
      installedByPluginId: PLUGIN,
      sourceUrl: `plugin://${PLUGIN}/example-theme`,
      checksum: sha512(exampleBytes).toString("hex"),
    });
    await expect(
      stat(join(dataDirectory, "themes", "example-theme", "theme.json")),
    ).resolves.toBeDefined();

    // Named for the plugin and for the person, on the plugin's channel.
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "THEME_INSTALLED",
        targetId: "example-theme",
        createdAt: { gt: auditBoundary },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).toMatchObject({
      channel: "PLUGIN",
      actorPersonId: ACTOR,
      pluginId: PLUGIN,
    });
    expect(entry.context).toMatchObject({
      plugin: PLUGIN,
      source: `plugin://${PLUGIN}/example-theme`,
      version: example.version,
    });

    expect(await installer.installedByPlugin(PLUGIN)).toEqual([
      expect.objectContaining({
        id: "example-theme",
        version: example.version,
      }),
    ]);
    expect(await installer.installedByPlugin(OTHER_PLUGIN)).toEqual([]);
  });

  it("refuses a package that does not hash to the sha512 it states, and writes nothing", async () => {
    const tampered = Buffer.concat([exampleBytes, Buffer.from([0])]);

    const failure = await refusal(installAsPlugin(PLUGIN, tampered));

    expect(failure.reason).toBe("checksum-mismatch");
    expect(failure.status).toBe(422);
    await nothingWritten("example-theme");
  });

  it("refuses a digest it cannot read before comparing anything", async () => {
    const failure = await refusal(
      installAsPlugin(PLUGIN, exampleBytes, "md5-not-a-digest"),
    );

    expect(failure.reason).toBe("malformed-digest");
    await nothingWritten("example-theme");
  });

  it("refuses bytes that are not a theme package", async () => {
    const bytes = Buffer.from("not a tarball");
    const failure = await refusal(
      installAsPlugin(PLUGIN, bytes, sha512(bytes).toString("hex")),
    );

    expect(failure.reason).toBe("package-unreadable");
  });

  /*
   * The gate a plugin's package meets is the lint, not the source: a theme
   * that renders the statutory register illegibly is refused with the same
   * findings the theme screen would show.
   */
  it("refuses a theme the lint refuses, with the same findings as the catalog's install", async () => {
    const fromPlugin = await refusal(
      installAsPlugin(PLUGIN, illegibleBytes, illegible.artifact.sha512),
    );
    const fromCatalog = await refusal(
      installer.install("illegible-theme", null),
    );

    expect(fromPlugin.reason).toBe("lint-failed");
    expect(fromPlugin.findings).toEqual(fromCatalog.findings);
    expect(
      fromPlugin.findings.some(
        (finding) => finding.rule === "contrast" && finding.detail.statutory,
      ),
    ).toBe(true);
    await nothingWritten("illegible-theme");
  });

  it("installs over a theme it installed itself", async () => {
    await installAsPlugin(PLUGIN);
    const result = await installAsPlugin(PLUGIN);

    expect(result.theme.installedByPlugin).toBe(PLUGIN);
  });

  it("does not install over another plugin's theme", async () => {
    await installAsPlugin(OTHER_PLUGIN);
    const before = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: "example-theme" },
    });

    const failure = await refusal(installAsPlugin(PLUGIN));

    expect(failure.reason).toBe("theme-not-from-plugin");
    expect(failure.status).toBe(409);
    expect(
      await prisma.installedTheme.findUniqueOrThrow({
        where: { id: "example-theme" },
      }),
    ).toEqual(before);
  });

  it("does not install over the catalog's theme", async () => {
    await installer.install("example-theme", null);

    const failure = await refusal(installAsPlugin(PLUGIN));

    expect(failure.reason).toBe("theme-not-from-plugin");
    const row = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: "example-theme" },
    });
    expect(row).toMatchObject({
      catalogId: "example-theme",
      installedByPluginId: null,
    });
  });

  it("does not install over a theme composed on the instance", async () => {
    await installer.compose(
      {
        id: "example-theme",
        displayName: "Husets farger",
        extends: "porttavlan",
        modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
      },
      null,
    );

    const failure = await refusal(installAsPlugin(PLUGIN));

    expect(failure.reason).toBe("theme-not-from-plugin");
    expect(
      (await themes.list()).find((theme) => theme.id === "example-theme"),
    ).toMatchObject({ composed: true, installedByPlugin: null });
  });
});

describe("a theme a plugin installed, seen from the catalog and the composer", () => {
  it("is not replaced by the catalog's entry, and the catalog says whose it is", async () => {
    await installAsPlugin(PLUGIN);

    const failure = await refusal(installer.install("example-theme", null));
    expect(failure.reason).toBe("theme-from-plugin");
    expect(failure.status).toBe(409);

    const entry = (await installer.catalog()).find(
      (theme) => theme.id === "example-theme",
    );
    expect(entry).toMatchObject({
      installedVersion: null,
      composedHere: false,
      installedByPlugin: PLUGIN,
    });
  });

  it("is not edited by the composer", async () => {
    await installAsPlugin(PLUGIN);

    const failure = await refusal(
      installer.compose(
        {
          id: "example-theme",
          displayName: "Husets farger",
          extends: "porttavlan",
          modes: { light: {}, dark: {} },
        },
        null,
      ),
    );

    expect(failure.reason).toBe("theme-not-composed");
    expect((await themes.sourceOf("example-theme")).composed).toBe(false);
  });

  /*
   * Removing is the theme screen's, whoever installed the theme: the board
   * keeps the last word over what is on its instance, including after the
   * plugin that installed it is gone.
   */
  it("is removed on the theme screen like any other", async () => {
    await installAsPlugin(PLUGIN);

    await themes.uninstall("example-theme", null);

    await nothingWritten("example-theme");
  });

  it("names one source at most: the table refuses a row claiming two", async () => {
    await installAsPlugin(PLUGIN);

    await expect(
      prisma.installedTheme.update({
        where: { id: "example-theme" },
        data: { catalogId: "example-theme" },
      }),
    ).rejects.toThrow(/installed_theme_has_one_source/);
  });
});
