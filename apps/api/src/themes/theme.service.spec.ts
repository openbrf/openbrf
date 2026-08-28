import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { InstalledTheme } from "../generated/prisma/client";
import type { ThemeStore } from "./theme-store";
import { ThemeError, ThemeService } from "./theme.service";

/**
 * Activation, inheritance and removal.
 *
 * Three rules here are load-bearing rather than tidy. The default theme has no
 * row and can never be removed, so an instance always has something legible to
 * fall back to. A theme other themes inherit from cannot be removed out from
 * under them. And activation re-measures the statutory contrast pairs, because
 * an ancestor may have been replaced since the install lint ran and the
 * register is a document the law requires the association to be able to read.
 */

function themeRow(overrides: Partial<InstalledTheme> = {}): InstalledTheme {
  return {
    id: "example-theme",
    name: "Example",
    version: "1.0.0",
    description: null,
    contract: "^1.0.0",
    extendsThemeId: "porttavlan",
    checksum: "a".repeat(128),
    sourceUrl: "https://example.com/example-theme-1.0.0.tgz",
    catalogId: "example-theme",
    declaredLightTokens: { "accent-trust": "#2F5D50" },
    declaredDarkTokens: { "accent-trust": "#7FBFAA" },
    lightTokens: {},
    darkTokens: {},
    viewVariants: { memberRegister: "table" },
    fonts: [],
    logoPath: null,
    installedAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as InstalledTheme;
}

interface Harness {
  service: ThemeService;
  rows: InstalledTheme[];
  activeThemeId: () => string | null;
  audited: { action: string; targetId: string | null }[];
  removed: string[];
}

function build(
  rows: InstalledTheme[] = [],
  options: {
    activeThemeId?: string | null;
    association?: boolean;
    /** Makes the filesystem removal fail, as a full volume or a lock would. */
    removalFails?: boolean;
  } = {},
): Harness {
  let active = options.activeThemeId ?? null;
  const exists = options.association ?? true;
  const audited: { action: string; targetId: string | null }[] = [];
  const removed: string[] = [];

  const prisma = {
    association: {
      findUnique: vi.fn(async () =>
        exists ? { id: 1, activeThemeId: active } : null,
      ),
      update: vi.fn(
        async (args: { data: { activeThemeId: string | null } }) => {
          active = args.data.activeThemeId;
          return { id: 1, activeThemeId: active };
        },
      ),
    },
    installedTheme: {
      findMany: vi.fn(async () => [...rows]),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          rows.find((row) => row.id === args.where.id) ?? null,
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Partial<InstalledTheme>;
        }) => {
          const index = rows.findIndex((row) => row.id === args.where.id);
          if (index >= 0) {
            rows[index] = { ...rows[index], ...args.data } as InstalledTheme;
          }
          return rows[index];
        },
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === args.where.id);
        const [deleted] = rows.splice(index, 1);
        return deleted;
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run(prisma),
    ),
  };

  const audit = {
    record: vi.fn(
      async (entry: { action: string; targetId?: string | null }) => {
        audited.push({
          action: entry.action,
          targetId: entry.targetId ?? null,
        });
      },
    ),
  };

  const store = {
    directoryFor: (id: string) => `/data/themes/${id}`,
    remove: vi.fn(async (id: string) => {
      if (options.removalFails === true) {
        throw new Error("The directory could not be removed.");
      }
      removed.push(id);
    }),
    readAsset: vi.fn(async () => Buffer.from("asset")),
  };

  return {
    service: new ThemeService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      store as unknown as ThemeStore,
    ),
    rows,
    activeThemeId: () => active,
    audited,
    removed,
  };
}

let harness: Harness;

beforeEach(() => {
  harness = build([themeRow()]);
});

describe("listing", () => {
  it("always includes the built-in theme, and marks it active by default", async () => {
    const themes = await harness.service.list();
    const builtIn = themes.find((theme) => theme.builtIn);
    expect(builtIn?.id).toBe("porttavlan");
    expect(builtIn?.active).toBe(true);
    expect(builtIn?.version).toBeNull();
  });

  it("resolves every registered view variant, even for a theme that named none", async () => {
    const themes = await build([themeRow({ viewVariants: {} })]).service.list();
    const installed = themes.find((theme) => theme.id === "example-theme");
    expect(installed?.viewVariants).toEqual({ memberRegister: "table" });
  });
});

describe("rendering", () => {
  it("merges a theme's values over the ones it inherits", async () => {
    const rendering = await harness.service.renderingOf("example-theme");
    expect(rendering.modes.light["accent-trust"]).toBe("#2F5D50");
    expect(rendering.modes.light["surface-page"]).toBe(
      PORTTAVLAN_LIGHT["surface-page"],
    );
    expect(rendering.modes.dark["surface-page"]).toBe(
      PORTTAVLAN_DARK["surface-page"],
    );
  });

  it("points font faces at this instance's own asset route", async () => {
    const withFont = build([
      themeRow({
        fonts: [
          {
            family: "Spline Sans Mono",
            license: "OFL-1.1",
            files: [
              { path: "fonts/mono.woff2", weight: "400", style: "normal" },
            ],
          },
        ] as never,
      }),
    ]);

    const rendering = await withFont.service.renderingOf("example-theme");
    expect(rendering.fontFaces[0]?.url).toBe(
      "/api/themes/asset?theme=example-theme&file=fonts%2Fmono.woff2",
    );
  });

  it("refuses to render a theme that is not installed", async () => {
    await expect(harness.service.renderingOf("nothing")).rejects.toThrow(
      ThemeError,
    );
  });

  /*
   * A theme that cannot be resolved must not take the interface down with it.
   * Falling back keeps the instance readable, which matters most for the
   * statutory register.
   */
  it("falls back to the built-in theme when the active one cannot be resolved", async () => {
    const orphaned = build([themeRow({ extendsThemeId: "never-installed" })], {
      activeThemeId: "example-theme",
    });
    const rendering = await orphaned.service.activeRendering();
    expect(rendering.builtIn).toBe(true);
    expect(rendering.id).toBe("porttavlan");
  });
});

describe("activation", () => {
  it("switches the active theme and records it", async () => {
    await harness.service.activate("example-theme", "person-1");
    expect(harness.activeThemeId()).toBe("example-theme");
    expect(harness.audited).toEqual([
      { action: "THEME_ACTIVATED", targetId: "example-theme" },
    ]);
  });

  it("treats the built-in theme's id as returning to the default", async () => {
    await harness.service.activate("example-theme", null);
    await harness.service.activate("porttavlan", null);
    expect(harness.activeThemeId()).toBeNull();
  });

  it("refuses a theme that no longer meets the statutory contrast bar", async () => {
    // The install lint would have refused this, but an ancestor can be replaced
    // afterwards, so activation measures again.
    const illegible = build([
      themeRow({ declaredLightTokens: { "text-register": "#202124" } }),
    ]);

    await expect(
      illegible.service.activate("example-theme", null),
    ).rejects.toThrow(ThemeError);
    expect(illegible.activeThemeId()).toBeNull();
  });

  it("refuses before the housing cooperative exists", async () => {
    const fresh = build([themeRow()], { association: false });
    await expect(fresh.service.activate("example-theme", null)).rejects.toThrow(
      /housing cooperative/i,
    );
  });
});

describe("removal", () => {
  it("removes the row and the files together", async () => {
    await harness.service.uninstall("example-theme");
    expect(harness.rows).toEqual([]);
    expect(harness.removed).toEqual(["example-theme"]);
  });

  it("refuses to remove the built-in theme", async () => {
    await expect(harness.service.uninstall("porttavlan")).rejects.toThrow(
      /built into the core/,
    );
  });

  it("refuses to remove the active theme", async () => {
    const active = build([themeRow()], { activeThemeId: "example-theme" });
    await expect(active.service.uninstall("example-theme")).rejects.toThrow(
      ThemeError,
    );
    expect(active.rows).toHaveLength(1);
  });

  it("refuses to remove a theme another theme inherits from", async () => {
    const withChild = build([
      themeRow(),
      themeRow({ id: "child-theme", extendsThemeId: "example-theme" }),
    ]);

    await expect(withChild.service.uninstall("example-theme")).rejects.toThrow(
      /inherited by child-theme/,
    );
  });

  /*
   * The refusal names the themes that blocked it, so a board member is not left
   * to work out which of the installed themes inherits from this one. They
   * travel as codes, like every other refusal's particulars.
   */
  it("names the themes that blocked a removal", async () => {
    const withChildren = build([
      themeRow(),
      themeRow({ id: "child-theme", extendsThemeId: "example-theme" }),
      themeRow({ id: "other-child", extendsThemeId: "example-theme" }),
    ]);

    const refusal = await withChildren.service.uninstall("example-theme").then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(refusal).toBeInstanceOf(ThemeError);
    expect((refusal as ThemeError).details()).toEqual({
      findings: [
        {
          rule: "theme-has-dependants",
          severity: "error",
          detail: { themeId: "child-theme" },
        },
        {
          rule: "theme-has-dependants",
          severity: "error",
          detail: { themeId: "other-child" },
        },
      ],
    });
  });

  /*
   * The row is what the instance reads, and it is already gone. Reporting a
   * failure would send a board member to retry a removal that has happened,
   * and the second attempt would answer that the theme is not installed.
   */
  it("completes the removal even when the files cannot be deleted", async () => {
    const stuck = build([themeRow()], { removalFails: true });

    const themes = await stuck.service.uninstall("example-theme");

    expect(stuck.rows).toEqual([]);
    expect(themes.some((theme) => theme.id === "example-theme")).toBe(false);
  });
});

describe("resolved token maintenance", () => {
  it("recomputes what every installed theme renders", async () => {
    // The stored sets start empty; recomputation is what fills them, and it is
    // what a change to an ancestor has to trigger.
    await harness.service.recomputeResolvedTokens();
    const stored = harness.rows[0]?.lightTokens as Record<string, string>;
    expect(stored["accent-trust"]).toBe("#2F5D50");
    expect(stored["surface-page"]).toBe(PORTTAVLAN_LIGHT["surface-page"]);
  });
});

describe("assets", () => {
  it("serves only files the manifest declared", async () => {
    const withFont = build([
      themeRow({
        fonts: [
          {
            family: "Spline Sans Mono",
            license: "OFL-1.1",
            licenseFile: "fonts/OFL.txt",
            files: [
              { path: "fonts/mono.woff2", weight: "400", style: "normal" },
            ],
          },
        ] as never,
        logoPath: "logo.png",
      }),
    ]);

    expect(
      await withFont.service.asset("example-theme", "fonts/mono.woff2"),
    ).not.toBeNull();
    expect(
      await withFont.service.asset("example-theme", "fonts/OFL.txt"),
    ).not.toBeNull();
    expect(
      await withFont.service.asset("example-theme", "logo.png"),
    ).not.toBeNull();
    // Present in the package but never declared: not served.
    expect(
      await withFont.service.asset("example-theme", "theme.json"),
    ).toBeNull();
  });

  it("serves nothing for a theme that is not installed", async () => {
    expect(await harness.service.asset("nothing", "logo.png")).toBeNull();
  });

  it("serves nothing for a path the theme never declared", async () => {
    const withFont = build([
      themeRow({
        fonts: [
          {
            family: "Spline Sans Mono",
            license: "OFL-1.1",
            files: [
              { path: "fonts/mono.woff2", weight: "400", style: "normal" },
            ],
          },
        ] as never,
      }),
    ]);

    // The theme is installed, so the allowlist is what answers rather than a
    // missing row, and it answers for a traversal path like any other path
    // nobody declared: there is no such asset.
    for (const path of [
      "../../../etc/passwd",
      "fonts/../../secret.txt",
      "/etc/passwd",
    ]) {
      expect(await withFont.service.asset("example-theme", path)).toBeNull();
    }
  });
});

/*
 * A JSON column is not a checked type. The install lint validated what it
 * wrote, but a row from an earlier version or one edited directly has no such
 * guarantee, and one of the three readers is a route an anonymous request
 * reaches. A malformed declaration is dropped rather than faulting it.
 */
describe("a fonts column that was not written by this version", () => {
  const malformed = () =>
    build([
      themeRow({
        fonts: [
          { family: "No Files", license: "OFL-1.1" },
          "not an object",
          {
            family: "Escaping",
            license: "OFL-1.1",
            files: [
              {
                path: "fonts/mono.woff2",
                weight: "400; } body { display: none",
                style: "normal",
              },
            ],
          },
          {
            family: "Spline Sans Mono",
            license: "OFL-1.1",
            files: [
              { path: "fonts/mono.woff2", weight: "400", style: "normal" },
            ],
          },
        ] as never,
      }),
    ]);

  it("answers the asset route instead of faulting on a declaration with no files", async () => {
    const service = malformed().service;
    expect(
      await service.asset("example-theme", "fonts/mono.woff2"),
    ).not.toBeNull();
    expect(await service.asset("example-theme", "theme.json")).toBeNull();
  });

  it("renders only the declarations that hold to the manifest contract", async () => {
    const rendering = await malformed().service.renderingOf("example-theme");
    expect(rendering.fontFaces).toHaveLength(1);
    expect(rendering.fontFaces[0]?.family).toBe("Spline Sans Mono");

    const [summary] = (await malformed().service.list()).filter(
      (theme) => theme.id === "example-theme",
    );
    expect(summary?.fonts).toEqual([
      { family: "Spline Sans Mono", license: "OFL-1.1" },
    ]);
  });
});
