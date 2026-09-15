import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import { z } from "zod";

import { auditActor, webActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { AuthService } from "../auth/auth.service";
import type { ProtectedResource } from "../auth/protected-resource";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";

const registerSchema = z.strictObject({
  clientName: z.string().min(1).max(200),
  /**
   * Where the authorization code is sent back to.
   *
   * Bounded and required: a client with no redirect URI cannot complete the
   * flow, and an unbounded list is a place to hide one.
   */
  redirectUris: z.array(z.url()).min(1).max(8),
});

/**
 * Registering a client by hand.
 *
 * Most clients register themselves by presenting the URL of their own metadata
 * document, which is the path this product expects. This route is for the one
 * that cannot: a client that has no public metadata document, typically
 * something the association had written for itself.
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

    const created = await this.auth.instance.api.adminCreateOAuthClient({
      body: {
        client_name: input.clientName,
        redirect_uris: input.redirectUris,
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp:read mcp:write offline_access",
        require_pkce: true,
        /*
         * Explicit, and never true. A client that skips consent is issued a
         * token with no person having decided anything, which is the one thing
         * the whole arrangement exists to prevent.
         */
        skip_consent: false,
      },
    });

    /*
     * Not optional. The provider enforces per-client resources, so a client
     * with no link row is refused at the token endpoint with an unhelpful
     * error about an invalid target. Clients that register themselves are
     * linked by the provider; one minted here is not.
     */
    await this.auth.instance.api.adminLinkClientResource({
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
      context: { redirectHosts: input.redirectUris.map(hostOf) },
    });

    return {
      clientId: created.client_id,
      clientSecret: created.client_secret ?? null,
    };
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
