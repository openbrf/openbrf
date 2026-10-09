import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { CatalogClient } from "../packaging/catalog.client";
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
import { type StagedTheme, ThemeStore } from "./theme-store";
import { ThemeService } from "./theme.service";

/**
 * The install path end to end, against a real database and a real catalog.
 *
 * The catalog is built from the repository's own fixtures into a temporary
 * directory, so this is the same code that will download a package over HTTP:
 * the same checksum verification, the same archive reader, the same lint. What
 * it does not need is a network, which is what makes it runnable in CI.
 *
 * What the suite proves is exit criterion 11 minus the network: a theme
 * declaring `extends: porttavlan` installs from a catalog, passes the lint,
 * previews, activates, and does all of it without the process restarting.
 *
 * The index is read through the catalog client the plugin screen uses, in the
 * one format both kinds are listed in. It is a file on disk rather than the
 * curated address, which is exactly what the uncurated flag gates.
 */

const baseEnv = loadEnvForIntegrationTests();

let prisma: PrismaClient;
let themes: ThemeService;
let installer: ThemeInstallService;
let dataDirectory: string;
let catalogDirectory: string;
let exampleEntry: FixtureCatalogEntry;
let catalogPath: string;
/**
 * An installer reading the index at this path, on this run's database, and
 * writing through the store given, or through the one the other installers
 * share.
 */
let installerReading: (
  path: string,
  storeFor?: (env: Env) => ThemeStore,
) => ThemeInstallService;

/** Restored in afterAll, so the shared database is left as it was found. */
let associationExisted = false;
let previousActiveThemeId: string | null = null;

/**
 * The newest theme audit entry that already existed when this run started.
 *
 * The audit log is append-only - it is the statutory record of who installed
 * and activated what, and an append-only trigger enforces it - so the entries
 * earlier runs wrote are still in the table. An assertion that only matched on
 * the action and the target would find one of those and pass with the
 * `audit.record` call deleted. Everything after this boundary is this run's.
 */
let auditBoundary = new Date(0);

beforeAll(async () => {
  catalogDirectory = await mkdtemp(join(tmpdir(), "openbrf-theme-catalog-"));
  dataDirectory = await mkdtemp(join(tmpdir(), "openbrf-theme-data-"));
  const catalog = await buildThemeFixtureCatalog(catalogDirectory);
  const example = catalog.entries.find((entry) => entry.id === "example-theme");
  if (example === undefined) {
    throw new Error("The fixture catalog has no example-theme entry.");
  }
  exampleEntry = example;
  catalogPath = catalog.catalogPath;

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

  themes = new ThemeService(service, audit, store);
  installerReading = (path, storeFor) =>
    new ThemeInstallService(
      service,
      audit,
      new CatalogThemeSource(
        new CatalogClient({
          ...env,
          OPENBRF_CATALOG_URL: pathToFileURL(path).href,
        }),
      ),
      storeFor?.(env) ?? store,
      themes,
    );
  installer = installerReading(catalog.catalogPath);

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { activeThemeId: true },
  });
  associationExisted = existing !== null;
  previousActiveThemeId = existing?.activeThemeId ?? null;

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  // A theme left behind by an interrupted run would make the first install a
  // reinstall, which is a different path from the one under test.
  await prisma.installedTheme.deleteMany({
    where: { id: { in: ["example-theme", "illegible-theme"] } },
  });

  // Read from the table rather than from a clock, so the boundary needs no
  // agreement between this process and the database about the time.
  const latest = await prisma.auditLogEntry.findFirst({
    where: {
      action: { in: ["THEME_INSTALLED", "THEME_ACTIVATED"] },
      targetId: "example-theme",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  auditBoundary = latest?.createdAt ?? new Date(0);
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.installedTheme.deleteMany({
      where: { id: { in: ["example-theme", "illegible-theme"] } },
    });
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

describe("installing a theme from the catalog", () => {
  it("lists the catalog's themes with what is already installed", async () => {
    const catalog = await installer.catalog();
    const entry = catalog.find((theme) => theme.id === "example-theme");
    expect(entry?.version).toBe("1.0.0");
    expect(entry?.installedVersion).toBeNull();
  });

  /*
   * Deprecation is a curator's soft withdrawal: still listed, not installed
   * anew. Before the install below, so the id is not installed yet; refused
   * from the index alone, so nothing is downloaded, written or recorded.
   */
  it("refuses a first install of a deprecated entry, and writes nothing", async () => {
    const path = await exampleEntryChanged("deprecated-first", {
      deprecated: true,
    });

    const failure = await refusal(
      installerReading(path).install(exampleEntry.id, null),
    );

    expect(failure.reason).toBe("entry-deprecated");
    expect(failure.status).toBe(409);
    expect(
      await prisma.installedTheme.findUnique({
        where: { id: exampleEntry.id },
      }),
    ).toBeNull();
    await expect(
      stat(join(dataDirectory, "themes", exampleEntry.id)),
    ).rejects.toThrow();
  });

  /*
   * A theme composed here under the entry's id is the board's own, not the
   * entry installed. No catalog package may replace it, deprecated or not,
   * and the catalog must say so rather than offer the entry as installed. The
   * composed row is removed afterwards, so the install below is a first one.
   */
  it("refuses a catalog entry over a theme composed under its id", async () => {
    await installer.compose(
      {
        id: exampleEntry.id,
        displayName: "Husets farger",
        description: "Foreningens egna farger.",
        extends: "porttavlan",
        modes: {
          light: { "accent-trust": "#2F5D50" },
          dark: { "accent-trust": "#7FBFAA" },
        },
      },
      null,
    );
    const composed = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: exampleEntry.id },
    });

    try {
      const current = (await installer.catalog()).find(
        (theme) => theme.id === exampleEntry.id,
      );
      expect(current).toMatchObject({
        installedVersion: null,
        composedHere: true,
      });
      expect(
        (await refusal(installer.install(exampleEntry.id, null))).reason,
      ).toBe("theme-composed");

      const path = await exampleEntryChanged("deprecated-composed", {
        deprecated: true,
      });
      const reading = installerReading(path);
      expect(
        (await refusal(reading.install(exampleEntry.id, null))).reason,
      ).toBe("theme-composed");

      expect(
        await prisma.installedTheme.findUniqueOrThrow({
          where: { id: exampleEntry.id },
        }),
      ).toEqual(composed);
    } finally {
      await prisma.installedTheme.delete({ where: { id: exampleEntry.id } });
      await rm(join(dataDirectory, "themes", exampleEntry.id), {
        recursive: true,
        force: true,
      });
      // Composing recorded THEME_COMPOSED for this id, and the log keeps it.
      // The audit assertions below are about the catalog install, so they
      // start after it.
      const recorded = await prisma.auditLogEntry.findFirst({
        where: { action: "THEME_COMPOSED", targetId: exampleEntry.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      auditBoundary = recorded?.createdAt ?? auditBoundary;
    }
  });

  it("installs a theme that inherits the default one", async () => {
    const result = await installer.install("example-theme", null);

    expect(result.theme.id).toBe("example-theme");
    expect(result.theme.extendsThemeId).toBe("porttavlan");
    // The forward-compatible fields the manifest carries are accepted and
    // ignored, so they produce no warnings at all.
    expect(result.warnings).toEqual([]);

    const row = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: "example-theme" },
    });
    expect(row.version).toBe("1.0.0");
    expect(row.sourceUrl).toBe(exampleEntry.artifact.url);

    // The column holds hex, whichever spelling the index wrote: the fixture
    // index writes the `sha512-<base64>` form npm reports.
    expect(exampleEntry.artifact.sha512).toMatch(/^sha512-/);
    expect(row.checksum).toMatch(/^[0-9a-f]{128}$/);
    expect(row.checksum).toBe(
      Buffer.from(
        exampleEntry.artifact.sha512.slice("sha512-".length),
        "base64",
      ).toString("hex"),
    );

    // Resolution ran: the theme's own accent over the default's page ground.
    const light = row.lightTokens as Record<string, string>;
    expect(light["accent-trust"]).toBe("#2F5D50");
    expect(light["surface-page"]).toBe("#EFEDE7");
  });

  it("writes the theme's bundled font to the data volume", async () => {
    const font = join(
      dataDirectory,
      "themes",
      "example-theme",
      "fonts",
      "spline-sans-mono-latin.woff2",
    );
    expect((await stat(font)).size).toBeGreaterThan(1000);

    const asset = await themes.asset(
      "example-theme",
      "fonts/spline-sans-mono-latin.woff2",
    );
    expect(asset?.contents.length).toBeGreaterThan(1000);
  });

  it("records the install in the audit log", async () => {
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "THEME_INSTALLED",
        targetId: "example-theme",
        createdAt: { gt: auditBoundary },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry?.targetKind).toBe("theme");
    expect((entry?.context as { version?: string } | null)?.version).toBe(
      "1.0.0",
    );
  });

  it("does not claim a downloaded theme was written here", async () => {
    // THEME_COMPOSED answers "were these tokens authored on this instance",
    // and a catalog package is the case where the answer is no.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "THEME_COMPOSED",
        targetId: "example-theme",
        createdAt: { gt: auditBoundary },
      },
    });

    expect(entry).toBeNull();
  });

  /*
   * Served from the theme's own declarations rather than from whatever the
   * directory holds. Asserted against an installed theme on purpose: one that
   * is not installed answers nothing for every path, which would prove nothing
   * about the allowlist.
   */
  it("serves the files the manifest declared, and only those", async () => {
    expect(
      await themes.asset("example-theme", "fonts/spline-sans-mono-latin.woff2"),
    ).not.toBeNull();

    for (const path of [
      // In the package, never declared.
      "theme.json",
      // Neither in the package nor shaped like a path inside one.
      "../../../etc/passwd",
      "fonts/../../../etc/passwd",
    ]) {
      expect(await themes.asset("example-theme", path)).toBeNull();
    }
  });

  /*
   * The gate. The register pairs are statutory: the member and apartment
   * registers are documents an association is legally required to be able to
   * produce and read, so a theme that renders them at 1.1:1 is refused rather
   * than warned about.
   */
  it("refuses a theme that makes the statutory register illegible", async () => {
    const failure = await refusal(installer.install("illegible-theme", null));

    expect(failure.reason).toBe("lint-failed");
    expect(
      failure.findings.some(
        (finding) =>
          finding.rule === "contrast" && finding.detail["statutory"] === true,
      ),
    ).toBe(true);

    // Nothing was written: neither a row nor a directory.
    expect(
      await prisma.installedTheme.findUnique({
        where: { id: "illegible-theme" },
      }),
    ).toBeNull();
    await expect(
      stat(join(dataDirectory, "themes", "illegible-theme")),
    ).rejects.toThrow();
  });

  it("refuses a catalog entry that is not there", async () => {
    const failure = await refusal(installer.install("no-such-theme", null));
    expect(failure.reason).toBe("not-in-catalog");
  });

  /*
   * The board is shown the entry, and the package is what installs: an entry
   * claiming a contract or a parent its package does not have is refused, on
   * the same terms as one naming the wrong id or version. The bytes are the
   * right ones - the digest still matches - so only the comparison can catch
   * it.
   */
  it.each([
    ["contract", { contract: "^9.0.0" }],
    ["parent", { extends: "another-theme" }],
  ] as const)(
    "refuses a package whose %s disagrees with its entry",
    async (what, change) => {
      const path = await exampleEntryChanged(`wrong-${what}`, change);

      const failure = await refusal(
        installerReading(path).install(exampleEntry.id, null),
      );
      expect(failure.reason).toBe("identity-mismatch");
    },
  );

  /*
   * The other half of deprecation: a board that already has the theme can
   * still install it again and take its updates. Runs after the install
   * above, so the id is installed.
   */
  it("installs a deprecated entry again where the theme is already installed", async () => {
    const path = await exampleEntryChanged("deprecated", { deprecated: true });

    const result = await installerReading(path).install(exampleEntry.id, null);

    expect(result.theme.id).toBe(exampleEntry.id);
  });

  /*
   * The previous version is removed after the transaction has committed, so a
   * failure there must not report the install as failed. Runs after the
   * installs above, so this is a reinstall and there is a previous version.
   */
  it("reports a reinstall as installed when its previous files cannot be removed", async () => {
    let staged = 0;
    class StoreKeepingThePrevious extends ThemeStore {
      override async stage(
        ...args: Parameters<ThemeStore["stage"]>
      ): Promise<StagedTheme> {
        const stage = await super.stage(...args);
        staged += 1;
        return {
          ...stage,
          finalize: () => Promise.reject(new Error("EBUSY")),
        };
      }
    }

    const result = await installerReading(
      catalogPath,
      (env) => new StoreKeepingThePrevious(env),
    ).install(exampleEntry.id, null);

    expect(result.theme.id).toBe(exampleEntry.id);
    expect(staged).toBe(1);
  });
});

/**
 * A copy of the fixture index with the example entry changed, as a curator's
 * commit between two reads would leave it. Returns the copy's path.
 */
async function exampleEntryChanged(
  name: string,
  change: Readonly<Record<string, unknown>>,
): Promise<string> {
  const index = JSON.parse(await readFile(catalogPath, "utf8")) as {
    entries: FixtureCatalogEntry[];
  };
  index.entries = index.entries.map((entry) =>
    entry.id === exampleEntry.id ? { ...entry, ...change } : entry,
  );
  const path = join(catalogDirectory, `catalog-${name}.json`);
  await writeFile(path, JSON.stringify(index));
  return path;
}

/**
 * The refusal an install produced.
 *
 * A helper rather than a `.catch()` at each call site, because a catch that
 * casts leaves the success path typed as a refusal, and a test that silently
 * passed on a successful install would be asserting nothing.
 */
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

describe("preview and activation", () => {
  it("previews without changing what anyone else sees", async () => {
    const before = await themes.activeRendering();
    expect(before.builtIn).toBe(true);

    const preview = await themes.renderingOf("example-theme");
    expect(preview.modes.light["accent-trust"]).toBe("#2F5D50");
    expect(preview.viewVariants).toEqual({ memberRegister: "table" });

    const after = await themes.activeRendering();
    expect(after.builtIn).toBe(true);
  });

  it("activates the theme, with no restart between the two reads", async () => {
    await themes.activate("example-theme", null);

    const active = await themes.activeRendering();
    expect(active.id).toBe("example-theme");
    expect(active.modes.light["accent-trust"]).toBe("#2F5D50");
    expect(active.modes.dark["accent-trust"]).toBe("#7FBFAA");
    expect(active.fontFaces).toHaveLength(1);
    expect(active.fontFaces[0]?.family).toBe("Spline Sans Mono");
    expect(active.fontFaces[0]?.url).toContain("/api/themes/asset?theme=");

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "THEME_ACTIVATED",
        targetId: "example-theme",
        createdAt: { gt: auditBoundary },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry?.targetKind).toBe("theme");
  });

  it("will not remove the theme it is rendering", async () => {
    await expect(themes.uninstall("example-theme", null)).rejects.toThrow(
      /is the active one/,
    );
  });

  it("returns to the built-in theme and then removes the installed one", async () => {
    await themes.activate(null, null);
    expect((await themes.activeRendering()).builtIn).toBe(true);

    await themes.uninstall("example-theme", null);

    expect(
      await prisma.installedTheme.findUnique({
        where: { id: "example-theme" },
      }),
    ).toBeNull();
    await expect(
      stat(join(dataDirectory, "themes", "example-theme")),
    ).rejects.toThrow();
  });
});
