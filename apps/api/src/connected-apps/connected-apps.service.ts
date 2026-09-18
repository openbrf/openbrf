import { Injectable } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import type { ActorContext } from "../audit/actor-context";
import { auditActor } from "../audit/actor-context";
import type { Principal } from "../authorization/capabilities";
import { PrincipalService } from "../authorization/principal.service";
import { PrismaService } from "../database/prisma.service";

/**
 * What a person, or a board member, can see and do about connected apps.
 *
 * A connected app is an external program a member allowed to act for them. The
 * grant is an `OauthConsent` row; what it is worth at any moment is decided
 * per call by the action registry against the person's capabilities as they
 * are then, so nothing here has to be kept in step with a board term ending.
 *
 * The one thing this service owns outright is the disconnect, which has to be
 * immediate and complete.
 */

/** One connection, as a person or a board member reads it. */
export interface ConnectedAppView {
  clientId: string;
  clientName: string | null;
  clientHost: string | null;
  scopes: string[];
  connectedAt: Date;
  /**
   * When a token for this connection was last issued.
   *
   * Derived from the newest live access token rather than from use: nothing
   * records a call against a grant, and a row that did would be a second
   * statutory-adjacent log growing per request. Null once every token has
   * expired and been swept, which reads correctly as "not lately".
   */
  lastTokenIssuedAt: Date | null;
  /**
   * Whether the person's standing has narrowed to nothing an app could use.
   *
   * Nothing revokes a token when a board term ends or a residency does, and
   * nothing needs to: what a grant is worth is decided per call against the
   * person's capabilities as they are then, so a narrowed person's app is
   * refused at the moment it asks. What that costs is a list that says
   * "connected" about a connection which can no longer do anything, and looks
   * fresher as it becomes more useless, because the app keeps refreshing its
   * token on schedule.
   *
   * True when the person holds no capability beyond `self:manage`, which every
   * person row carries and no action in core declares. That is a statement
   * about standing and not about scopes: a token says whether it may read or
   * write, never which of the association's records an app reaches, so this
   * cannot answer the narrower question of whether the particular thing an app
   * does is still permitted. A board member who has only stopped being on the
   * board keeps every resident capability and their connection is not dormant.
   *
   * Derived at read time from the same `PrincipalService.forPerson` the
   * refusal uses, so the word beside a row and the answer an app gets cannot
   * come from different readings.
   */
  dormant: boolean;
}

/** The same, plus who granted it. Only the board's instance-wide view. */
export interface ConnectedAppGrantView extends ConnectedAppView {
  personId: string;
  personName: string;
  /**
   * The account the grant hangs off.
   *
   * Carried because cutting somebody else's connection is addressed by account
   * rather than by person: the grant belongs to the account, a person may in
   * principle have none, and deriving one from the other in the browser would
   * be a second answer to a question this row has already answered.
   */
  userId: string;
}

@Injectable()
export class ConnectedAppsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly principals: PrincipalService,
  ) {}

  /** One person's own connections. */
  async forPerson(personId: string): Promise<ConnectedAppView[]> {
    const account = await this.prisma.user.findUnique({
      where: { personId },
      select: { id: true },
    });
    if (account === null) {
      // A person with no account has never connected anything. An empty list
      // rather than a refusal: the screen is reachable by anyone signed in,
      // and "you have none" is the true answer.
      return [];
    }

    const consents = await this.prisma.oauthConsent.findMany({
      where: { userId: account.id },
      orderBy: { createdAt: "desc" },
      select: {
        clientId: true,
        scopes: true,
        createdAt: true,
        client: { select: { name: true, clientDiscoveryId: true, uri: true } },
      },
    });

    const issued = await this.latestTokenPerClient(account.id);
    // One read for the whole list: standing belongs to the person and not to
    // any one connection, so every row on this screen answers alike.
    const dormant = isDormant(await this.principals.forPerson(personId));

    return consents.map((consent) => ({
      clientId: consent.clientId,
      clientName: consent.client.name,
      clientHost: hostOf(
        consent.client.clientDiscoveryId ?? consent.client.uri ?? null,
      ),
      scopes: consent.scopes,
      connectedAt: consent.createdAt,
      lastTokenIssuedAt: issued.get(consent.clientId) ?? null,
      dormant,
    }));
  }

  /**
   * Every connection on the instance, for the board.
   *
   * The board can see that a member has connected something and can cut it
   * off, which is what makes the association answerable for what leaves it.
   * It does not show what any app has done: that is in the audit log, against
   * the person, where reading it is itself recorded.
   */
  async all(): Promise<ConnectedAppGrantView[]> {
    const consents = await this.prisma.oauthConsent.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        clientId: true,
        userId: true,
        scopes: true,
        createdAt: true,
        client: { select: { name: true, clientDiscoveryId: true, uri: true } },
        user: {
          select: {
            id: true,
            person: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    // One grouped query for the whole screen rather than one per row: the
    // board's list is every connection on the instance, so a query per row
    // would grow with the cooperative.
    const issued = await this.latestTokenPerAccountAndClient();

    /*
     * One read per person and not per row: a member with three connections is
     * one question about standing, asked once. It is still a query per person
     * on a screen that is only ever read, which is the cost of deriving this
     * rather than storing it - and storing it would need the watcher on board
     * terms and residencies that deliberately does not exist.
     */
    const dormant = new Map<string, boolean>();
    for (const personId of new Set(
      consents
        .map((consent) => consent.user?.person?.id)
        .filter((id): id is string => id !== undefined && id !== null),
    )) {
      dormant.set(
        personId,
        isDormant(await this.principals.forPerson(personId)),
      );
    }

    const rows: ConnectedAppGrantView[] = [];
    for (const consent of consents) {
      const person = consent.user?.person;
      if (person === undefined || person === null) {
        // A consent whose account or person is gone. Nothing to attribute it
        // to, and the cascade removes it with the account, so it is not shown
        // rather than shown against nobody.
        continue;
      }
      rows.push({
        personId: person.id,
        personName: `${person.firstName} ${person.lastName}`,
        userId: consent.userId ?? consent.user?.id ?? "",
        clientId: consent.clientId,
        clientName: consent.client.name,
        clientHost: hostOf(
          consent.client.clientDiscoveryId ?? consent.client.uri ?? null,
        ),
        scopes: consent.scopes,
        connectedAt: consent.createdAt,
        lastTokenIssuedAt:
          issued.get(pairKey(consent.userId, consent.clientId)) ?? null,
        dormant: dormant.get(person.id) ?? true,
      });
    }
    return rows;
  }

  /**
   * Cuts a connection off.
   *
   * Three statements, and the order of the first two is what makes the cut
   * immediate rather than eventual:
   *
   *   The access-token rows are deleted. The bearer resolver looks a row up on
   *   every call with no cache anywhere in the path, so the next call after
   *   this commits is refused. Nothing waits for a token to expire.
   *
   *   The refresh tokens are marked revoked rather than deleted, which is what
   *   the library's own revocation does: a later attempt to use a revoked
   *   refresh token is treated as a replay and invalidates the whole family,
   *   rather than looking like an ordinary miss. Deleting them would throw
   *   that signal away.
   *
   *   The consent row is deleted, so nothing can be re-authorised silently.
   *   Reconnecting means consenting again, against the catalogue as it is then.
   *
   * The audit entry is written inside the same transaction, so a connection
   * cannot be cut without a record of who cut it.
   */
  async disconnect(input: {
    /** The account holding the grant. */
    userId: string;
    /** The person that account belongs to. */
    personId: string;
    clientId: string;
    actor: ActorContext;
    /** True when somebody other than the grantor is doing this. */
    onBehalf: boolean;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.oauthAccessToken.deleteMany({
        where: { userId: input.userId, clientId: input.clientId },
      });
      await tx.oauthRefreshToken.updateMany({
        where: {
          userId: input.userId,
          clientId: input.clientId,
          revoked: null,
        },
        data: { revoked: new Date() },
      });
      await tx.oauthConsent.deleteMany({
        where: { userId: input.userId, clientId: input.clientId },
      });

      /*
       * A person disconnecting their own app writes no entry, the way removing
       * one's own passkey writes none: the audit log records what was done to
       * a member's data by somebody else, and a person managing their own
       * credentials is not that. Somebody disconnecting on another's behalf is
       * exactly that, and is recorded against both.
       */
      if (input.onBehalf) {
        await this.audit.record(
          {
            action: "CONNECTED_APP_DISCONNECTED",
            ...auditActor(input.actor),
            targetPersonId: input.personId,
            targetKind: "connectedApp",
            targetId: input.clientId,
          },
          tx,
        );
      }
    });
  }

  /**
   * The newest live access token per client, for one account.
   *
   * One grouped query rather than one per connection: a person with several
   * apps would otherwise cost a query each on a screen that is only ever
   * read.
   */
  private async latestTokenPerClient(
    userId: string,
  ): Promise<Map<string, Date>> {
    const rows = await this.prisma.oauthAccessToken.groupBy({
      by: ["clientId"],
      where: { userId, revoked: null },
      _max: { createdAt: true },
    });

    const latest = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.createdAt !== null) {
        latest.set(row.clientId, row._max.createdAt);
      }
    }
    return latest;
  }

  /**
   * The same, across every account, for the board's instance-wide list.
   *
   * Grouped on the pair because a client is connected by more than one person:
   * grouping on the client alone would date every member's connection from
   * whoever used it last.
   */
  private async latestTokenPerAccountAndClient(): Promise<Map<string, Date>> {
    const rows = await this.prisma.oauthAccessToken.groupBy({
      by: ["userId", "clientId"],
      where: { revoked: null },
      _max: { createdAt: true },
    });

    const latest = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.createdAt !== null && row.userId !== null) {
        latest.set(pairKey(row.userId, row.clientId), row._max.createdAt);
      }
    }
    return latest;
  }
}

/**
 * One account and one client, as a map key.
 *
 * A newline separates them because neither an account id nor a client id can
 * contain one, so no pair can be spelled two ways - a client id is a URL, and a
 * separator a URL may carry would let two different pairs collide on one key.
 */
function pairKey(userId: string | null, clientId: string): string {
  return `${userId ?? ""}\n${clientId}`;
}

/**
 * The host a client is reached at.
 *
 * A host rather than the whole URL: what a member needs in order to recognise
 * an app is where it lives, and a full URL with its path and query is longer
 * and less recognisable. Null rather than a placeholder when it cannot be
 * parsed, so a screen shows nothing rather than something untrue.
 */
/**
 * Whether a person's standing has narrowed to nothing an app could use.
 *
 * `self:manage` is granted unconditionally to anybody with a person row, and
 * core registers no action that declares it, so a person holding that and
 * nothing else has an app that can reach none of the association's records.
 * A person with no row at all is dormant for the plainer reason: the refusal
 * their app meets is that they no longer hold an account.
 */
function isDormant(principal: Principal | null): boolean {
  if (principal === null) {
    return true;
  }
  for (const capability of principal.capabilities) {
    if (capability !== "self:manage") {
      return false;
    }
  }
  return true;
}

function hostOf(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
