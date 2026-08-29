import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { buildThemeFixtureCatalog } from "../testing/theme-fixtures";
import {
  ThemeInstallError,
  ThemeInstallService,
} from "./theme-install.service";
import { CatalogThemeSource } from "./theme-source";
import { ThemeStore } from "./theme-store";
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
 */

const baseEnv = loadEnvForIntegrationTests();

let prisma: PrismaClient;
let themes: ThemeService;
let installer: ThemeInstallService;
let dataDirectory: string;
let catalogDirectory: string;

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

  const env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: dataDirectory,
    OPENBRF_CATALOG_URL: catalog.catalogPath,
  } as Env;

  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  const service = prisma as unknown as PrismaService;
  const audit = new AuditLogService(service);
  const store = new ThemeStore(env);

  themes = new ThemeService(service, audit, store);
  installer = new ThemeInstallService(
    service,
    audit,
    new CatalogThemeSource(env),
    store,
    themes,
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
    expect(row.sourceUrl).toBe("example-theme-1.0.0.tgz");
    expect(row.checksum).toMatch(/^[0-9a-f]{128}$/);

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
});

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
    await expect(themes.uninstall("example-theme")).rejects.toThrow(
      /is the active one/,
    );
  });

  it("returns to the built-in theme and then removes the installed one", async () => {
    await themes.activate(null, null);
    expect((await themes.activeRendering()).builtIn).toBe(true);

    await themes.uninstall("example-theme");

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
