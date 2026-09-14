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
     * back.
     */
    if (response.ok || isRedirect(response)) {
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

/** A 3xx the provider answers a granted consent with. */
function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
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
