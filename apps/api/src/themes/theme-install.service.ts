import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { checkContrast } from "@openbrf/tokens";
import {
  BUILT_IN_THEME,
  chainEntryFor,
  lintTheme,
  readThemePackage,
  resolveChainTokens,
  resolveThemeChain,
  type ThemeArchiveFiles,
  type ThemeChainEntry,
  type ThemeLintFinding,
  type ThemeManifest,
} from "@openbrf/theme-tools";

import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import {
  COMPOSED_AUDIT_SOURCE,
  composedChecksum,
  composedManifest,
  composedSourceUrl,
  type ComposeThemeInput,
} from "./theme-compose";
import { CatalogThemeSource, type CatalogEntry } from "./theme-source";
import { ThemeStore } from "./theme-store";
import { ThemeService, type ThemeSummary } from "./theme.service";

/**
 * Installing a theme from the catalog, and composing one here.
 *
 * The path is: read the catalog, download the package, verify its sha512,
 * refuse it unless the lint passes, write it to the data volume, record it.
 * No restart at any point - a theme carries no code, so there is nothing to
 * load into the process (decision 43).
 *
 * A theme composed on the instance joins that path at the lint. It has no
 * catalog entry and no download, so there is nothing to verify a checksum
 * against, and everything from the lint onwards is the same code: a board can
 * no more compose an illegible theme than install one.
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
      /** Composing over a theme this instance installed from a catalog. */
      | "theme-not-composed"
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
        : reason === "housing-cooperative-missing" ||
            reason === "theme-not-composed"
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

/**
 * Where a theme's files came from, as the installed row records it.
 *
 * `catalogId` is the marking that matters: null means nobody published this
 * theme, so it was composed on this instance and the composer may edit it. The
 * audit source is separate from `sourceUrl` because a composed theme's URL
 * names the instance rather than a place a package can be fetched from.
 */
interface ThemeProvenance {
  /** sha512 of the package bytes, hex. */
  checksum: string;
  sourceUrl: string;
  /** The catalog entry this came from. Null marks a composed theme. */
  catalogId: string | null;
  /** What the audit entry names as the source. */
  auditSource: string;
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
    await this.assertHousingCooperativeExists(
      "Create the housing cooperative before installing a theme.",
    );

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

    return this.admit(
      manifest,
      files,
      raw,
      {
        checksum: entry.sha512,
        sourceUrl: entry.url,
        catalogId: entry.id,
        auditSource: entry.url,
      },
      actorPersonId,
    );
  }

  /**
   * Composes a theme on this instance.
   *
   * The composer authors a manifest instead of downloading one, and then takes
   * exactly the same admission as a catalog package: the same lint gate, the
   * same staged write, the same row. That is the point of routing it through
   * `admit` rather than writing a row directly - a board cannot compose a theme
   * that renders the statutory register below WCAG AA any more than they can
   * install one, and there is no second implementation of the gate to drift.
   *
   * No catalog has to be configured. Composing needs no network at all, which
   * is what makes it the answer for an instance that has no catalog to install
   * from.
   *
   * Editing is the same call: the id already installed is composed again at the
   * next patch version. Two administrators composing the same id at once means
   * the later save wins, and the version each of them sees afterwards is what
   * makes that visible.
   */
  async compose(
    input: ComposeThemeInput,
    actorPersonId: string | null,
  ): Promise<ThemeInstallResult> {
    await this.assertHousingCooperativeExists(
      "Create the housing cooperative before composing a theme.",
    );

    const existing = await this.prisma.installedTheme.findUnique({
      where: { id: input.id },
      select: { version: true, catalogId: true },
    });

    /*
     * A theme that came from a catalog is not editable here. Composing over it
     * would replace a package whose bytes match a published checksum with one
     * written on this instance, and the next update from the catalog would take
     * the board's own values away again without anybody having asked it to.
     */
    if (existing !== null && existing.catalogId !== null) {
      throw new ThemeInstallError(
        `The theme ${input.id} came from the catalog and is not composed on this instance.`,
        "theme-not-composed",
      );
    }

    const composed = composedManifest(input, existing?.version ?? null);
    if (!composed.ok) {
      throw new ThemeInstallError(
        `The composed theme ${input.id} does not describe a valid manifest.`,
        "manifest-invalid",
        [],
        composed.issues,
      );
    }

    const { manifest, files, raw } = composed.composed;
    return this.admit(
      manifest,
      files,
      raw,
      {
        checksum: composedChecksum(files),
        sourceUrl: composedSourceUrl(manifest.name),
        catalogId: null,
        auditSource: COMPOSED_AUDIT_SOURCE,
      },
      actorPersonId,
    );
  }

  /**
   * The admission a theme goes through however it was authored.
   *
   * Lint, stage, record, swap - in that order, and the order is the guarantee.
   * A theme that fails the lint never reaches the data volume, and the database
   * transaction is the decider for the two systems that cannot share one: the
   * files move into place as its last step, so anything that refuses the write
   * leaves the version already installed exactly as it was rather than pairing
   * an old row with new files.
   */
  private async admit(
    manifest: ThemeManifest,
    files: ThemeArchiveFiles,
    raw: Readonly<Record<string, unknown>>,
    provenance: ThemeProvenance,
    actorPersonId: string | null,
  ): Promise<ThemeInstallResult> {
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

    const regressions = await this.descendantRegressions(manifest);
    if (regressions.length > 0) {
      throw new ThemeInstallError(
        `The theme ${manifest.name} would leave a theme that inherits from it below the contrast bar.`,
        "lint-failed",
        regressions,
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
          checksum: provenance.checksum,
          sourceUrl: provenance.sourceUrl,
          catalogId: provenance.catalogId,
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
              source: provenance.auditSource,
              checksum: provenance.checksum,
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
      `Installed theme ${manifest.name}@${manifest.version} from ${provenance.sourceUrl}`,
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

  /** Refuses anything that configures an instance nobody has claimed yet. */
  private async assertHousingCooperativeExists(message: string): Promise<void> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    });
    if (association === null) {
      throw new ThemeInstallError(message, "housing-cooperative-missing");
    }
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
  /**
   * Contrast a save would break in the themes that inherit from it.
   *
   * The lint above reads the theme being saved and nothing else, but a theme
   * states only what it changes: a child can override one register colour and
   * inherit the other, so editing the parent can put a pair below the bar in a
   * theme nobody touched. Recomputing the inherited values afterwards writes
   * that state in without ever measuring it, and activation is the only other
   * place contrast is checked - which never runs for a theme that is already
   * active. The statutory register would go unreadable while every screen
   * still reported the theme as installed and valid.
   *
   * Only what the save would *introduce* is refused. A descendant already
   * failing before the edit stays the descendant's problem: blocking an
   * unrelated parent edit on it would leave the parent uneditable with no
   * action its author could take.
   */
  private async descendantRegressions(
    manifest: ThemeManifest,
  ): Promise<ThemeLintFinding[]> {
    const rows = await this.themes.installedRows();
    const others = rows.filter((row) => row.id !== manifest.name);

    const entryOf = (row: (typeof rows)[number]): ThemeChainEntry =>
      ThemeService.chainEntryOf(row);
    const base = new Map<string, ThemeChainEntry>([
      [BUILT_IN_THEME.id, BUILT_IN_THEME],
      ...others.map((row) => [row.id, entryOf(row)] as const),
    ]);

    const installed = rows.find((row) => row.id === manifest.name);
    const before = new Map(base);
    if (installed !== undefined) {
      before.set(installed.id, entryOf(installed));
    }
    const after = new Map(base);
    const candidate = chainEntryFor(manifest);
    after.set(candidate.id, candidate);

    /** The pairs below the bar for one theme under one set of ancestors. */
    const failuresFor = (
      themeId: string,
      lookup: ReadonlyMap<string, ThemeChainEntry>,
    ): Map<
      string,
      { mode: string; finding: ReturnType<typeof checkContrast>[number] }
    > => {
      const out = new Map<
        string,
        { mode: string; finding: ReturnType<typeof checkContrast>[number] }
      >();
      const chain = resolveThemeChain(themeId, (id) => lookup.get(id));
      if (!chain.ok) {
        return out;
      }
      const resolved = resolveChainTokens(chain.chain);
      for (const mode of ["light", "dark"] as const) {
        for (const finding of checkContrast(resolved[mode].tokens)) {
          out.set(`${mode}:${finding.foreground}:${finding.background}`, {
            mode,
            finding,
          });
        }
      }
      return out;
    };

    const findings: ThemeLintFinding[] = [];
    for (const row of others) {
      const chain = resolveThemeChain(row.id, (id) => after.get(id));
      if (!chain.ok) {
        continue;
      }
      // Only themes that actually inherit from the one being saved.
      if (!chain.chain.some((entry) => entry.id === manifest.name)) {
        continue;
      }

      const was = failuresFor(row.id, before);
      for (const [key, { mode, finding }] of failuresFor(row.id, after)) {
        if (was.has(key)) {
          continue;
        }
        findings.push({
          rule: "contrast",
          severity: "error",
          detail: {
            theme: row.id,
            mode,
            foreground: finding.foreground,
            background: finding.background,
            ratio: finding.ratio ?? -1,
            required: finding.required,
            statutory: finding.statutory,
          },
        });
      }
    }

    return findings;
  }

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
