import { Injectable } from "@nestjs/common";
import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";

import { PrismaService } from "../database/prisma.service";
import type { InstalledPlugin, Prisma } from "../generated/prisma/client";
import type { InstalledPluginStatus } from "../generated/prisma/enums";

/**
 * The desired state of this instance's plugins.
 *
 * These rows are the source of truth and /data/plugins is reconciled to them,
 * never the other way round. Everything that makes the install flow idempotent
 * follows from that one direction: the installer rebuilds the entire
 * dependency set from these rows, so a crash at any step converges on the next
 * run, and a removal is a deleted row rather than a sequence of filesystem
 * operations that could half-happen.
 */

export interface PluginRecord {
  id: string;
  packageName: string;
  version: string;
  tarballUrl: string;
  checksum: string;
  enabled: boolean;
  status: InstalledPluginStatus;
  lastError: string | null;
  consentedPermissions: PluginPermission[];
  declaredPersonalData: PluginPersonalDataCategory[];
  settings: Record<string, unknown>;
  installedAt: Date;
}

export interface PluginConsent {
  id: string;
  packageName: string;
  version: string;
  tarballUrl: string;
  checksum: string;
  permissions: readonly PluginPermission[];
  personalData: readonly PluginPersonalDataCategory[];
}

@Injectable()
export class PluginRegistryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<PluginRecord[]> {
    const rows = await this.prisma.installedPlugin.findMany({
      orderBy: { id: "asc" },
    });
    return rows.map(toRecord);
  }

  async find(id: string): Promise<PluginRecord | null> {
    const row = await this.prisma.installedPlugin.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  /**
   * Records the board's consent, which is what an install is.
   *
   * An upsert rather than a create, so re-installing the same plugin at a new
   * version is one operation and re-running a failed install is another. The
   * consent snapshot is overwritten on purpose: a new version whose
   * permissions changed went through the consent screen again to get here.
   */
  async consent(input: PluginConsent): Promise<PluginRecord> {
    const shared = {
      packageName: input.packageName,
      version: input.version,
      tarballUrl: input.tarballUrl,
      checksum: input.checksum,
      consentedPermissions: [...input.permissions],
      declaredPersonalData: [...input.personalData],
      status: "PENDING" as const,
      lastError: null,
    };

    const row = await this.prisma.installedPlugin.upsert({
      where: { id: input.id },
      create: { id: input.id, enabled: true, settings: {}, ...shared },
      update: shared,
    });
    return toRecord(row);
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.prisma.installedPlugin.deleteMany({
      where: { id },
    });
    return removed.count > 0;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginRecord | null> {
    const rows = await this.prisma.installedPlugin.updateManyAndReturn({
      where: { id },
      data: { enabled },
    });
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Called by the installer once the package is on the data volume. */
  async markInstalled(id: string): Promise<void> {
    await this.prisma.installedPlugin.updateMany({
      where: { id },
      data: { status: "INSTALLED", lastError: null },
    });
  }

  /**
   * Records why an install did not converge.
   *
   * The row stays. A failed install that vanished would leave a board with no
   * way to see what happened, and no way to retry or withdraw it.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.installedPlugin.updateMany({
      where: { id },
      data: { status: "FAILED", lastError: error.slice(0, 2000) },
    });
  }

  async writeSettings(
    id: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.installedPlugin.updateMany({
      where: { id },
      // Cast at the persistence boundary: the values are already validated
      // against the plugin's settingsSchema, and Prisma types a JSON column
      // with its own recursive InputJsonValue that a plain Record does not
      // satisfy.
      data: { settings: settings as Prisma.InputJsonObject },
    });
  }
}

function toRecord(row: InstalledPlugin): PluginRecord {
  return {
    id: row.id,
    packageName: row.packageName,
    version: row.version,
    tarballUrl: row.tarballUrl,
    checksum: row.checksum,
    enabled: row.enabled,
    status: row.status,
    lastError: row.lastError,
    // Stored as plain string arrays: the database does not need to know the
    // permission set, and a permission that no longer exists must read back as
    // an unknown string the loader can refuse rather than a failed decode.
    consentedPermissions: row.consentedPermissions as PluginPermission[],
    declaredPersonalData:
      row.declaredPersonalData as PluginPersonalDataCategory[],
    settings:
      typeof row.settings === "object" &&
      row.settings !== null &&
      !Array.isArray(row.settings)
        ? (row.settings as Record<string, unknown>)
        : {},
    installedAt: row.installedAt,
  };
}
