import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseThemeManifest } from "@openbrf/theme-tools";
import { PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  ThemeInstallError,
  ThemeInstallService,
} from "./theme-install.service";
import { CatalogThemeSource } from "./theme-source";
import { ThemeStore } from "./theme-store";
import { ThemeService } from "./theme.service";

/**
 * Composing a theme on the instance, against a real database.
 *
 * Deliberately configured with no catalog at all. Composing is the answer for
 * an association that has nothing to install from, so a suite that needed a
 * catalog to prove it would be proving the wrong thing - and the first
 * assertion below is that the catalog really is absent.
 *
 * What it covers is the part composing shares with installing: the same lint
 * gate refuses an illegible theme before anything is written, the same store
 * writes the manifest, the same row and audit entry record it. The one thing
 * that is only true here is the marking: a composed theme has no catalog entry,
 * and that null is what says the composer may edit it.
 */

const baseEnv = loadEnvForIntegrationTests();

/** This suite's own ids, so it cannot collide with the install suite's. */
const COMPOSED = "composed-theme";
const CHILD = "composed-child-theme";
const ILLEGIBLE = "illegible-composed-theme";
const FROM_CATALOG = "catalog-installed-theme";
const OWN_THEMES = [COMPOSED, CHILD, ILLEGIBLE, FROM_CATALOG];

let prisma: PrismaClient;
let themes: ThemeService;
let installer: ThemeInstallService;
let dataDirectory: string;

/** Restored in afterAll, so the shared database is left as it was found. */
let associationExisted = false;
let previousActiveThemeId: string | null = null;

/**
 * The newest theme audit entry that already existed when this run started.
 *
 * The audit log is append-only, so the entries earlier runs wrote are still in
 * the table. An assertion matching only on the action and the target would find
 * one of those and pass with the `audit.record` call deleted.
 */
let auditBoundary = new Date(0);

beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "openbrf-theme-composer-"));

  const env = {
    ...baseEnv,
    OPENBRF_DATA_DIR: dataDirectory,
    // No catalog: composing must need none.
    OPENBRF_CATALOG_URL: undefined,
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

  // A theme left behind by an interrupted run would make the first compose an
  // edit, which is a different path from the one under test.
  await prisma.installedTheme.deleteMany({ where: { id: { in: OWN_THEMES } } });

  /*
   * A theme that came from a catalog, written directly because this suite has
   * no catalog to install one from. Only the row matters: `catalogId` is what
   * the composer reads to decide whether a theme is one it may edit.
   */
  await prisma.installedTheme.create({
    data: {
      id: FROM_CATALOG,
      name: "Katalogtema",
      version: "1.0.0",
      contract: "^1.0.0",
      extendsThemeId: "porttavlan",
      checksum: "a".repeat(128),
      sourceUrl: `https://example.com/${FROM_CATALOG}-1.0.0.tgz`,
      catalogId: FROM_CATALOG,
      declaredLightTokens: { "accent-trust": "#7D5F23" },
      declaredDarkTokens: { "accent-trust": "#C9A64B" },
      lightTokens: {},
      darkTokens: {},
      viewVariants: {},
      fonts: [],
    },
  });

  // Read from the table rather than from a clock, so the boundary needs no
  // agreement between this process and the database about the time.
  const latest = await prisma.auditLogEntry.findFirst({
    where: { action: "THEME_INSTALLED", targetId: COMPOSED },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  auditBoundary = latest?.createdAt ?? new Date(0);
});

afterAll(async () => {
  if (prisma !== undefined) {
    if (associationExisted) {
      await prisma.association.update({
        where: { id: 1 },
        data: { activeThemeId: previousActiveThemeId },
      });
    } else {
      await prisma.association.deleteMany({ where: { id: 1 } });
    }
    await prisma.installedTheme.deleteMany({
      where: { id: { in: OWN_THEMES } },
    });
    await prisma.$disconnect();
  }
  await rm(dataDirectory, { recursive: true, force: true });
});

/**
 * The refusal a compose produced.
 *
 * A helper rather than a `.catch()` at each call site, because a catch that
 * casts leaves the success path typed as a refusal, and a test that silently
 * passed on a successful compose would be asserting nothing.
 */
async function refusal(compose: Promise<unknown>): Promise<ThemeInstallError> {
  try {
    await compose;
  } catch (cause) {
    if (cause instanceof ThemeInstallError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("The compose was expected to be refused, and was not.");
}

describe("composing a theme with no catalog configured", () => {
  it("has no catalog to install from", async () => {
    await expect(installer.catalog()).rejects.toThrow();
  });

  it("composes a theme that inherits the default one", async () => {
    const result = await installer.compose(
      {
        id: COMPOSED,
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

    expect(result.theme.id).toBe(COMPOSED);
    expect(result.theme.composed).toBe(true);
    expect(result.theme.version).toBe("1.0.0");
    expect(result.theme.extendsThemeId).toBe("porttavlan");

    const row = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: COMPOSED },
    });
    // The null catalog entry is the marking: nobody published this theme.
    expect(row.catalogId).toBeNull();
    expect(row.sourceUrl).toBe(`composed://${COMPOSED}`);
    expect(row.checksum).toMatch(/^[0-9a-f]{128}$/);
    expect(row.contract).toBe("^1.0.0");
  });

  it("resolves the parent's values under the composed overrides", async () => {
    const rendering = await themes.renderingOf(COMPOSED);

    expect(rendering.modes.light["accent-trust"]).toBe("#2F5D50");
    expect(rendering.modes.dark["accent-trust"]).toBe("#7FBFAA");
    // Everything the composer did not state is the default theme's.
    expect(rendering.modes.light["surface-page"]).toBe(
      PORTTAVLAN_LIGHT["surface-page"],
    );
    expect(rendering.modes.light["surface-register"]).toBe(
      PORTTAVLAN_LIGHT["surface-register"],
    );
    // A composed theme bundles no fonts and selects no layout of its own.
    expect(rendering.fontFaces).toEqual([]);
    expect(rendering.logoUrl).toBeNull();
  });

  it("writes the manifest to the data volume", async () => {
    const manifestPath = join(dataDirectory, "themes", COMPOSED, "theme.json");
    expect((await stat(manifestPath)).size).toBeGreaterThan(0);

    const parsed = parseThemeManifest(await readFile(manifestPath, "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.name).toBe(COMPOSED);
      expect(parsed.manifest.displayName).toBe("Husets farger");
      expect(parsed.manifest.modes.light).toEqual({
        "accent-trust": "#2F5D50",
      });
    }
  });

  it("lists it as composed on this instance", async () => {
    const list = await themes.list();

    expect(list.find((theme) => theme.id === COMPOSED)?.composed).toBe(true);
    expect(list.find((theme) => theme.id === FROM_CATALOG)?.composed).toBe(
      false,
    );
    // The built-in theme is not composed either: it ships with the core.
    expect(list.find((theme) => theme.builtIn)?.composed).toBe(false);
  });

  it("answers the composer with what the theme declares, and nothing more", async () => {
    const declaration = await themes.sourceOf(COMPOSED);

    expect(declaration.displayName).toBe("Husets farger");
    expect(declaration.description).toBe("Foreningens egna farger.");
    expect(declaration.extendsThemeId).toBe("porttavlan");
    expect(declaration.composed).toBe(true);
    // Declared, not resolved: prefilling a form with inherited values would
    // turn a four-line child theme into a copy of its parent on the next save.
    expect(declaration.modes.light).toEqual({ "accent-trust": "#2F5D50" });
    expect(declaration.modes.dark).toEqual({ "accent-trust": "#7FBFAA" });
  });

  it("records the compose in the audit log, naming the composer", async () => {
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "THEME_INSTALLED",
        targetId: COMPOSED,
        createdAt: { gt: auditBoundary },
      },
      orderBy: { createdAt: "desc" },
    });

    expect(entry).not.toBeNull();
    expect(entry?.targetKind).toBe("theme");
    const context = entry?.context as {
      version?: string;
      source?: string;
    } | null;
    expect(context?.version).toBe("1.0.0");
    expect(context?.source).toBe("composer");
  });
});

describe("what the composer refuses", () => {
  /*
   * The gate, and the reason composing runs through the install path at all.
   * The register pairs are statutory: the member and apartment registers are
   * documents an association is legally required to be able to produce and
   * read, so a theme that renders them at 2:1 is refused rather than warned
   * about - composed on the instance exactly as downloaded from a catalog.
   */
  it("refuses a composed theme that makes the statutory register illegible", async () => {
    const failure = await refusal(
      installer.compose(
        {
          id: ILLEGIBLE,
          displayName: "Olasligt",
          extends: "porttavlan",
          modes: { light: { "text-register": "#4D4D4D" }, dark: {} },
        },
        null,
      ),
    );

    expect(failure.reason).toBe("lint-failed");
    expect(
      failure.findings.some(
        (finding) =>
          finding.rule === "contrast" && finding.detail["statutory"] === true,
      ),
    ).toBe(true);

    // Nothing was written: neither a row nor a directory.
    expect(
      await prisma.installedTheme.findUnique({ where: { id: ILLEGIBLE } }),
    ).toBeNull();
    await expect(
      stat(join(dataDirectory, "themes", ILLEGIBLE)),
    ).rejects.toThrow();
  });

  /*
   * Composing over a catalog theme would replace a package whose bytes match a
   * published checksum with one written here, and the next update from the
   * catalog would take the board's own values away again.
   */
  it("refuses to compose over a theme that came from a catalog", async () => {
    const failure = await refusal(
      installer.compose(
        {
          id: FROM_CATALOG,
          displayName: "Katalogtema",
          extends: "porttavlan",
          modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
        },
        null,
      ),
    );

    expect(failure.reason).toBe("theme-not-composed");

    // The catalog's own row is untouched.
    const row = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: FROM_CATALOG },
    });
    expect(row.version).toBe("1.0.0");
    expect(row.catalogId).toBe(FROM_CATALOG);
  });

  it("refuses the default theme's id, which is reserved", async () => {
    const failure = await refusal(
      installer.compose(
        {
          id: "porttavlan",
          displayName: "Porttavlan",
          extends: "porttavlan",
          modes: { light: {}, dark: {} },
        },
        null,
      ),
    );

    expect(failure.reason).toBe("lint-failed");
    expect(
      failure.findings.some((finding) => finding.rule === "reserved-id"),
    ).toBe(true);
  });
});

describe("editing a composed theme", () => {
  it("composes a child of a composed theme", async () => {
    const result = await installer.compose(
      {
        id: CHILD,
        displayName: "Husets farger, ljusare",
        extends: COMPOSED,
        modes: { light: { "surface-page": "#F5F3EE" }, dark: {} },
      },
      null,
    );

    expect(result.theme.extendsThemeId).toBe(COMPOSED);

    const rendering = await themes.renderingOf(CHILD);
    expect(rendering.modes.light["surface-page"]).toBe("#F5F3EE");
    // Through its parent, which states it, from the default theme, which does
    // not: two hops of inheritance in one value.
    expect(rendering.modes.light["accent-trust"]).toBe("#2F5D50");
  });

  it("bumps the patch version and recomputes what inherits from it", async () => {
    const result = await installer.compose(
      {
        id: COMPOSED,
        displayName: "Husets farger",
        description: "Foreningens egna farger.",
        extends: "porttavlan",
        modes: {
          light: { "accent-trust": "#2C5A4C" },
          dark: { "accent-trust": "#7FBFAA" },
        },
      },
      null,
    );

    expect(result.theme.version).toBe("1.0.1");
    expect(result.theme.composed).toBe(true);

    /*
     * The child's stored values are what the interface renders, and they are
     * resolved rather than declared. Leaving them stale would show a board
     * member the colour their parent theme had before they changed it.
     */
    const child = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: CHILD },
    });
    expect((child.lightTokens as Record<string, string>)["accent-trust"]).toBe(
      "#2C5A4C",
    );
    expect((child.lightTokens as Record<string, string>)["surface-page"]).toBe(
      "#F5F3EE",
    );
  });
});

describe("a composed theme is an ordinary installed theme", () => {
  it("activates without a restart between the two reads", async () => {
    await themes.activate(COMPOSED, null);

    const active = await themes.activeRendering();
    expect(active.id).toBe(COMPOSED);
    expect(active.modes.light["accent-trust"]).toBe("#2C5A4C");
  });

  it("will not be removed while another theme inherits from it", async () => {
    await themes.activate(null, null);
    await expect(themes.uninstall(COMPOSED)).rejects.toThrow(/is inherited by/);
  });

  it("refuses an edit that would darken the register in a theme inheriting from it", async () => {
    // Colours chosen by measurement, not by eye. Against the default board the
    // child's ink reads at 5.63:1 and 4.98:1 on the raised surface, so it
    // composes cleanly; the parent's own inherited inks stay at 4.97:1 or
    // better on the new board, so the parent alone would pass. Only the pair
    // the two themes make together falls, to 4.03:1.
    // The child states the register ink and inherits the board it sits on, so
    // only the two together decide whether the register can be read - and the
    // parent is where the board comes from.
    await installer.compose(
      {
        id: CHILD,
        displayName: "Husets farger, ljusare",
        extends: COMPOSED,
        modes: {
          light: { "surface-page": "#F5F3EE", "text-register": "#959595" },
          dark: {},
        },
      },
      null,
    );
    await themes.activate(CHILD, null);

    const before = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: COMPOSED },
    });

    // Legible in the parent itself, illegible under the child's own ink.
    await expect(
      installer.compose(
        {
          id: COMPOSED,
          displayName: "Husets farger",
          extends: "porttavlan",
          modes: { light: { "surface-register": "#363636" }, dark: {} },
          description: undefined,
        },
        null,
      ),
    ).rejects.toMatchObject({ reason: "lint-failed" });

    // The refusal names the theme the board would have to go and look at.
    await expect(
      installer.compose(
        {
          id: COMPOSED,
          displayName: "Husets farger",
          extends: "porttavlan",
          modes: { light: { "surface-register": "#363636" }, dark: {} },
          description: undefined,
        },
        null,
      ),
    ).rejects.toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          rule: "contrast",
          detail: expect.objectContaining({ theme: CHILD, statutory: true }),
        }),
      ]),
    });

    // Nothing was written: the parent stands at the version it had, and the
    // child still renders what it rendered.
    const after = await prisma.installedTheme.findUniqueOrThrow({
      where: { id: COMPOSED },
    });
    expect(after.version).toBe(before.version);
    expect(after.declaredLightTokens).toEqual(before.declaredLightTokens);

    await themes.activate(null, null);
  });

  it("uninstalls, taking its files with it", async () => {
    await themes.uninstall(CHILD);
    await themes.uninstall(COMPOSED);

    expect(
      await prisma.installedTheme.findUnique({ where: { id: COMPOSED } }),
    ).toBeNull();
    await expect(
      stat(join(dataDirectory, "themes", COMPOSED)),
    ).rejects.toThrow();
  });
});
