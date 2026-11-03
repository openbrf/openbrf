import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  ISSUE_CONVERSATION_LIMITS,
  scanForPersonalIdentityNumbers,
} from "@openbrf/shared";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import {
  IssueReporterLinkService,
  REPORTER_LINK_PATH,
  type ReporterLinkReplyOutcome,
} from "../issues/issue-reporter-link.service";
import {
  ISSUE_LINK_BODY_FIELD,
  ISSUE_LINK_NOTICE_PARAM,
  type IssueLinkNotice,
  issueLinkNotice,
} from "./site-issue-link";
import { SiteRenderer } from "./site-renderer.service";

/**
 * Page reads one client address may make in a minute.
 *
 * `@PublicRateLimit` says a GET is not worth limiting; on this route it is the
 * one a guess is made on, so it has a budget (ADR 0055). Thirty is more than a
 * person reading their issue and answering it ever needs, and it makes
 * guessing a 256-bit token from one address hopeless twice over.
 */
export const LINK_READS_PER_MINUTE = 30;

/**
 * Messages one client address may send in a minute, across every link. The
 * link's own budget is counted in the database (`IssueReporterLinkService`),
 * which an address budget alone could never give a link that leaked.
 */
export const LINK_WRITES_PER_MINUTE = 5;

/**
 * A message as the page's form sends it: one field, its line breaks counted as
 * one character as the form counts them, trimmed, and within the bound every
 * issue message has.
 */
const messageSchema = z.object({
  [ISSUE_LINK_BODY_FIELD]: z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .refine((value) => value !== "")
    .refine((value) => value.length <= ISSUE_CONVERSATION_LIMITS.body),
});

/** What the page is told for each outcome of a message. */
const NOTICE_FOR: Readonly<
  Record<Exclude<ReporterLinkReplyOutcome, "not-found">, IssueLinkNotice>
> = {
  sent: "sent",
  closed: "closed",
  limited: "limited",
};

/**
 * The page a reporter's private link opens, and the message written on it
 * (decision 20 of the issue module plan, ADR 0055).
 *
 * The second way to an issue without a session, beside nothing: the issues
 * module's own controllers keep no `@Public()` route. This one stands in the
 * site layer, beside the website's forms, because it is the same kind of
 * thing: a server-rendered page with a plain form, no script, no cookie, no
 * JSON.
 *
 * What holds here, each with a test:
 *
 * - **The token is the address and nothing else is.** It is read from the path
 *   alone. No query value, header or field names an issue, a message or
 *   anything else the link could be made to reach.
 * - **Every refusal is one document.** A token never issued, malformed,
 *   expired, withdrawn, or of an issue closed long ago is answered with the
 *   same 404, byte for byte, so a caller learns nothing from which it was.
 * - **A read writes nothing**, and a GET to the form's address shows the page
 *   and does nothing else. Only a POST writes.
 * - **Every route has a budget per client address**, the GET included, spent
 *   before the token is resolved, so the 429 is the same for every token.
 * - **A post from another origin is refused**, and so is any body that is not
 *   the form's: a file can never be sent here (decision 20).
 *
 * The headers every answer carries are set by a hook on the path
 * (`site-issue-link-headers.ts`), so the refusals the guard and the filters
 * build carry them too.
 *
 * Nothing here logs the path, the token or what was written.
 */
@Public()
@Controller(REPORTER_LINK_PATH.slice(1))
export class SiteIssueLinkController {
  private readonly origin: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly links: IssueReporterLinkService,
    private readonly renderer: SiteRenderer,
  ) {
    this.origin = new URL(env.APP_URL).origin;
  }

  /** The page. Reads, and writes nothing at all. */
  @Get(":token")
  @PublicRateLimit({ perMinute: LINK_READS_PER_MINUTE })
  async page(
    @Param("token") token: string,
    @Query(ISSUE_LINK_NOTICE_PARAM) notice: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const view = await this.links.open(token);
    if (view === null) {
      await this.notFound(request, reply);
      return;
    }
    const html = await this.renderer.issueLink(
      acceptLanguageOf(request),
      view,
      issueLinkNotice(notice),
      pagePath(token),
    );
    void reply.code(200).header("content-type", HTML).send(html);
  }

  /**
   * A message the reporter writes.
   *
   * Answered with a 303 to the page, which says what became of it in a fixed
   * sentence and never repeats what was written. A token that opens nothing is
   * answered with the one refusal, whatever the body was.
   */
  @Post(":token")
  @PublicRateLimit({ perMinute: LINK_WRITES_PER_MINUTE })
  async message(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.isOwnForm(request)) {
      await this.notFound(request, reply);
      return;
    }

    const parsed = messageSchema.safeParse(body);
    const refusal: IssueLinkNotice | null = !parsed.success
      ? "refused"
      : scanForPersonalIdentityNumbers(parsed.data[ISSUE_LINK_BODY_FIELD])
            .length > 0
        ? "identity"
        : null;
    if (refusal !== null || !parsed.success) {
      // Told why only once the token is known to open something, so a body
      // the form would refuse cannot be used to tell tokens apart either.
      if ((await this.links.open(token)) === null) {
        await this.notFound(request, reply);
        return;
      }
      this.answer(reply, token, refusal ?? "refused");
      return;
    }

    const outcome = await this.links.reply(
      token,
      parsed.data[ISSUE_LINK_BODY_FIELD],
    );
    if (outcome === "not-found") {
      await this.notFound(request, reply);
      return;
    }
    this.answer(reply, token, NOTICE_FOR[outcome]);
  }

  /**
   * Whether a post is the page's own form: url-encoded, and sent from this
   * instance's page or with the `null` origin a page under
   * `Referrer-Policy: no-referrer` sends. A post from another origin is
   * refused. There is no cookie here for such a post to ride on, so this is
   * defence in depth rather than the guard against forgery: the token is.
   *
   * A multipart body is refused before it is read, so a file sent here is
   * never parsed, buffered or stored (decision 20: text only).
   */
  private isOwnForm(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== "null" && origin !== this.origin) {
      return false;
    }
    const type = request.headers["content-type"] ?? "";
    return type.split(";", 1)[0]?.trim().toLowerCase() === FORM_ENCODED;
  }

  /** Back to the page, which says what became of the message. */
  private answer(
    reply: FastifyReply,
    token: string,
    notice: IssueLinkNotice,
  ): void {
    void reply
      .code(303)
      .header(
        "location",
        `${pagePath(token)}?${ISSUE_LINK_NOTICE_PARAM}=${notice}`,
      )
      .send();
  }

  /** The one refusal, whatever made it one. */
  private async notFound(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const html = await this.renderer.issueLinkNotFound(
      acceptLanguageOf(request),
    );
    void reply.code(404).header("content-type", HTML).send(html);
  }
}

const HTML = "text/html; charset=utf-8";
const FORM_ENCODED = "application/x-www-form-urlencoded";

/**
 * The page's own address, from a token that has already opened it: the token
 * is base64url behind a fixed prefix, so it needs no escaping in a path.
 */
function pagePath(token: string): string {
  return `${REPORTER_LINK_PATH}/${token}`;
}

function acceptLanguageOf(request: FastifyRequest): string | undefined {
  const value = request.headers["accept-language"];
  return typeof value === "string" ? value : undefined;
}
