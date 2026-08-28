import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  BUILT_IN_THEME,
  buildFontFaceStylesheet,
  resolveChainTokens,
  resolveThemeChain,
  resolveViewVariant,
  type ThemeChainEntry,
  type ThemeFontDeclaration,
  type ThemeFontFaceSource,
  themeFontFaces,
  VIEW_VARIANT_SLOTS,
} from "@openbrf/theme-tools";
import {
  checkContrast,
  PORTTAVLAN_ID,
  type PartialTokenSet,
  type TokenSet,
} from "@openbrf/tokens";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { InstalledTheme } from "../generated/prisma/client";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { ThemeStore } from "./theme-store";

/**
 * The themes an instance has, and which one it renders.
 *
 * A theme is data, so activation is a database write and a stylesheet the
 * browser applies - no restart, no process reload, nothing on the request path
 * that has to be reloaded (decision 43). That is the whole reason themes are
 * separated from plugins.
 *
 * The default theme is not a row in this table. It ships with the core, is
 * always present, always inheritable and cannot be uninstalled (decision 48).
 * A null activeThemeId means it is what renders.
 */

export class ThemeError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "theme-not-installed"
      | "built-in-theme"
      | "theme-in-use"
      | "theme-has-dependants"
      | "theme-unresolvable"
      | "housing-cooperative-missing",
    /** Named for theme-has-dependants, so the screen can list them. */
    readonly dependants: readonly string[] = [],
  ) {
    super(message);
    // Everything except a theme that is simply not there is a state conflict:
    // the request was understood and refused on the instance's own state.
    this.status =
      reason === "theme-not-installed"
        ? HttpStatus.NOT_FOUND
        : HttpStatus.CONFLICT;
  }
}

/** One font as the interface lists it: the family and the licence it carries. */
export interface ThemeFontSummary {
  family: string;
  license: string;
}

/** A theme in a list. Carries no token values: those are fetched per theme. */
export interface ThemeSummary {
  id: string;
  name: string;
  description: string | null;
  /** Null for the built-in theme, which is versioned with the core. */
  version: string | null;
  builtIn: boolean;
  active: boolean;
  extendsThemeId: string | null;
  fonts: ThemeFontSummary[];
  /** Every registered slot, with what this theme renders it as. */
  viewVariants: Record<string, string>;
  installedAt: string | null;
}

/** Everything the browser needs to render a theme. */
export interface ThemeRendering {
  id: string;
  name: string;
  builtIn: boolean;
  modes: { light: TokenSet; dark: TokenSet };
  /** @font-face sources, already pointed at this instance's own asset route. */
  fontFaces: ThemeFontFaceSource[];
  viewVariants: Record<string, string>;
  logoUrl: string | null;
}

/**
 * The asset route a theme's own files are served from.
 *
 * Built here so the browser never constructs a path into the data volume: it
 * receives finished URLs, and the server decides which files exist.
 */
export function themeAssetUrl(themeId: string, path: string): string {
  return `/api/themes/asset?theme=${encodeURIComponent(themeId)}&file=${encodeURIComponent(path)}`;
}

/** Reads a JSON column back as token values, ignoring anything else. */
export function asTokenRecord(value: unknown): PartialTokenSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const tokens: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      tokens[name] = entry;
    }
  }
  return tokens as PartialTokenSet;
}

function asFontDeclarations(value: unknown): ThemeFontDeclaration[] {
  return Array.isArray(value) ? (value as ThemeFontDeclaration[]) : [];
}

function asVariantSelection(value: unknown): Record<string, string> {
  const selection: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return selection;
  }
  for (const [slot, variant] of Object.entries(value)) {
    if (typeof variant === "string") {
      selection[slot] = variant;
    }
  }
  return selection;
}

/** Every registered slot, resolved against what a theme asked for. */
export function resolvedViewVariants(
  selection: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const slot of VIEW_VARIANT_SLOTS) {
    const variant = resolveViewVariant(slot.slot, selection);
    if (variant !== undefined) {
      resolved[slot.slot] = variant;
    }
  }
  return resolved;
}

@Injectable()
export class ThemeService {
  private readonly logger = new Logger(ThemeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly store: ThemeStore,
  ) {}

  /** The chain entry an installed row contributes to inheritance. */
  static chainEntryOf(row: InstalledTheme): ThemeChainEntry {
    return {
      id: row.id,
      extends: row.extendsThemeId,
      modes: {
        light: asTokenRecord(row.declaredLightTokens),
        dark: asTokenRecord(row.declaredDarkTokens),
      },
    };
  }

  /**
   * A lookup over the built-in theme plus everything installed.
   *
   * Built from a snapshot rather than querying per hop, so resolving a chain is
   * one read however deep the chain goes.
   */
  static lookupOver(rows: readonly InstalledTheme[]) {
    const byId = new Map<string, ThemeChainEntry>([
      [BUILT_IN_THEME.id, BUILT_IN_THEME],
    ]);
    for (const row of rows) {
      byId.set(row.id, ThemeService.chainEntryOf(row));
    }
    return (id: string): ThemeChainEntry | undefined => byId.get(id);
  }

  async installedRows(): Promise<InstalledTheme[]> {
    return this.prisma.installedTheme.findMany({ orderBy: { name: "asc" } });
  }

  /** The id of the active theme, or null when the built-in one is active. */
  async activeThemeId(): Promise<string | null> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { activeThemeId: true },
    });
    return association?.activeThemeId ?? null;
  }

  async list(): Promise<ThemeSummary[]> {
    const [rows, activeId] = await Promise.all([
      this.installedRows(),
      this.activeThemeId(),
    ]);

    const builtIn: ThemeSummary = {
      id: PORTTAVLAN_ID,
      name: "Porttavlan",
      description: null,
      version: null,
      builtIn: true,
      active: activeId === null,
      extendsThemeId: null,
      fonts: [],
      viewVariants: resolvedViewVariants({}),
      installedAt: null,
    };

    return [
      builtIn,
      ...rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        version: row.version,
        builtIn: false,
        active: row.id === activeId,
        extendsThemeId: row.extendsThemeId,
        fonts: asFontDeclarations(row.fonts).map((font) => ({
          family: font.family,
          license: font.license,
        })),
        viewVariants: resolvedViewVariants(
          asVariantSelection(row.viewVariants),
        ),
        installedAt: row.installedAt.toISOString(),
      })),
    ];
  }

  /** The built-in theme, as the browser renders it. */
  static builtInRendering(): ThemeRendering {
    return {
      id: PORTTAVLAN_ID,
      name: "Porttavlan",
      builtIn: true,
      modes: {
        light: BUILT_IN_THEME.modes.light as TokenSet,
        dark: BUILT_IN_THEME.modes.dark as TokenSet,
      },
      fontFaces: [],
      viewVariants: resolvedViewVariants({}),
      logoUrl: null,
    };
  }

  /**
   * What the instance currently renders.
   *
   * Reachable without a session on purpose: the sign-in screen is themed too,
   * and everything in the response is colours, typefaces and layout choices.
   * It carries nothing about the register, the cooperative or any person.
   */
  async activeRendering(): Promise<ThemeRendering> {
    const activeId = await this.activeThemeId();
    if (activeId === null) {
      return ThemeService.builtInRendering();
    }

    const rendering = await this.renderingOf(activeId).catch(
      (cause: unknown) => {
        // A theme that cannot be resolved must not take the interface down.
        // Falling back to the built-in theme keeps the instance readable, which
        // matters most for the statutory register.
        this.logger.error(
          `The active theme ${activeId} could not be resolved; rendering the built-in theme instead.`,
          cause instanceof Error ? cause.stack : undefined,
        );
        return ThemeService.builtInRendering();
      },
    );
    return rendering;
  }

  /**
   * One installed theme, as the browser renders it.
   *
   * This is what live preview applies: the same resolution the activated theme
   * would go through, so what a board sees before activating is what they get
   * after. Nothing is written, so the preview reaches only the session that
   * asked for it.
   */
  async renderingOf(themeId: string): Promise<ThemeRendering> {
    if (themeId === PORTTAVLAN_ID) {
      return ThemeService.builtInRendering();
    }

    const rows = await this.installedRows();
    const row = rows.find((entry) => entry.id === themeId);
    if (row === undefined) {
      throw new ThemeError(
        `No theme ${themeId} is installed.`,
        "theme-not-installed",
      );
    }

    const chain = resolveThemeChain(themeId, ThemeService.lookupOver(rows));
    if (!chain.ok) {
      throw new ThemeError(
        `The theme ${themeId} cannot be resolved: ${chain.reason} at ${chain.themeId}.`,
        "theme-unresolvable",
      );
    }

    const resolved = resolveChainTokens(chain.chain);
    if (resolved.light.missing.length > 0 || resolved.dark.missing.length > 0) {
      throw new ThemeError(
        `The theme ${themeId} leaves required tokens unset.`,
        "theme-unresolvable",
      );
    }

    const fonts = asFontDeclarations(row.fonts);
    return {
      id: row.id,
      name: row.name,
      builtIn: false,
      modes: { light: resolved.light.tokens, dark: resolved.dark.tokens },
      fontFaces: themeFontFaces(fonts, (path) => themeAssetUrl(row.id, path)),
      viewVariants: resolvedViewVariants(asVariantSelection(row.viewVariants)),
      logoUrl:
        row.logoPath === null ? null : themeAssetUrl(row.id, row.logoPath),
    };
  }

  /** The @font-face rules for a rendering, for a caller that wants CSS. */
  static fontStylesheet(rendering: ThemeRendering): string {
    return buildFontFaceStylesheet(rendering.fontFaces);
  }

  /**
   * Switches the active theme.
   *
   * Passing the built-in theme's id, or null, returns to it. The resolved set
   * is re-checked against the statutory contrast pairs first: the install lint
   * already passed, but an ancestor may have been replaced since, and the
   * member and apartment registers are documents the law requires the
   * association to be able to read.
   */
  async activate(
    themeId: string | null,
    actorPersonId: string | null,
  ): Promise<ThemeSummary[]> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    if (association === null) {
      throw new ThemeError(
        "Create the housing cooperative before choosing a theme.",
        "housing-cooperative-missing",
      );
    }

    const target = themeId === PORTTAVLAN_ID ? null : themeId;

    if (target !== null) {
      const rendering = await this.renderingOf(target);
      for (const mode of ["light", "dark"] as const) {
        const failures = checkContrast(rendering.modes[mode]).filter(
          (finding) => finding.statutory,
        );
        if (failures.length > 0) {
          throw new ThemeError(
            `The theme ${target} no longer meets the statutory contrast bar in ${mode} mode.`,
            "theme-unresolvable",
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.association.update({
        where: { id: 1 },
        data: { activeThemeId: target },
      });
      await this.audit.record(
        {
          action: "THEME_ACTIVATED",
          actorPersonId,
          targetKind: "theme",
          targetId: target ?? PORTTAVLAN_ID,
        },
        tx,
      );
    });

    this.logger.log(`Activated theme ${target ?? PORTTAVLAN_ID}`);
    return this.list();
  }

  /**
   * Removes an installed theme.
   *
   * Refused while it is active or while another installed theme inherits from
   * it: both would leave the instance pointing at values that no longer exist.
   * The built-in theme has no row and can never be removed.
   */
  async uninstall(themeId: string): Promise<ThemeSummary[]> {
    if (themeId === PORTTAVLAN_ID) {
      throw new ThemeError(
        "The default theme is built into the core and cannot be removed.",
        "built-in-theme",
      );
    }

    const [rows, activeId] = await Promise.all([
      this.installedRows(),
      this.activeThemeId(),
    ]);

    if (!rows.some((row) => row.id === themeId)) {
      throw new ThemeError(
        `No theme ${themeId} is installed.`,
        "theme-not-installed",
      );
    }
    if (activeId === themeId) {
      throw new ThemeError(
        `The theme ${themeId} is the active one. Switch to another theme first.`,
        "theme-in-use",
      );
    }

    const dependants = rows
      .filter((row) => row.extendsThemeId === themeId)
      .map((row) => row.id);
    if (dependants.length > 0) {
      throw new ThemeError(
        `The theme ${themeId} is inherited by ${dependants.join(", ")}.`,
        "theme-has-dependants",
        dependants,
      );
    }

    await this.prisma.installedTheme.delete({ where: { id: themeId } });
    await this.store.remove(themeId);
    await this.recomputeResolvedTokens();

    this.logger.log(`Uninstalled theme ${themeId}`);
    return this.list();
  }

  /**
   * Recomputes every installed theme's resolved token sets.
   *
   * Run after any install or removal. A theme's resolved values depend on its
   * ancestors, so replacing one theme changes what its descendants render, and
   * leaving the stored sets stale would make the interface show values the
   * install lint never measured.
   */
  async recomputeResolvedTokens(): Promise<void> {
    const rows = await this.installedRows();
    const lookup = ThemeService.lookupOver(rows);

    for (const row of rows) {
      const chain = resolveThemeChain(row.id, lookup);
      if (!chain.ok) {
        this.logger.warn(
          `Theme ${row.id} cannot be resolved (${chain.reason} at ${chain.themeId}); leaving its stored values as they are.`,
        );
        continue;
      }
      const resolved = resolveChainTokens(chain.chain);
      await this.prisma.installedTheme.update({
        where: { id: row.id },
        data: {
          lightTokens: resolved.light.tokens as Prisma.InputJsonValue,
          darkTokens: resolved.dark.tokens as Prisma.InputJsonValue,
        },
      });
    }
  }

  /** One file from an installed theme, or null when there is no such file. */
  async asset(
    themeId: string,
    path: string,
  ): Promise<{ contents: Buffer; declared: true } | null> {
    const row = await this.prisma.installedTheme.findUnique({
      where: { id: themeId },
      select: { fonts: true, logoPath: true },
    });
    if (row === null) {
      return null;
    }

    /*
     * Served from what the manifest declared, not from whatever the directory
     * happens to contain. An allowlist built from the theme's own declarations
     * means a file that was never part of the theme cannot be requested, which
     * is a stronger guarantee than checking the path alone.
     */
    const declared = new Set<string>();
    for (const font of asFontDeclarations(row.fonts)) {
      for (const file of font.files) {
        declared.add(file.path);
      }
      if (font.licenseFile !== undefined) {
        declared.add(font.licenseFile);
      }
    }
    if (row.logoPath !== null) {
      declared.add(row.logoPath);
    }

    if (!declared.has(path)) {
      return null;
    }

    const contents = await this.store.readAsset(themeId, path);
    return contents === null ? null : { contents, declared: true };
  }
}
