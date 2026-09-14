import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { auditActor, webActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { AuthService } from "../auth/auth.service";
import {
  forwardHeaders,
  originOf,
  sendWebResponse,
} from "../auth/fastify-bridge";
import { PrismaService } from "../database/prisma.service";
import {
  type ConnectedAppGrantView,
  ConnectedAppsService,
  type ConnectedAppView,
} from "./connected-apps.service";

/**
 * A person's own connected apps.
 *
 * No capability: every member may see and cut their own connections, the way
 * every member may manage their own passkeys. Requiring one would mean a
 * member could grant an app access to their own data and then need the board
 * in order to take it back.
 */
@Controller("api/connected-apps/mine")
export class MyConnectedAppsController {
  constructor(
    private readonly apps: ConnectedAppsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async mine(@Req() request: RequestWithPrincipal): Promise<{
    connectedApps: ConnectedAppView[];
  }> {
    const actor = webActor(request);
    return { connectedApps: await this.apps.forPerson(actor.personId) };
  }

  @Delete(":clientId")
  async disconnect(
    @Req() request: RequestWithPrincipal,
    @Param("clientId") clientId: string,
  ): Promise<{ disconnected: true }> {
    const actor = webActor(request);
    const account = await this.prisma.user.findUnique({
      where: { personId: actor.personId },
      select: { id: true },
    });
    if (account === null) {
      throw new NotFoundException("No connection to disconnect.");
    }

    await this.apps.disconnect({
      userId: account.id,
      personId: actor.personId,
      clientId,
      actor,
      // Their own. No audit entry, for the reason the service states.
      onBehalf: false,
    });
    return { disconnected: true };
  }
}

/**
 * Every connection on the instance, and cutting one on somebody's behalf.
 *
 * Two different capabilities on purpose. Seeing that a member has connected
 * something is part of knowing what leaves the association, which is
 * `association:read`. Cutting somebody else's connection is acting on another
 * person's data and sits with whoever answers for that.
 */
@Controller("api/connected-apps")
export class ConnectedAppsAdminController {
  constructor(
    private readonly apps: ConnectedAppsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequireCapability("association:read")
  async all(): Promise<{ connectedApps: ConnectedAppGrantView[] }> {
    return { connectedApps: await this.apps.all() };
  }

  @Delete(":userId/:clientId")
  @RequireCapability("dataProtection:manage")
  async disconnect(
    @Req() request: RequestWithPrincipal,
    @Param("userId") userId: string,
    @Param("clientId") clientId: string,
  ): Promise<{ disconnected: true }> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { personId: true },
    });
    if (account === null) {
      throw new NotFoundException("No such account.");
    }

    await this.apps.disconnect({
      userId,
      personId: account.personId,
      clientId,
      actor: webActor(request),
      onBehalf: true,
    });
    return { disconnected: true };
  }
}

/** Where the sign-in library serves the consent decision. */
const PROVIDER_CONSENT_PATH = "/api/auth/oauth2/consent";

/**
 * The consent the person gives on the authorization screen.
 *
 * Forwarded to the sign-in library in this process rather than posted to it
 * from the browser, for one reason: the audit entry is then written in this
 * same request, after the provider's call returns. A second browser request
 * would race the redirect the provider answers with, and a connection granted
 * with no record of it is the one outcome this must not have.
 *
 * Accept only. There is no deny: denying cancels this authorization request,
 * which is not the same as withdrawing a grant already given and would leave
 * an earlier one standing. Withdrawing is the disconnect above.
 *
 * No capability. Deciding whether to let an app act for you is not something
 * the board grants a member permission to do.
 */
@Controller("api/connected-apps/consent")
export class OAuthConsentController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  async consent(
    @Req() request: RequestWithPrincipal,
    @Res() reply: FastifyReply,
    @Body() body: { oauth_query?: unknown },
  ): Promise<void> {
    const actor = webActor(request);
    const query = typeof body.oauth_query === "string" ? body.oauth_query : "";

    /*
     * The query is forwarded exactly as the screen received it, never rebuilt.
     * It is signed, and the signature is over the bytes: re-serialising can
     * reorder a parameter or re-encode a character and break it, and the
     * failure would look like a refused consent rather than a mangled request.
     */
    const forwarded = new Request(
      new URL(PROVIDER_CONSENT_PATH, originOf(request)),
      {
        method: "POST",
        headers: withJsonBody(forwardHeaders(request)),
        body: JSON.stringify({ accept: true, oauth_query: query }),
      },
    );

    const response = await this.auth.handler(forwarded);

    /*
     * Recorded only when the provider actually granted it. Writing before the
     * call would record a connection that a refusal then never made, and the
     * audit log is append-only, so an entry written in error cannot be taken
     * back. The status alone does not say it was granted - see below.
     */
    if (await grantedByProvider(response)) {
      const asked = new URLSearchParams(query);
      const clientId = asked.get("client_id");
      if (clientId !== null) {
        await this.audit.record({
          action: "CONNECTED_APP_CONNECTED",
          ...auditActor(actor),
          targetPersonId: actor.personId,
          targetKind: "connectedApp",
          targetId: clientId,
          context: {
            scopes: asked.get("scope")?.split(" ") ?? [],
            redirectHost: hostOf(asked.get("redirect_uri")),
          },
        });
      }
    }

    await sendWebResponse(reply, response);
  }
}

/**
 * Whether the provider granted this consent, rather than merely answering.
 *
 * The provider does not answer this route with a 3xx. Its consent endpoint
 * sets `accept: application/json` before it authorizes, so what comes back is
 * an ordinary 200 carrying `{ redirect: true, url }` - and it carries that
 * same shape whether the request was granted, refused for an invalid
 * parameter, or turned into a re-authentication because the request asked for
 * `prompt=login`. A refusal is an error URL with a 200 status.
 *
 * So the status cannot tell a granted connection from a declined one, and
 * `response.ok` was recording all three as a connection the member made. What
 * distinguishes them is the authorization code: the provider puts one in the
 * address it hands back only when a grant now exists.
 *
 * The body is read from a clone, because the response itself is still to be
 * forwarded to the browser and a body may only be read once.
 *
 * Anything unreadable counts as not granted. The audit log is append-only, so
 * an entry claiming a connection the member never made cannot be withdrawn,
 * and the doubtful case has to fall to the side that can still be corrected by
 * the member simply connecting again.
 */
async function grantedByProvider(response: Response): Promise<boolean> {
  if (!response.ok) {
    return false;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return false;
  }

  const url =
    typeof payload === "object" && payload !== null
      ? (payload as { url?: unknown }).url
      : undefined;
  if (typeof url !== "string") {
    return false;
  }

  let answered: URL;
  try {
    answered = new URL(url);
  } catch {
    return false;
  }

  /*
   * The code rides in the query, or in the fragment where the client asked for
   * that response mode. An error beside it is the provider declining, and is
   * read from both places for the same reason.
   */
  const fromQuery = answered.searchParams;
  const fromFragment = new URLSearchParams(
    answered.hash.startsWith("#") ? answered.hash.slice(1) : answered.hash,
  );
  if (fromQuery.get("error") !== null || fromFragment.get("error") !== null) {
    return false;
  }

  const code = fromQuery.get("code") ?? fromFragment.get("code");
  return code !== null && code !== "";
}

/**
 * The browser's headers, with the content type of the body actually sent.
 *
 * The browser posted its own body to reach this route, and what goes on to the
 * provider is a different one. Forwarding the original content type would
 * describe bytes that are not there.
 */
function withJsonBody(headers: Headers): Headers {
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return headers;
}

/** The host of a redirect URI, for the audit entry. Never the whole URI. */
function hostOf(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
