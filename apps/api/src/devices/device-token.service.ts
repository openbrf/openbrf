import { Injectable } from "@nestjs/common";
import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";

import { authenticatedFacts } from "../actions/authenticated-request";
import {
  type AuditDbClient,
  AuditLogService,
} from "../audit/audit-log.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import { PrincipalService } from "../authorization/principal.service";
import { PrismaService } from "../database/prisma.service";
import type { AuditChannel } from "../generated/prisma/enums";
import { DISPLAY_ROUTE_ID } from "./device-routes";
import {
  DEVICE_LABEL_MAX_LENGTH,
  DEVICE_SUBJECT_PATTERN,
  deviceTokenSummary,
  MAX_LIVE_DEVICE_TOKENS,
  mintDeviceToken,
} from "./device-token";
import {
  DeviceLabelInvalidError,
  DeviceTokenIssueRefusedError,
  DeviceTokenLimitError,
} from "./device-token.errors";

/**
 * The subject of every token for the core's display route. A plugin names its
 * devices so that a route handler can tell them apart; the display route needs
 * no such handle, and the document it serves names the token by its id.
 */
const DISPLAY_SUBJECT = "display";

/** A live token as the board's devices screen lists it. */
export interface LiveDeviceToken extends DeviceTokenSummary {
  /** The plugin it is for, or null for the core's display route. */
  pluginId: string | null;
  /** Who issued it, by name, or null for a person no longer in the register. */
  issuedBy: { personId: string; name: string } | null;
}

/**
 * Issuing, listing and revoking device tokens (ADRs 0031 and 0050).
 *
 * Three callers with different reach. A plugin, through `host.devices`,
 * reaches its own tokens only, and issues one only on a board member's
 * request; the core's display screen issues tokens for the core's display
 * route, which have no plugin; and the board, through the core's devices
 * screen, reaches every live token on the instance, so that cutting a device
 * never depends on the plugin's own screen being right.
 *
 * Not in a global module, and denied to a plugin's own module by the seal: a
 * plugin holding this would issue and revoke without its identity or the
 * board's act attached.
 */
@Injectable()
export class DeviceTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly principals: PrincipalService,
  ) {}

  /**
   * Issues a token for one of a plugin's declared device routes.
   *
   * The request is the one the plugin's own route received, and the person is
   * read from the mark the guard put on it, as `host.actions` reads it. It has
   * to have come through the web interface - a session, not a connected app's
   * token - from a person who holds `site:manage` now, which is read again
   * here rather than taken from what the guard established at the start of
   * the request.
   */
  async issue(
    pluginId: string,
    declaredRoutes: readonly string[],
    request: object,
    options: { route: string; subject: string; label: string },
  ): Promise<{ token: string; device: DeviceTokenSummary }> {
    if (!declaredRoutes.includes(options.route)) {
      throw new RangeError(
        `Plugin "${pluginId}" asked for a device token for a route its manifest does not declare.`,
      );
    }
    if (!DEVICE_SUBJECT_PATTERN.test(options.subject)) {
      throw new RangeError(
        `Plugin "${pluginId}" named a device with a subject outside 1-64 letters, digits, '.', '_', ':' or '-'.`,
      );
    }
    const label = deviceLabel(options.label);
    if (label === null) {
      throw new RangeError(
        `Plugin "${pluginId}" gave a device a label that is empty or longer than ${String(DEVICE_LABEL_MAX_LENGTH)} characters.`,
      );
    }

    const personId = await this.boardMember(request);

    return await this.create({
      pluginId,
      routeId: options.route,
      subject: options.subject,
      label,
      personId,
      // A plugin's own route serving a board member's session: the plugin
      // wrote it, and the person asked for it.
      channel: "PLUGIN",
    });
  }

  /**
   * Issues a token for the core's display route (ADR 0050), from the core's
   * display screen.
   *
   * The controller is under `site:manage` and takes the board member's
   * session, so the person is the one the guard established; a label that is
   * empty or too long is the board's to correct, and refused as such.
   */
  async issueForDisplay(
    personId: string,
    label: string,
  ): Promise<{ token: string; device: DeviceTokenSummary }> {
    const trimmed = deviceLabel(label);
    if (trimmed === null) {
      throw new DeviceLabelInvalidError(DEVICE_LABEL_MAX_LENGTH);
    }
    return await this.create({
      pluginId: null,
      routeId: DISPLAY_ROUTE_ID,
      subject: DISPLAY_SUBJECT,
      label: trimmed,
      personId,
      channel: "WEB",
    });
  }

  /**
   * Inserts a token and records it, together, within the live limit of its
   * plugin or of the display route.
   */
  private async create(options: {
    pluginId: string | null;
    routeId: string;
    subject: string;
    label: string;
    personId: string;
    channel: AuditChannel;
  }): Promise<{ token: string; device: DeviceTokenSummary }> {
    const { pluginId } = options;
    const token = mintDeviceToken();
    const row = await this.prisma.$transaction(async (tx) => {
      /*
       * Counted in the transaction that inserts, behind a lock per plugin. At
       * READ COMMITTED two issues at 199 would both count 199 and both insert;
       * ordered by the lock, the second counts what the first inserted. An
       * advisory lock rather than a row lock on the plugin's row, which the
       * admin's own writes to it would then queue behind. Released by the
       * commit or the rollback. The display route's tokens count on a lock of
       * their own: no plugin id can be `:display`, which is not one.
       */
      const holder = pluginId ?? `:${DISPLAY_ROUTE_ID}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device-tokens:${holder}`}))`;
      const live = await tx.pluginDeviceToken.count({
        where: { pluginId, revokedAt: null },
      });
      if (live >= MAX_LIVE_DEVICE_TOKENS) {
        throw new DeviceTokenLimitError(MAX_LIVE_DEVICE_TOKENS);
      }
      const created = await tx.pluginDeviceToken.create({
        data: {
          pluginId,
          routeId: options.routeId,
          subject: options.subject,
          label: options.label,
          tokenHash: hashOpaqueToken(token),
          issuedByPersonId: options.personId,
        },
      });
      await this.audit.record(
        {
          action: "DEVICE_TOKEN_ISSUED",
          channel: options.channel,
          actorPersonId: options.personId,
          // The plugin the host served, from its manifest (ADR 0038); none on
          // the core's display screen.
          pluginId,
          targetKind: "device-token",
          targetId: created.id,
          // Never the token or its digest, and never the label, which is the
          // board's own text on a row that outlives no plugin (rule 3 on the
          // audit log).
          context: {
            plugin: pluginId,
            route: options.routeId,
            subject: options.subject,
          },
        },
        tx,
      );
      return created;
    });

    return { token, device: deviceTokenSummary(row) };
  }

  /** A plugin's own tokens, newest first, revoked ones included. */
  async list(
    pluginId: string,
    filter: { route?: string; subject?: string } = {},
  ): Promise<DeviceTokenSummary[]> {
    const rows = await this.prisma.pluginDeviceToken.findMany({
      where: {
        pluginId,
        ...(filter.route === undefined ? {} : { routeId: filter.route }),
        ...(filter.subject === undefined ? {} : { subject: filter.subject }),
      },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    });
    return rows.map(deviceTokenSummary);
  }

  /**
   * Revokes one of a plugin's own tokens. True when it was live.
   *
   * With the request when a person asked for it, so the entry names them;
   * without, the entry is the plugin's own, with no actor.
   */
  async revokeForPlugin(
    pluginId: string,
    tokenId: string,
    request?: object,
  ): Promise<boolean> {
    let actorPersonId: string | null = null;
    if (request !== undefined) {
      const marked = personOf(request);
      if (marked === null) {
        // Passing a request says a person asked; one core did not put
        // together names nobody, and must not be recorded as the plugin's.
        throw new Error("This is not a request the platform authenticated.");
      }
      actorPersonId = marked.personId;
    }
    return await this.revoke(
      { id: tokenId, pluginId },
      actorPersonId,
      "PLUGIN",
    );
  }

  /** Every live token on the instance, for the board's devices screen. */
  async listLive(): Promise<LiveDeviceToken[]> {
    const rows = await this.prisma.pluginDeviceToken.findMany({
      where: { revokedAt: null },
      orderBy: [{ pluginId: "asc" }, { issuedAt: "desc" }, { id: "desc" }],
    });
    const people = await this.prisma.person.findMany({
      where: {
        id: { in: [...new Set(rows.map((row) => row.issuedByPersonId))] },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    const names = new Map(
      people.map((person) => [
        person.id,
        `${person.firstName} ${person.lastName}`.trim(),
      ]),
    );
    return rows.map((row) => {
      const name = names.get(row.issuedByPersonId);
      return {
        ...deviceTokenSummary(row),
        pluginId: row.pluginId,
        issuedBy:
          name === undefined ? null : { personId: row.issuedByPersonId, name },
      };
    });
  }

  /** Revokes any token on the instance, from the board's devices screen. */
  async revokeForBoard(
    tokenId: string,
    actorPersonId: string,
  ): Promise<boolean> {
    return await this.revoke({ id: tokenId }, actorPersonId, "WEB");
  }

  /**
   * Revokes the live tokens of the routes a republished version no longer
   * declares, in the transaction that records the board's consent to it.
   *
   * One conditional update, and an entry for each row it changed, so of two
   * callers racing - two processes starting at once - only one records a
   * token, as with {@link revoke}.
   */
  async revokeDroppedRoutes(
    pluginId: string,
    keptRoutes: readonly string[],
    actorPersonId: string | null,
    channel: AuditChannel,
    tx: AuditDbClient,
  ): Promise<number> {
    const dropped = await tx.pluginDeviceToken.updateManyAndReturn({
      where: { pluginId, revokedAt: null, routeId: { notIn: [...keptRoutes] } },
      data: { revokedAt: new Date(), revokedByPersonId: actorPersonId },
      select: { id: true, routeId: true, subject: true },
    });
    for (const row of dropped) {
      await this.audit.record(
        {
          action: "DEVICE_TOKEN_REVOKED",
          channel,
          actorPersonId,
          targetKind: "device-token",
          targetId: row.id,
          context: {
            plugin: pluginId,
            route: row.routeId,
            subject: row.subject,
            routeDropped: true,
          },
        },
        tx,
      );
    }
    return dropped.length;
  }

  /**
   * Revokes the live tokens of the routes a serving plugin's manifest does not
   * declare, for a version that started serving without the board consenting
   * to it - one republished under the version number the board agreed to.
   *
   * The system's act rather than a person's: nobody asked, and the entries
   * say so on the `SYSTEM` channel with no actor.
   */
  async revokeUndeclaredRoutes(
    pluginId: string,
    declaredRoutes: readonly string[],
  ): Promise<number> {
    return await this.prisma.$transaction(
      async (tx) =>
        await this.revokeDroppedRoutes(
          pluginId,
          declaredRoutes,
          null,
          "SYSTEM",
          tx,
        ),
    );
  }

  /**
   * Revokes one token, and records it, together. True when it was live.
   *
   * A conditional update, so of two revocations racing only one is recorded,
   * and one of a token that is already revoked changes nothing.
   */
  private async revoke(
    where: { id: string; pluginId?: string },
    actorPersonId: string | null,
    channel: AuditChannel,
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.pluginDeviceToken.updateManyAndReturn({
        where: { ...where, revokedAt: null },
        data: { revokedAt: new Date(), revokedByPersonId: actorPersonId },
      });
      const row = rows[0];
      if (row === undefined) {
        return false;
      }
      await this.audit.record(
        {
          action: "DEVICE_TOKEN_REVOKED",
          channel,
          actorPersonId,
          // Named only when the plugin revoked it (ADR 0038): the board's
          // revocation from its devices screen is not the plugin's act.
          pluginId: channel === "PLUGIN" ? row.pluginId : null,
          targetKind: "device-token",
          targetId: row.id,
          context: {
            plugin: row.pluginId,
            route: row.routeId,
            subject: row.subject,
          },
        },
        tx,
      );
      return true;
    });
  }

  /**
   * The person a board member's request in the web interface names, if they
   * may issue a token now.
   */
  private async boardMember(request: object): Promise<string> {
    const marked = personOf(request);
    // A connected app's token is a person's, but not the board's act in the
    // board's own interface, which is what issuing is.
    if (marked === null || marked.viaToken) {
      throw new DeviceTokenIssueRefusedError();
    }
    const principal = await this.principals.forPerson(marked.personId);
    if (principal === null || !principal.capabilities.has("site:manage")) {
      throw new DeviceTokenIssueRefusedError();
    }
    return marked.personId;
  }
}

/** A label the board gave a device, trimmed, or null when it may not be. */
function deviceLabel(label: string): string | null {
  const trimmed = label.trim();
  return trimmed === "" || trimmed.length > DEVICE_LABEL_MAX_LENGTH
    ? null
    : trimmed;
}

/**
 * The person core established on a request, or null for a request core did
 * not authenticate - a device's included, which carries no person.
 *
 * Read from what the guard recorded, never from `request.principal` or
 * `request.token`: a plugin holds the real request and can write both, which
 * would otherwise let it issue as a board member who never asked, or drop the
 * token that marks a connected app's request.
 */
function personOf(
  request: object,
): { personId: string; viaToken: boolean } | null {
  const facts = authenticatedFacts(request);
  if (facts === undefined) {
    return null;
  }
  return { personId: facts.personId, viaToken: facts.token !== null };
}
