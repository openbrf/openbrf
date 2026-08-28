import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  BUILT_IN_THEME,
  chainEntryFor,
  lintTheme,
  readThemePackage,
  resolveThemeChain,
  type ThemeChainEntry,
  type ThemeLintFinding,
  type ThemeManifest,
} from "@openbrf/theme-tools";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { CatalogThemeSource, type CatalogEntry } from "./theme-source";
import { ThemeStore } from "./theme-store";
import { ThemeService, type ThemeSummary } from "./theme.service";

/**
 * Installing a theme from the catalog.
 *
 * The path is: read the catalog, download the package, verify its sha512,
 * refuse it unless the lint passes, write it to the data volume, record it.
 * No restart at any point - a theme carries no code, so there is nothing to
 * load into the process (decision 43).
 *
 * The lint is a gate rather than a report. A theme that fails it never reaches
 * the data volume, so a board cannot install one that renders the statutory
 * register illegibly or fetches a font from a third party.
 *
 * This runs inside the request rather than as a background job, which is the
 * one place it deliberately differs from the plugin install. A plugin install
 * ends in a restart and therefore has to survive the process going away; a
 * theme install ends in a database row, and running it inline is what lets the
 * install screen answer with the lint findings that caused a refusal.
 */

export class ThemeInstallError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "not-in-catalog"
      | "package-unreadable"
      | "manifest-invalid"
      | "identity-mismatch"
      | "lint-failed"
      | "housing-cooperative-missing",
    /** Populated for lint-failed, so the screen can name every rule that failed. */
    readonly findings: readonly ThemeLintFinding[] = [],
    /** Populated for the archive and manifest failures. */
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.status =
      reason === "not-in-catalog"
        ? HttpStatus.NOT_FOUND
        : reason === "housing-cooperative-missing"
          ? HttpStatus.CONFLICT
          : HttpStatus.UNPROCESSABLE_ENTITY;
  }

  /**
   * What the install screen needs in order to say why a package was refused.
   *
   * Lint findings are rule codes with the numbers that were measured, and the
   * archive and manifest issues name a path or a schema field. Neither carries
   * anything the requester submitted beyond the catalog id they already know.
   */
  override details(): Record<string, readonly unknown[]> {
    return { findings: this.findings, issues: this.issues };
  }
}

/** A catalog entry as the install screen lists it. */
export interface CatalogThemeView {
  id: string;
  name: string;
  description: string | null;
  version: string;
  /** The token contract range the catalog states for the entry. */
  contract: string | null;
  /** The installed version, when this theme is already installed. */
  installedVersion: string | null;
}

export interface ThemeInstallResult {
  theme: ThemeSummary;
  /**
   * Findings that did not block the install: a token or a manifest field this
   * core does not know, which the contract says to ignore rather than refuse.
   */
  warnings: readonly ThemeLintFinding[];
}

@Injectable()
export class ThemeInstallService {
  private readonly logger = new Logger(ThemeInstallService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly source: CatalogThemeSource,
    private readonly store: ThemeStore,
    private readonly themes: ThemeService,
  ) {}

  /** The catalog's themes, each marked with whether it is already installed. */
  async catalog(): Promise<CatalogThemeView[]> {
    const [entries, installed] = await Promise.all([
      this.source.listThemes(),
      this.themes.installedRows(),
    ]);
    const versionById = new Map(
      installed.map((row) => [row.id, row.version] as const),
    );

    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description ?? null,
      version: entry.version,
      contract: entry.contract ?? null,
      installedVersion: versionById.get(entry.id) ?? null,
    }));
  }

  async install(
    catalogId: string,
    actorPersonId: string | null,
  ): Promise<ThemeInstallResult> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    if (association === null) {
      throw new ThemeInstallError(
        "Create the housing cooperative before installing a theme.",
        "housing-cooperative-missing",
      );
    }

    const entries = await this.source.listThemes();
    const entry = entries.find((candidate) => candidate.id === catalogId);
    if (entry === undefined) {
      throw new ThemeInstallError(
        `The catalog has no theme ${catalogId}.`,
        "not-in-catalog",
      );
    }

    // Verified against the catalog's sha512 before anything is unpacked.
    const bytes = await this.source.fetchPackage(entry);

    const read = readThemePackage(bytes);
    if (!read.ok) {
      throw new ThemeInstallError(
        `The package for ${entry.id} could not be read.`,
        read.reason === "archive" ? "package-unreadable" : "manifest-invalid",
        [],
        read.issues,
      );
    }

    const { manifest, files, raw } = read.package;
    this.assertIdentityMatches(entry, manifest);

    const lint = await this.lintAgainstInstalled(
      manifest,
      [...files.keys()],
      raw,
    );
    if (!lint.ok) {
      throw new ThemeInstallError(
        `The theme ${manifest.name} did not pass the install lint.`,
        "lint-failed",
        lint.findings.filter((finding) => finding.severity === "error"),
      );
    }

    /*
     * Staged beside the installed version, not over it. Storage and the
     * database cannot share a transaction, so the transaction below is made the
     * decider: the files move into place as its last step, so anything that
     * refuses the install leaves the version already installed exactly as it
     * was rather than pairing an old row with new files. The only case left
     * open is a connection lost between the two, which no ordering closes
     * without a distributed transaction.
     */
    const staged = await this.store.stage(manifest.name, files);

    const resolved = lint.resolved;
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = {
          name: manifest.displayName,
          version: manifest.version,
          description: manifest.description ?? null,
          contract: manifest.contract,
          extendsThemeId: manifest.extends ?? null,
          checksum: entry.sha512,
          sourceUrl: entry.url,
          catalogId: entry.id,
          declaredLightTokens: manifest.modes.light as Prisma.InputJsonValue,
          declaredDarkTokens: manifest.modes.dark as Prisma.InputJsonValue,
          lightTokens: (resolved?.light ?? {}) as Prisma.InputJsonValue,
          darkTokens: (resolved?.dark ?? {}) as Prisma.InputJsonValue,
          viewVariants: manifest.viewVariants as Prisma.InputJsonValue,
          fonts: manifest.fonts as unknown as Prisma.InputJsonValue,
          logoPath: manifest.logo ?? null,
        };

        await tx.installedTheme.upsert({
          where: { id: manifest.name },
          create: { id: manifest.name, ...row },
          update: row,
        });

        await this.audit.record(
          {
            action: "THEME_INSTALLED",
            actorPersonId,
            targetKind: "theme",
            targetId: manifest.name,
            context: {
              version: manifest.version,
              source: entry.url,
              checksum: entry.sha512,
            },
          },
          tx,
        );

        // Last, so that a swap this cannot complete rolls the row back with it
        // and the previous version keeps rendering.
        await staged.commit();
      });
    } catch (cause) {
      await staged.discard();
      throw cause;
    }

    // A reinstall changes what this theme's descendants render.
    await this.themes.recomputeResolvedTokens();

    this.logger.log(
      `Installed theme ${manifest.name}@${manifest.version} from ${entry.url}`,
    );

    const summaries = await this.themes.list();
    const summary = summaries.find((theme) => theme.id === manifest.name);
    if (summary === undefined) {
      throw new Error(
        `The theme ${manifest.name} was installed but is not in the list.`,
      );
    }

    return {
      theme: summary,
      warnings: lint.findings.filter(
        (finding) => finding.severity === "warning",
      ),
    };
  }

  /**
   * Refuses a package whose manifest disagrees with the catalog entry.
   *
   * The checksum proves the bytes are the ones the catalog meant; it says
   * nothing about what those bytes claim to be. Without this check a catalog
   * entry called `example-theme` could install a package that names itself
   * something else, and the theme a board thought they were installing would
   * not be the one they got.
   */
  private assertIdentityMatches(
    entry: CatalogEntry,
    manifest: ThemeManifest,
  ): void {
    if (manifest.name !== entry.id) {
      throw new ThemeInstallError(
        `The catalog lists ${entry.id} but the package names itself ${manifest.name}.`,
        "identity-mismatch",
      );
    }
    if (manifest.version !== entry.version) {
      throw new ThemeInstallError(
        `The catalog lists ${entry.id} at ${entry.version} but the package is ${manifest.version}.`,
        "identity-mismatch",
      );
    }
  }

  /**
   * Lints the manifest against the themes already installed.
   *
   * The chain matters: a theme extending another installed theme has to be
   * measured with its parent's values in place, or a child that only changes
   * the accent would look like a theme with no colours at all.
   */
  private async lintAgainstInstalled(
    manifest: ThemeManifest,
    files: readonly string[],
    raw: Readonly<Record<string, unknown>>,
  ) {
    const rows = await this.themes.installedRows();
    const entries: ThemeChainEntry[] = rows
      .filter((row) => row.id !== manifest.name)
      .map((row) => ThemeService.chainEntryOf(row));

    const candidate = chainEntryFor(manifest);
    const byId = new Map<string, ThemeChainEntry>([
      [BUILT_IN_THEME.id, BUILT_IN_THEME],
      ...entries.map((entry) => [entry.id, entry] as const),
      [candidate.id, candidate],
    ]);

    return lintTheme({
      manifest,
      files,
      chain: resolveThemeChain(manifest.name, (id) => byId.get(id)),
      rawManifest: raw,
    });
  }
}
