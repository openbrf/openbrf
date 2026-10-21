import { Injectable } from "@nestjs/common";
import {
  type EntitlementState,
  type PluginManifest,
  undeclaredAudienceError,
} from "@openbrf/plugin-sdk";
import { formatLocalDay, localDayOf } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import {
  declaredKeys,
  type EntitlementJudgement,
  judgeEntitlement,
  type LicenceReader,
} from "./entitlement-judgement";
import { InstanceIdentityService } from "./instance-identity.service";
import { writePresentation } from "./licence-file";

/**
 * What `host.entitlements` answers a licensed plugin, read from the licences
 * entered and judged on every call (ADR 0042).
 *
 * Verifying makes no network call, and nothing here reports a licence or its
 * use to anybody: `present()` signs, and only the plugin that asked sends the
 * result, to an audience its manifest declares.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: InstanceIdentityService,
  ) {}

  /** The finding for a licensed plugin's entitlement today. */
  async judge(
    reader: LicenceReader,
    now: Date = new Date(),
  ): Promise<EntitlementJudgement> {
    const fingerprints = declaredKeys(reader.licence).map(
      (declared) => declared.fingerprint,
    );
    const [licences, instance] = await Promise.all([
      this.prisma.licence.findMany({
        where: { verifiedKeyFingerprint: { in: fingerprints } },
        select: {
          id: true,
          file: true,
          enteredAt: true,
          verifiedKeyFingerprint: true,
          entitlements: true,
        },
      }),
      this.identity.binding(),
    ]);
    return judgeEntitlement({
      licences,
      reader,
      instance,
      today: formatLocalDay(localDayOf(now)),
    });
  }

  async get(reader: LicenceReader): Promise<EntitlementState> {
    return (await this.judge(reader)).state;
  }

  /**
   * The selected active licence, presented to `audience` with the instance's
   * signature, or null without an active licence. The licence id comes from
   * the licence and the entitlement from the manifest, so a plugin presents
   * only the entitlement it declares, even from a file that carries several.
   */
  async present(
    reader: LicenceReader,
    audience: string,
  ): Promise<string | null> {
    if (!reader.licence.audiences.includes(audience)) {
      throw undeclaredAudienceError();
    }
    const now = new Date();
    const { selected } = await this.judge(reader, now);
    if (selected === null) {
      return null;
    }
    return writePresentation(
      {
        file: selected.licence.file,
        audience,
        licenceId: selected.payload.licenceId,
        entitlement: reader.licence.entitlement,
        now,
      },
      (message) => this.identity.sign(message),
    );
  }
}

/** The licence reader a manifest describes, or null for an unlicensed plugin. */
export function licenceReaderOf(
  manifest: PluginManifest,
): LicenceReader | null {
  if (manifest.licence === undefined || manifest.released === undefined) {
    return null;
  }
  return { licence: manifest.licence, released: manifest.released };
}
