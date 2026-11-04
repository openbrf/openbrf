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
  normalizeFreeText,
  scanForPersonalIdentityNumbers,
  WORK_ORDER_LIMITS,
} from "@openbrf/shared";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { WORK_ORDER_LINK_TOKEN_PATTERN } from "../issues/work-order-link-token";
import {
  WORK_ORDER_LINK_PATH,
  WORK_ORDER_LINK_PHOTO_SEGMENT,
  type WorkOrderLinkAnswer,
  WorkOrderLinkService,
  type WorkOrderLinkUploadOutcome,
} from "../issues/work-order-link.service";
import { contentDisposition } from "../media/media.controller";
import { SiteRenderer } from "./site-renderer.service";
import { acceptLanguage } from "./site-request";
import {
  WORK_ORDER_LINK_ACT_FIELD,
  WORK_ORDER_LINK_BODY_FIELD,
  WORK_ORDER_LINK_NOTICE_PARAM,
  type WorkOrderLinkNotice,
  workOrderLinkNotice,
} from "./site-work-order-link";

/**
 * Page reads one client address may make in a minute: the page, and the GET of
 * an action's address, which shows the page. As the reporter's link's, and
 * for the same reason: the GET is the route a guess is made on (ADR 0055).
 */
export const WORK_ORDER_LINK_READS_PER_MINUTE = 30;

/**
 * Photographs one client address may read through a link in a minute. More
 * than the page, because one page shows up to thirty of them; still a budget,
 * because the route takes a token.
 */
export const WORK_ORDER_LINK_PHOTO_READS_PER_MINUTE = 120;

/**
 * Answers and notes one client address may send in a minute, across every
 * link. The link's own budget is counted in the database
 * (`WorkOrderLinkService`), which an address budget could never give a link
 * that leaked.
 */
export const WORK_ORDER_LINK_WRITES_PER_MINUTE = 5;

/** Photographs one client address may send in a minute. */
export const WORK_ORDER_LINK_UPLOADS_PER_MINUTE = 3;

/**
 * An act as the page's forms post it: which button, and for a note its text,
 * its line breaks counted as one character as the form counts them,
 * normalized as it is stored (`normalizeFreeText`), trimmed, and within the
 * bound. Normalized before it is measured, so a note that is only invisible
 * characters, or one that NFKC lengthens past the bound, is refused here as
 * the form would, never past the service's own check.
 */
const actSchema = z.discriminatedUnion(WORK_ORDER_LINK_ACT_FIELD, [
  z.object({
    [WORK_ORDER_LINK_ACT_FIELD]: z.enum(["accept", "decline", "done"]),
  }),
  z.object({
    [WORK_ORDER_LINK_ACT_FIELD]: z.literal("note"),
    [WORK_ORDER_LINK_BODY_FIELD]: z
      .string()
      .transform((value) =>
        normalizeFreeText(value.replace(/\r\n?/g, "\n")).trim(),
      )
      .refine((value) => value !== "")
      .refine((value) => value.length <= WORK_ORDER_LIMITS.note),
  }),
]);

/** The token's path segment, matched on the token's form. */
const TOKEN_SEGMENT = `:token(^${WORK_ORDER_LINK_TOKEN_PATTERN}$)`;

/** Where a photograph is posted, below the token. */
const PHOTOS = `${TOKEN_SEGMENT}/${WORK_ORDER_LINK_PHOTO_SEGMENT}`;

/** What the page is told for each outcome of a photograph. */
const UPLOAD_NOTICE: Readonly<
  Record<Exclude<WorkOrderLinkUploadOutcome, "not-found">, WorkOrderLinkNotice>
> = {
  done: "photo-added",
  unchanged: "photo-added",
  limited: "photo-limited",
  full: "photo-full",
  refused: "photo-refused",
  "too-large": "photo-too-large",
  "too-many-pixels": "photo-too-large",
};

/**
 * The page a contractor's link opens, and what the contractor does there
 * (decision 24 of the issue module plan, ADR 0055): accept or decline the work
 * order, write a note, add a photograph, and mark it done.
 *
 * The third way to an issue without a session, beside the reporter's link,
 * standing in the site layer for the reason that one does: a server-rendered
 * page with plain forms, no script, no cookie, no JSON. Behind the legal gate's
 * switch (decision 25): with it off, every route here answers the one 404 every
 * dead link gets, and the upload reads nothing of its body.
 *
 * What holds here, each with a test:
 *
 * - **The token is the address and nothing else is.** It is read from the path
 *   alone. Beside it a request names at most a photograph, which the service
 *   resolves inside the token's grant.
 * - **Every refusal is one document**, byte for byte, whatever made it one: an
 *   unknown, malformed, expired, withdrawn, declined, done, ring-fenced or
 *   switched-off link, and a reporter's token here.
 * - **A read writes nothing**, and a GET to an action's address shows the page
 *   and does nothing else. Only a POST writes.
 * - **Every route has a budget per client address**, the GETs included, spent
 *   before the token is resolved.
 * - **A post from another origin is refused**, and so is any body that is not
 *   the form's own type.
 * - **The answers that end the link** (decline, done) are answered with a page
 *   of their own in the response rather than a redirect to the token's
 *   address, which from then on opens nothing.
 *
 * The headers every answer carries are set by a hook on the path
 * (`site-issue-link-headers.ts`). Nothing here logs the path, the token or
 * what was written.
 */
@Public()
@Controller(WORK_ORDER_LINK_PATH.slice(1))
export class SiteWorkOrderLinkController {
  private readonly origin: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly links: WorkOrderLinkService,
    private readonly renderer: SiteRenderer,
  ) {
    this.origin = new URL(env.APP_URL).origin;
  }

  /** The page. Reads, and writes nothing at all. */
  @Get(TOKEN_SEGMENT)
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_READS_PER_MINUTE })
  async page(
    @Param("token") token: string,
    @Query(WORK_ORDER_LINK_NOTICE_PARAM) notice: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.show(token, workOrderLinkNotice(notice), request, reply);
  }

  /**
   * The address a photograph is posted to, read with a GET: the page, and
   * nothing else (control E2).
   */
  @Get(PHOTOS)
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_READS_PER_MINUTE })
  async photosPage(
    @Param("token") token: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.show(token, null, request, reply);
  }

  /** One photograph inside the link's grant. Reads, and writes nothing. */
  @Get(`${PHOTOS}/:fileId`)
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_PHOTO_READS_PER_MINUTE })
  async photo(
    @Param("token") token: string,
    @Param("fileId") fileId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.links.photo(token, fileId);
    if (file === null) {
      await this.notFound(request, reply);
      return;
    }
    void reply
      .code(200)
      .headers({
        "content-type": file.contentType,
        "content-length": String(file.byteSize),
        "content-disposition": contentDisposition(file.fileName),
      })
      .send(file.stream);
  }

  /**
   * An answer or a note.
   *
   * Accepting and writing a note are answered with a 303 to the page, which
   * says what became of it in a fixed sentence and never repeats what was
   * written. Declining and done end the link, so they are answered with a page
   * of their own that carries no link back (control E6). A token that opens
   * nothing is answered with the one refusal, whatever the body was.
   */
  @Post(TOKEN_SEGMENT)
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_WRITES_PER_MINUTE })
  async act(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.isOwnForm(request, FORM_ENCODED)) {
      await this.notFound(request, reply);
      return;
    }

    const parsed = actSchema.safeParse(body);
    const refusal: WorkOrderLinkNotice | null = !parsed.success
      ? "refused"
      : parsed.data.act === "note" &&
          scanForPersonalIdentityNumbers(parsed.data.body).length > 0
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

    if (parsed.data.act === "note") {
      const outcome = await this.links.note(token, parsed.data.body);
      if (outcome === "not-found") {
        await this.notFound(request, reply);
        return;
      }
      this.answer(
        reply,
        token,
        outcome === "full"
          ? "note-full"
          : outcome === "limited"
            ? "note-limited"
            : "noted",
      );
      return;
    }

    const answer: WorkOrderLinkAnswer = parsed.data.act;
    const outcome = await this.links.answer(token, answer);
    if (outcome === "not-found") {
      await this.notFound(request, reply);
      return;
    }
    if (answer === "accept") {
      this.answer(reply, token, "accepted");
      return;
    }
    const html = await this.renderer.workOrderLinkEnded(
      acceptLanguage(request),
      answer === "decline" ? "declined" : "done",
    );
    void reply.code(200).header("content-type", HTML).send(html);
  }

  /**
   * A photograph. The token is resolved and the work order's room counted
   * before a byte of the body is read (control G1); a token that opens
   * nothing is refused with the multipart body unread.
   */
  @Post(PHOTOS)
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_UPLOADS_PER_MINUTE })
  async upload(
    @Param("token") token: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.isOwnForm(request, MULTIPART)) {
      await this.notFound(request, reply);
      return;
    }
    const outcome = await this.links.upload(token, async () => {
      try {
        const file = await readSingleFile(request);
        return file === null ? null : { bytes: file.bytes };
      } catch (error) {
        if (isTooLarge(error)) {
          return "too-large";
        }
        // A body the parser cannot read is not a photograph.
        return null;
      }
    });
    if (outcome === "not-found") {
      await this.notFound(request, reply);
      return;
    }
    this.answer(reply, token, UPLOAD_NOTICE[outcome]);
  }

  /**
   * A read of any other address below the link's path: the refusal every token
   * that opens nothing gets, on the same budget, so a value that is not shaped
   * like a token is answered as one that is (ADR 0055, "No enumeration").
   */
  @Get(":segment")
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_READS_PER_MINUTE })
  async malformed(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.notFound(request, reply);
  }

  /** The same, for a longer address below the link's path. */
  @Get(":segment/*")
  @PublicRateLimit({ perMinute: WORK_ORDER_LINK_READS_PER_MINUTE })
  async malformedBelow(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.notFound(request, reply);
  }

  private async show(
    token: string,
    notice: WorkOrderLinkNotice | null,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const view = await this.links.open(token);
    if (view === null) {
      await this.notFound(request, reply);
      return;
    }
    const html = await this.renderer.workOrderLink(
      acceptLanguage(request),
      view,
      notice,
      pagePath(token),
    );
    void reply.code(200).header("content-type", HTML).send(html);
  }

  /**
   * Whether a post is the page's own form: of the type the form sends, and sent
   * from this instance's page or with the `null` origin a page under
   * `Referrer-Policy: no-referrer` sends (control E5). There is no cookie here
   * for a forged post to ride on, so this is defence in depth: the token is
   * what stops one.
   */
  private isOwnForm(request: FastifyRequest, expected: string): boolean {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== "null" && origin !== this.origin) {
      return false;
    }
    const type = request.headers["content-type"] ?? "";
    return type.split(";", 1)[0]?.trim().toLowerCase() === expected;
  }

  /** Back to the page, which says what became of the act. */
  private answer(
    reply: FastifyReply,
    token: string,
    notice: WorkOrderLinkNotice,
  ): void {
    void reply
      .code(303)
      .header(
        "location",
        `${pagePath(token)}?${WORK_ORDER_LINK_NOTICE_PARAM}=${notice}`,
      )
      .send();
  }

  /** The one refusal, whatever made it one. */
  private async notFound(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const html = await this.renderer.workOrderLinkNotFound(
      acceptLanguage(request),
    );
    void reply.code(404).header("content-type", HTML).send(html);
  }
}

const HTML = "text/html; charset=utf-8";
const FORM_ENCODED = "application/x-www-form-urlencoded";
const MULTIPART = "multipart/form-data";

/**
 * The page's own address, from a token that has already opened it: the token
 * is base64url behind a fixed prefix, so it needs no escaping in a path.
 */
function pagePath(token: string): string {
  return `${WORK_ORDER_LINK_PATH}/${token}`;
}
