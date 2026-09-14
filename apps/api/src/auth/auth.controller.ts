import { All, Controller, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { Public } from "../authorization/public.decorator";
import { AuthService } from "./auth.service";
import { sendWebResponse, toWebRequest } from "./fastify-bridge";

/**
 * Mounts Better Auth's own endpoints.
 *
 * Everything under the sign-in base path is the library's: sign-in, the second
 * factor, passkeys, the magic link, and the OAuth authorize, token, revoke and
 * introspect endpoints. The translation between Fastify and the Web Fetch pair
 * the library speaks is in fastify-bridge.ts, shared with the discovery
 * controller.
 */
@Public()
@Controller("api/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @All("*")
  async handle(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = await this.auth.handler(toWebRequest(request));
    await sendWebResponse(reply, response);
  }
}
