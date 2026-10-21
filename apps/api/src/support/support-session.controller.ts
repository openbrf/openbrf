import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { SupportAccessService } from "./support-access.service";
import { SupportSessionCookie } from "./support-session-cookie";

/**
 * The sign-in token in a link: 32 random bytes, base64url, which is 43
 * characters. Bounded so a body cannot make the digest do unbounded work.
 */
const signInSchema = z.object({ token: z.string().min(1).max(128) });

/** What the supporter's page is told once the link has been used. */
export interface SupportSignInView {
  supporter: string;
  expiresAt: string;
}

/**
 * A supporter's own way in and out (ADR 0028).
 *
 * Public, because a supporter has no account to be signed in with: the link's
 * single-use token is the credential, and the session cookie this sets is what
 * every later request carries. These two routes are the only ones a support
 * session reaches without the guard reading its cookie first - signing in with
 * a new link from a browser holding an old cookie, and signing out - and they
 * are not written to the log as requests: the session's start and end are
 * entries of their own.
 *
 * Signing in carries @PublicRateLimit like every other public route that
 * writes, although guessing a 32-byte token cannot succeed.
 */
@Controller("api/support/session")
@Public()
export class SupportSessionController {
  private readonly cookie: SupportSessionCookie;

  constructor(
    private readonly support: SupportAccessService,
    @Inject(ENV) env: Env,
  ) {
    this.cookie = new SupportSessionCookie(env.APP_URL);
  }

  /**
   * Uses a sign-in link and starts its support session.
   *
   * A browser that still holds an earlier session's cookie has that session
   * ended once the new one has started, so the settings screen and the log
   * show one session per sign-in rather than an abandoned one running on to
   * its expiry. A link that does not work leaves the earlier session alone.
   */
  @Post()
  @PublicRateLimit({ perMinute: 10 })
  async signIn(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SupportSignInView> {
    const { token } = signInSchema.parse(body);
    const session = await this.support.startSession(token);
    const earlier = this.cookie.presented(request.headers.cookie);
    if (earlier.kind === "token") {
      await this.support.endSession(earlier.token);
    }
    void reply
      .header("set-cookie", this.cookie.set(session.token, session.expiresAt))
      .header("cache-control", "no-store");
    return {
      supporter: session.supporter,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  /** Ends the caller's own support session and removes its cookie. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const presented = this.cookie.presented(request.headers.cookie);
    if (presented.kind === "token") {
      await this.support.endSession(presented.token);
    }
    void reply.header("set-cookie", this.cookie.clear());
  }
}
