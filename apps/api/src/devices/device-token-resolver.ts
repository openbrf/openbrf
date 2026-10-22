import { Injectable } from "@nestjs/common";
import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";

import { hashOpaqueToken } from "../auth/opaque-token";
import { PrismaService } from "../database/prisma.service";
import type { DeviceRoute } from "./device-routes";
import { deviceTokenSummary, LAST_USED_INTERVAL_MS } from "./device-token";

/**
 * Finds the token a device presented, for the authorization guard.
 *
 * The whole of what the guard needs and nothing more, so the guard's injector
 * holds no way to issue or revoke. Provided in the authorization module, which
 * imports nothing, and exported from nowhere: a plugin cannot ask for it.
 *
 * Looked up by digest on every call, with nothing cached, so the call after a
 * revocation is refused.
 */
@Injectable()
export class DeviceTokenResolver {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The live token presented for `route`, or null.
   *
   * Null for a token that is unknown, revoked, or issued for another plugin or
   * another of its routes, so the caller answers every case alike.
   */
  async resolve(
    token: string,
    route: DeviceRoute,
    now: Date = new Date(),
  ): Promise<DeviceTokenSummary | null> {
    const row = await this.prisma.pluginDeviceToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
    });
    if (
      row === null ||
      row.revokedAt !== null ||
      row.pluginId !== route.pluginId ||
      row.routeId !== route.routeId
    ) {
      return null;
    }

    const stale = new Date(now.getTime() - LAST_USED_INTERVAL_MS);
    if (row.lastUsedAt === null || row.lastUsedAt < stale) {
      /*
       * Conditional on the same staleness, so two calls racing past the read
       * above write once between them, and on the token still being live, so a
       * revocation in between is not followed by a "last used" after it.
       */
      await this.prisma.pluginDeviceToken.updateMany({
        where: {
          id: row.id,
          revokedAt: null,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: stale } }],
        },
        data: { lastUsedAt: now },
      });
      return deviceTokenSummary({ ...row, lastUsedAt: now });
    }
    return deviceTokenSummary(row);
  }
}
