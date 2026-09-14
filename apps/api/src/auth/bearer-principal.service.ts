import { Inject, Injectable } from "@nestjs/common";

import type { Principal } from "../authorization/capabilities";
import { PrincipalService } from "../authorization/principal.service";
import { PrismaService } from "../database/prisma.service";
import { hashOpaqueToken } from "./opaque-token";
import type { ProtectedResource } from "./protected-resource";
import { PROTECTED_RESOURCE } from "./protected-resource.module";

/**
 * What a bearer token was resolved to.
 *
 * The client facts travel beside the principal because an action performed
 * through a connected app is recorded against the person who granted it, with
 * the app named in the entry's context: the log has to be able to answer "the
 * member did this, through which app".
 */
export interface BearerIdentity {
  principal: Principal;
  /** The row's id. The token value itself is never held or logged. */
  tokenRowId: string;
  clientId: string;
  /**
   * Host of the client-id metadata URL, or of the registered client URI.
   *
   * The host and not the name. The name is a label a client chose for itself
   * and is only ever read on a screen, where the row is joined anyway; the
   * host is what the audit entry records, because it is the part that says
   * where the data actually went.
   */
  clientHost: string | null;
  /** The coarse ceiling the registry reads. Never a grant on its own. */
  scopes: string[];
}

/**
 * Resolves an opaque bearer token to the person it acts for.
 *
 * Lookup rather than introspection. Introspection would need an internal
 * confidential client minted at boot, a secret stored and rotated, and an HTTP
 * round trip from this process to itself, and would buy session-liveness
 * checking that is not wanted here. What this needs is one indexed query on a
 * unique column.
 *
 * Nothing is cached, deliberately and at a cost of one query per call. The
 * capabilities are re-derived from the register on every request, so a board
 * term ending narrows every app that person authorised the same night it
 * narrows the person, and deleting the token row is what makes a disconnect
 * take effect on the next call rather than at the end of the token's lifetime.
 *
 * Every failure returns null. Which check failed is not told to the caller: a
 * caller holding a token learns only that it is not accepted, because the
 * difference between "expired", "revoked" and "was never yours" is information
 * about somebody else's connection.
 */
@Injectable()
export class BearerPrincipalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalService,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
  ) {}

  async resolve(presented: string): Promise<BearerIdentity | null> {
    const row = await this.prisma.oauthAccessToken.findUnique({
      where: { token: hashOpaqueToken(presented) },
      select: {
        id: true,
        clientId: true,
        userId: true,
        expiresAt: true,
        revoked: true,
        resources: true,
        scopes: true,
      },
    });

    if (row === null || row.revoked !== null) {
      return null;
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    /*
     * The audience check RFC 8707 makes a MUST, and the reason a client that
     * omits the `resource` parameter is refused rather than defaulted: a
     * server must not accept a token that was not issued for it. Without this,
     * a token minted by this same instance for some other audience would be
     * accepted here.
     */
    if (!row.resources.includes(this.resource.url)) {
      return null;
    }

    // A token with no user is a client-credentials token. Nothing in this
    // product is done by a client on its own behalf - every action is
    // performed as a person - so there is nobody to act as.
    if (row.userId === null) {
      return null;
    }

    const account = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { personId: true },
    });
    if (account === null) {
      return null;
    }

    const principal = await this.principals.forPerson(account.personId);
    if (principal === null) {
      return null;
    }

    const client = await this.prisma.oauthClient.findUnique({
      where: { clientId: row.clientId },
      select: { clientDiscoveryId: true, uri: true },
    });

    return {
      principal,
      tokenRowId: row.id,
      clientId: row.clientId,
      clientHost: hostOf(client?.clientDiscoveryId ?? client?.uri ?? null),
      scopes: row.scopes,
    };
  }
}

/**
 * The host a client is reached at, for the audit entry and the screens.
 *
 * A host rather than the whole URL: what a board member needs to recognise is
 * which app this is, and a full URL with its path and query is both longer and
 * less recognisable. Null rather than a placeholder when it cannot be parsed,
 * so that a screen shows nothing rather than something untrue.
 */
function hostOf(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
