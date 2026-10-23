import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type {
  EntitlementState,
  PluginLicenceDeclaration,
  PluginManifest,
} from "@openbrf/plugin-sdk";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { processRole } from "../config/process-role";
import { PrismaService } from "../database/prisma.service";
import { isUniqueViolation } from "../database/unique-violation";
import type { Prisma } from "../generated/prisma/client";
import type { AuditChannel } from "../generated/prisma/enums";
import { dataPaths } from "../packaging/data-paths";
import {
  isConsentedPackage,
  pluginModulesDirectory,
  scanPluginDirectory,
} from "../plugins/plugin-directory";
import { keysRefused, licenceRefusal } from "../plugins/plugin-licence-gate";
import { PluginLoaderService } from "../plugins/plugin-loader.service";
import { consentedLicenceOf } from "../plugins/plugin-registry.service";
import { declaredKeys } from "./entitlement-judgement";
import { EntitlementsService, licenceReaderOf } from "./entitlements.service";
import { InstanceIdentityService } from "./instance-identity.service";
import {
  fileSha256,
  type LicencePayload,
  readLicenceEnvelope,
  readLicencePayload,
  verifiedPayload,
  verifyLicenceSignature,
} from "./licence-file";
import { LicenceNotFoundError, LicenceRefusedError } from "./licence.errors";

/** The most licences an instance keeps. */
export const MAX_LICENCES = 50;

/**
 * Whether a key still verifies a stored licence.
 *
 * - `verified`: a key an installed plugin declares verified it just now.
 * - `not-yet-checked`: no installed plugin declares its key id.
 * - `tampered`: the key that verified it when it was entered no longer does.
 * - `issuer-not-installed`: it was checked, and no installed plugin declares
 *   that key any more, so what it says cannot be shown as a fact.
 */
export type LicenceCheck =
  "verified" | "not-yet-checked" | "tampered" | "issuer-not-installed";

export interface LicenceView {
  id: string;
  sha256: string;
  keyId: string;
  enteredAt: string;
  check: LicenceCheck;
  /** What was recorded when a key verified it; null while not yet checked. */
  licenceId: string | null;
  /** The payload, shown only while a key verifies it now. */
  verified: {
    issuedOn: string;
    instanceId: string;
    instanceKey: string;
    association: { name: string; organizationNumber: string | null };
    entitlements: {
      name: string;
      validUntil: string | null;
      updatesUntil: string | null;
    }[];
    /** The issuer as the verifying plugin's manifest names it. */
    issuer: { name: string; url: string };
    pluginId: string;
  } | null;
}

export interface LicensedPluginView {
  pluginId: string;
  entitlement: string;
  issuer: { name: string; url: string };
  state: EntitlementState;
}

export interface LicencesOverview {
  /**
   * What the board copies into an order: the id and the public key. And
   * whether the private key can be read, without which no licence can be
   * presented to an issuer's service.
   */
  instance: { instanceId: string; instanceKey: string; keyReadable: boolean };
  licences: LicenceView[];
  plugins: LicensedPluginView[];
}

export interface LicenceActor {
  personId: string | null;
  channel: AuditChannel;
}

/** A key an installed plugin declares, with the plugin that declares it. */
interface InstalledKey {
  pluginId: string;
  keyId: string;
  fingerprint: string;
  key: ReturnType<typeof declaredKeys>[number]["key"];
  licence: PluginLicenceDeclaration;
}

/**
 * The licence screen and the command-line tool's licences (ADR 0042):
 * entering a file, listing what is entered, removing one, and checking a file
 * that no installed plugin could check when it was entered.
 *
 * A file is tried against every installed plugin's key with its key id. One
 * that verifies is stored as checked, with the fingerprint of the key; one no
 * key verifies where keys with its id are declared is refused; one whose key
 * id no installed plugin declares is stored not yet checked, as opaque bytes,
 * so the board can enter a licence before installing the module.
 */
@Injectable()
export class LicenceAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LicenceAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly identity: InstanceIdentityService,
    private readonly entitlements: EntitlementsService,
    private readonly loader: PluginLoaderService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Creates the instance's identity at its first start, and checks the files
   * a plugin installed or updated since can now check: installing one ends
   * by replacing the process, so this is the moment a new key arrives. A
   * failure of that check is logged and does not stop the start.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (processRole() === "cli") {
      return;
    }
    await this.identity.binding();
    try {
      await this.checkPending({ personId: null, channel: "SYSTEM" });
    } catch (cause) {
      // A licence is never a reason for the core to refuse to start (ADR
      // 0042). Files already checked stay checked, and the rest are tried
      // again at the next start.
      this.logger.error(
        `Checking pending licences failed (${cause instanceof Error ? cause.name : "unknown"}).`,
      );
    }
  }

  async overview(): Promise<LicencesOverview> {
    // Read once: from a terminal it is a database query and a scan of the
    // volume, and the keys and the plugins listed are to come from one reading.
    const [binding, keyReadable, rows, manifests] = await Promise.all([
      this.identity.binding(),
      this.identity.keyReadable(),
      this.prisma.licence.findMany({ orderBy: [{ enteredAt: "desc" }] }),
      this.installedManifests(),
    ]);
    const byFingerprint = new Map(
      keysOf(manifests).map((key) => [key.fingerprint, key]),
    );

    const licences = rows.map((row) => viewOf(row, byFingerprint));

    const plugins: LicensedPluginView[] = [];
    for (const manifest of manifests) {
      const reader = licenceReaderOf(manifest);
      if (reader === null) {
        continue;
      }
      plugins.push({
        pluginId: manifest.id,
        entitlement: reader.licence.entitlement,
        issuer: reader.licence.issuer,
        state: (await this.entitlements.judge(reader)).state,
      });
    }

    return { instance: { ...binding, keyReadable }, licences, plugins };
  }

  /** Enters a licence file, or refuses it with the reason. */
  async enter(file: Uint8Array, actor: LicenceActor): Promise<LicenceView> {
    const read = readLicenceEnvelope(file);
    if (!read.ok) {
      throw new LicenceRefusedError(read.reason);
    }
    const { envelope } = read;
    const sha256 = fileSha256(file);

    const candidates = keysOf(await this.installedManifests()).filter(
      (key) => key.keyId === envelope.keyId,
    );
    let checked: { key: InstalledKey; payload: LicencePayload } | null = null;
    for (const key of candidates) {
      if (!verifyLicenceSignature(envelope, key.key)) {
        continue;
      }
      const payload = readLicencePayload(envelope.payload);
      if (payload === null) {
        throw new LicenceRefusedError("not-a-licence");
      }
      checked = { key, payload };
      break;
    }
    if (candidates.length > 0 && checked === null) {
      throw new LicenceRefusedError("signature-invalid");
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // Counted under the lock and in the transaction that inserts, so two
        // files entered at once at 49 cannot both pass the count.
        await lockLicenceStore(tx);
        if ((await tx.licence.count()) >= MAX_LICENCES) {
          throw new LicenceRefusedError("limit-reached");
        }
        const created = await tx.licence.create({
          data: {
            file: Uint8Array.from(file),
            sha256,
            keyId: envelope.keyId,
            ...(checked === null
              ? {}
              : {
                  verifiedKeyFingerprint: checked.key.fingerprint,
                  verifiedAt: new Date(),
                  licenceId: checked.payload.licenceId,
                  entitlements: Object.keys(checked.payload.entitlements),
                }),
          },
        });
        await this.audit.record(
          {
            action: "LICENCE_ADDED",
            channel: actor.channel,
            actorPersonId: actor.personId,
            targetKind: "licence",
            targetId: created.id,
            context: {
              sha256,
              keyId: envelope.keyId,
              verified: checked !== null,
            },
          },
          tx,
        );
        if (checked !== null) {
          await this.recordVerified(created.id, checked, actor, tx);
        }
        return created;
      });
      this.logger.log(
        `Licence ${sha256} entered, ${checked === null ? "not yet checked" : `verified by a key of "${checked.key.pluginId}"`}.`,
      );
      return viewOf(
        row,
        new Map(
          checked === null ? [] : [[checked.key.fingerprint, checked.key]],
        ),
      );
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new LicenceRefusedError("already-entered");
      }
      throw cause;
    }
  }

  async remove(id: string, actor: LicenceActor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.licence.findUnique({
        where: { id },
        select: { id: true, sha256: true, licenceId: true },
      });
      // Counted rather than assumed: a second removal racing this one finds
      // the row gone and says so, rather than failing on a missing row.
      const { count } = await tx.licence.deleteMany({ where: { id } });
      if (row === null || count === 0) {
        throw new LicenceNotFoundError();
      }
      await this.audit.record(
        {
          action: "LICENCE_REMOVED",
          channel: actor.channel,
          actorPersonId: actor.personId,
          targetKind: "licence",
          targetId: row.id,
          context: {
            sha256: row.sha256,
            ...(row.licenceId === null ? {} : { licenceId: row.licenceId }),
          },
        },
        tx,
      );
    });
  }

  /**
   * Tries each file not yet checked against the keys installed now. A file
   * that does not verify stays not yet checked: it may be meant for a plugin
   * still to come.
   */
  async checkPending(actor: LicenceActor): Promise<number> {
    const pending = await this.prisma.licence.findMany({
      where: { verifiedKeyFingerprint: null },
    });
    if (pending.length === 0) {
      return 0;
    }
    const keys = keysOf(await this.installedManifests());
    let verified = 0;
    for (const row of pending) {
      const read = readLicenceEnvelope(row.file);
      if (!read.ok) {
        continue;
      }
      for (const key of keys) {
        if (
          key.keyId !== read.envelope.keyId ||
          !verifyLicenceSignature(read.envelope, key.key)
        ) {
          continue;
        }
        const payload = readLicencePayload(read.envelope.payload);
        if (payload === null) {
          break;
        }
        const checked = { key, payload };
        const updated = await this.prisma.$transaction(async (tx) => {
          // Conditional on the row still being unchecked, so two processes
          // starting at once record one verification between them.
          const { count } = await tx.licence.updateMany({
            where: { id: row.id, verifiedKeyFingerprint: null },
            data: {
              verifiedKeyFingerprint: key.fingerprint,
              verifiedAt: new Date(),
              licenceId: payload.licenceId,
              entitlements: Object.keys(payload.entitlements),
            },
          });
          if (count === 1) {
            await this.recordVerified(row.id, checked, actor, tx);
          }
          return count === 1;
        });
        if (updated) {
          verified += 1;
          this.logger.log(
            `Licence ${row.sha256} verified by a key of "${key.pluginId}".`,
          );
        }
        break;
      }
    }
    return verified;
  }

  private async recordVerified(
    id: string,
    checked: { key: InstalledKey; payload: LicencePayload },
    actor: LicenceActor,
    tx: Parameters<AuditLogService["record"]>[1],
  ): Promise<void> {
    await this.audit.record(
      {
        action: "LICENCE_VERIFIED",
        channel: actor.channel,
        actorPersonId: actor.personId,
        targetKind: "licence",
        targetId: id,
        context: {
          licenceId: checked.payload.licenceId,
          pluginId: checked.key.pluginId,
          issuer: checked.key.licence.issuer.name,
          entitlements: entitlementDates(checked.payload),
        },
      },
      tx,
    );
  }

  /**
   * The installed plugins' manifests. The server knows them from its boot;
   * the command-line tool executes no plugin, so it reads the manifests from
   * the packages on the volume, which runs none of their code.
   *
   * Only a package the board consented to counts, by the boot's own test
   * (`isConsentedPackage`): a record under its id, for that package name and
   * version, at the directory npm installs it to. The boot keeps no manifest
   * for any other package on the volume, so from a terminal as from the
   * screen its key verifies nothing. Nor does a package the boot refuses over
   * the issuer or keys of its licence (`keysRefused`), for it keeps no
   * manifest either. One refused over its audiences alone stays, as the boot
   * keeps it dormant.
   */
  private async installedManifests(): Promise<PluginManifest[]> {
    if (processRole() !== "cli") {
      return this.loader.installedManifests();
    }
    if (!this.env.OPENBRF_PLUGINS_ENABLED) {
      return [];
    }
    const root = dataPaths(this.env.OPENBRF_DATA_DIR).plugins;
    const modules = pluginModulesDirectory(root);
    const records = new Map(
      (await this.prisma.installedPlugin.findMany()).map((record) => [
        record.id,
        record,
      ]),
    );
    const scan = await scanPluginDirectory(root);
    return scan.plugins
      .filter((plugin) => {
        const record = records.get(plugin.id);
        if (
          record === undefined ||
          !isConsentedPackage(plugin, record, modules)
        ) {
          return false;
        }
        const consentedLicence = consentedLicenceOf(record);
        const refusal = licenceRefusal(
          plugin.manifest.licence,
          consentedLicence,
        );
        return refusal === null || !keysRefused(refusal, consentedLicence);
      })
      .map((plugin) => plugin.manifest);
  }
}

/**
 * Every key the given plugins declare, in their order. Two plugins declaring
 * one key id with different keys are two entries, and each licence verifies
 * under its own.
 */
function keysOf(manifests: readonly PluginManifest[]): InstalledKey[] {
  const keys: InstalledKey[] = [];
  for (const manifest of manifests) {
    if (manifest.licence === undefined) {
      continue;
    }
    for (const declared of declaredKeys(manifest.licence)) {
      keys.push({
        pluginId: manifest.id,
        ...declared,
        licence: manifest.licence,
      });
    }
  }
  return keys;
}

/**
 * The lock a transaction takes before it counts the licences stored, when it
 * is about to add one.
 *
 * At READ COMMITTED two transactions counting at once both see 49 and both
 * insert, and the store holds 51. A row lock has nothing to lock while the
 * count is below the limit, so an advisory lock, taken for the transaction so
 * the commit or the rollback releases it. It orders the server and the
 * command-line tool alike, which are separate processes.
 */
async function lockLicenceStore(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"licence-store"}))`;
}

/** A stored licence as the licence screen shows it. */
function viewOf(
  row: {
    id: string;
    file: Uint8Array;
    sha256: string;
    keyId: string;
    enteredAt: Date;
    verifiedKeyFingerprint: string | null;
    licenceId: string | null;
  },
  keysByFingerprint: ReadonlyMap<string, InstalledKey>,
): LicenceView {
  const base = {
    id: row.id,
    sha256: row.sha256,
    keyId: row.keyId,
    enteredAt: row.enteredAt.toISOString(),
    licenceId: row.licenceId,
  };
  if (row.verifiedKeyFingerprint === null) {
    return { ...base, check: "not-yet-checked", verified: null };
  }
  const key = keysByFingerprint.get(row.verifiedKeyFingerprint);
  if (key === undefined) {
    return { ...base, check: "issuer-not-installed", verified: null };
  }
  const payload = verifiedPayload(row.file, key.key);
  if (payload === null) {
    return { ...base, check: "tampered", verified: null };
  }
  return {
    ...base,
    check: "verified",
    verified: {
      issuedOn: payload.issuedOn,
      instanceId: payload.instanceId,
      instanceKey: payload.instanceKey,
      association: {
        name: payload.association.name,
        organizationNumber: payload.association.organizationNumber ?? null,
      },
      entitlements: entitlementDates(payload),
      issuer: key.licence.issuer,
      pluginId: key.pluginId,
    },
  };
}

function entitlementDates(payload: LicencePayload): {
  name: string;
  validUntil: string | null;
  updatesUntil: string | null;
}[] {
  return Object.entries(payload.entitlements)
    .map(([name, dates]) => ({
      name,
      validUntil: dates.validUntil ?? null,
      updatesUntil: dates.updatesUntil ?? null,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}
