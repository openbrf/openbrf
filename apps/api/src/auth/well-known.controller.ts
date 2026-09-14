import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { All, Controller, Get, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { Public } from "../authorization/public.decorator";
import { AuthService } from "./auth.service";
import { sendWebResponse, toWebRequest } from "./fastify-bridge";

/**
 * The discovery documents, at the root of the origin.
 *
 * A client is given one address - the resource - and has to be able to find
 * everything else from it. RFC 8414 and RFC 9728 both put those documents at
 * fixed paths at the root of the origin, and the sign-in library is mounted
 * under a base path, so it cannot serve them from where they have to be. The
 * library exports the same handlers for exactly this case and this controller
 * is where they are mounted; the bodies are the provider's own, not documents
 * composed here.
 *
 * Public, and it is a fourth kind of public route beyond the three the
 * decorator names. A discovery document says how a token may be obtained. It
 * carries no personal data and nothing about this association, and it has to
 * be readable before any token exists - requiring one to find out how to get
 * one is a loop. ADR 0009 records the position.
 *
 * No CORS, and none is needed: these are fetched server-side by the clients
 * this targets. Adding it would be the first CORS in a codebase whose whole
 * cookie arrangement rests on same-origin, so a browser-based client is the
 * trigger to revisit it rather than something to pre-empt.
 */
@Public()
@Controller(".well-known")
export class WellKnownController {
  constructor(private readonly auth: AuthService) {}

  @Get("oauth-authorization-server")
  async authorizationServer(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const handler = oauthProviderAuthServerMetadata(this.auth.instance);
    await this.answer(reply, handler, request);
  }

  /**
   * The OpenID alias, which on this instance answers 404 and should.
   *
   * This is an OAuth authorization server and not an OpenID provider: the
   * `openid` scope is not offered, no id token is issued, and a client is told
   * nothing about who it acts for. The library refuses this document for
   * exactly that reason, and the refusal is the correct answer - serving one
   * would advertise an identity layer that does not exist here.
   *
   * The route is still declared, for two reasons. Without it the path is
   * unclaimed, and an unclaimed path under the origin's root is answered by
   * the association's own website with its HTML not-found page - which a
   * client parsing JSON reads as neither a document nor a refusal. And an
   * instance that later offered `openid` would have the alias already in
   * place.
   */
  @Get("openid-configuration")
  async openIdConfiguration(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const handler = oauthProviderOpenIdConfigMetadata(this.auth.instance);
    await this.answer(reply, handler, request);
  }

  /**
   * The resource document, at the bare path and beneath it.
   *
   * A path array rather than two decorators: a second @All would replace the
   * first one's path metadata rather than adding to it, and both forms have to
   * answer. The sub-path form is the one the challenge header points at,
   * because it names the route the connector actually serves; the bare form is
   * what a client that was given only the origin will try.
   *
   * Forwarded whole to the library, which answers this path from a hook that
   * runs before its own routing, so the response is the provider's document
   * either way.
   */
  @All(["oauth-protected-resource", "oauth-protected-resource/*"])
  async protectedResource(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendWebResponse(
      reply,
      await this.auth.handler(toWebRequest(request)),
    );
  }

  /**
   * Answers with the provider's document, or with the refusal it raised.
   *
   * A metadata handler throws rather than returning a response when the
   * document does not exist for this configuration, and the status it names is
   * the answer a client needs. Letting it escape would make a deliberate
   * refusal indistinguishable from the server having broken, on the one family
   * of routes whose whole purpose is telling a client what is available. Any
   * failure that names no status is still a fault and is rethrown.
   */
  private async answer(
    reply: FastifyReply,
    handler: (request: Request) => Promise<Response>,
    request: FastifyRequest,
  ): Promise<void> {
    let response: Response;
    try {
      // Only the handler is inside the try. Sending is not: a failure part way
      // through writing the reply would otherwise be answered by writing a
      // second one, and the error that produces says nothing about the first.
      response = await handler(toWebRequest(request));
    } catch (cause) {
      const status = statusOf(cause);
      if (status === null) {
        throw cause;
      }
      void reply.status(status);
      await reply.send({ statusCode: status, error: "Not Found" });
      return;
    }

    await sendWebResponse(reply, response);
  }
}

/** The HTTP status a library failure named, when it named one. */
function statusOf(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  const named = (cause as { statusCode?: unknown }).statusCode;
  return typeof named === "number" && named >= 400 && named < 500
    ? named
    : null;
}
