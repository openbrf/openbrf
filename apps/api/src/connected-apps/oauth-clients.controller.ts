import {
  Body,
  Controller,
  HttpStatus,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import { isAPIError } from "better-auth/api";
import { z } from "zod";

import { auditActor, webActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { AuthService } from "../auth/auth.service";
import { isLoopbackHost } from "../config/env";
import { forwardHeaders } from "../auth/fastify-bridge";
import type { ProtectedResource } from "../auth/protected-resource";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import { DomainError } from "../http/domain-error";
import { hostOf } from "./client-host";

/**
 * The provider refused one of the redirect URIs the client named.
 *
 * The provider judges the addresses again, against its own rules for the kind
 * of client they imply, and those are stricter than ours: it refuses an https
 * address on this machine and a host written some way other than `localhost`,
 * `127.0.0.1` or `[::1]`. That is the administrator's input, not a server
 * fault, so it answers 400 with the code the registration form already has a
 * sentence for.
 */
export class InvalidRedirectUriError extends DomainError {
  readonly status = HttpStatus.BAD_REQUEST;
  readonly reason = "invalid-redirect-uri";
}

/**
 * The kind of client the addresses describe, in the provider's terms.
 *
 * The provider has one set of rules for a client at a web address (https, and
 * never this machine) and another for an app on the member's own machine
 * (http on a loopback host, RFC 8252 7.3). It refuses a loopback address for
 * the first, so a client that names one has to be registered as the second.
 * The kind is read only by that check on the addresses: it changes neither the
 * grants, nor the secret, nor the consent every member is still asked for.
 */
export function applicationTypeFor(
  redirectUris: readonly string[],
): "web" | "native" {
  return redirectUris.some((uri) => new URL(uri).protocol === "http:")
    ? "native"
    : "web";
}

const registerSchema = z.strictObject({
  clientName: z.string().min(1).max(200),
  /**
   * Where the authorization code is sent back to.
   *
   * Bounded and required: a client with no redirect URI cannot complete the
   * flow, and an unbounded list is a place to hide one.
   */
  redirectUris: z
    .array(
      z.url().refine(isAcceptableRedirectUri, {
        message: "A redirect URI is https, or http on this machine.",
      }),
    )
    .min(1)
    .max(8),
});

/**
 * Where an authorization code may be sent: https, or plain http on a loopback
 * host for a client running on the member's own machine (RFC 8252 7.3), with
 * no credentials and no fragment in it.
 *
 * Every other scheme is refused. The consent screen navigates to this address
 * with the code in it, so a script or data URL would run in this application's
 * origin, and plain http elsewhere would send the code in clear text.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/**
 * Registering a client by hand.
 *
 * Most clients register themselves by presenting the URL of their own metadata
 * document, which is the path this product expects. This route is for the one
 * that cannot: a client that has no public metadata document, typically
 * something the association had written for itself. It is the only route that
 * registers a client by hand; the provider's own client-management endpoints
 * are closed over HTTP (`CLIENT_MANAGEMENT_PATHS` in auth-options.ts).
 *
 * Registering a client grants nothing. It makes the client known to the
 * instance so that a member can then be asked whether to let it act for them;
 * until somebody consents, it can reach nothing.
 */
@Controller("api/oauth-clients")
export class OAuthClientsController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditLogService,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
  ) {}

  @Post()
  @RequireCapability("association:manage")
  async register(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ clientId: string; clientSecret: string | null }> {
    const input = registerSchema.parse(body);
    const actor = webActor(request);

    /*
     * The administrator's own headers, on both calls. The provider resolves the
     * session from them and asks its clientPrivileges hook whether that person
     * may manage clients; a call without them is refused as unauthenticated.
     */
    const headers = forwardHeaders(request);

    const created = await this.createClient(headers, input);

    /*
     * Not optional. The provider enforces per-client resources, so a client
     * with no link row is refused at the token endpoint with an unhelpful
     * error about an invalid target. Clients that register themselves are
     * linked by the provider; one minted here is not.
     */
    await this.auth.instance.api.adminLinkClientResource({
      headers,
      params: {
        identifier: this.resource.url,
        client_id: created.client_id,
      },
    });

    await this.audit.record({
      action: "OAUTH_CLIENT_REGISTERED",
      ...auditActor(actor),
      targetKind: "oauthClient",
      targetId: created.client_id,
      // The hosts, never the secret. The secret is shown to the administrator
      // once, in the response, and is not ours to repeat anywhere else.
      context: {
        redirectHosts: input.redirectUris.map((uri) => hostOf(uri)),
      },
    });

    return {
      clientId: created.client_id,
      clientSecret: created.client_secret ?? null,
    };
  }

  /**
   * Creates the client, turning the provider's refusal of an address into ours.
   *
   * Only that refusal: any other failure is not the administrator's input and
   * keeps the answer it had.
   */
  private async createClient(
    headers: Headers,
    input: z.infer<typeof registerSchema>,
  ): Promise<{ client_id: string; client_secret?: string }> {
    try {
      return await this.auth.instance.api.adminCreateOAuthClient({
        headers,
        body: {
          client_name: input.clientName,
          redirect_uris: input.redirectUris,
          application_type: applicationTypeFor(input.redirectUris),
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp:read mcp:write offline_access",
          require_pkce: true,
          /*
           * Explicit, and never true. A client that skips consent is issued a
           * token with no person having decided anything, which is the one
           * thing the whole arrangement exists to prevent.
           */
          skip_consent: false,
        },
      });
    } catch (error) {
      if (isAPIError(error) && error.body?.error === "invalid_redirect_uri") {
        throw new InvalidRedirectUriError(
          error.body.error_description ??
            "The provider refused a redirect URI.",
        );
      }
      throw error;
    }
  }
}
