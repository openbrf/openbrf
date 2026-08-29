import {
  Body,
  Controller,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import { ContactService } from "../contact/contact.service";
import { isApiRequest } from "../http/serve-single-page-app";
import { isHoneypotFilled } from "../http/honeypot";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { IssueError } from "../issues/issue.error";
import { IssueService } from "../issues/issue.service";
import { IssueTypeService } from "../issues/issue-type.service";
import { hasBlock } from "./page-content";
import { PagesService, type SitePage } from "./pages.service";
import {
  SITE_FORM_PATH,
  SITE_FORM_REFUSED_PARAM,
  SITE_FORM_SENT_PARAM,
  type SiteFormKind,
} from "./site-forms";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

/**
 * The two things anybody can write into this instance from the street.
 *
 * A separate class from the site controller, and a separate one again from the
 * board's inbox, because the three have different rules and a class is where a
 * rule belongs: everything here is @Public() and everything in the inbox needs
 * a capability. The sign-up module split for the same reason.
 *
 * The whole exchange is HTML and nothing else. A form posts to the page it was
 * read on, the endpoint answers 303 to that page with a query naming what
 * happened, and the page renders a confirmation. No JavaScript, no cookie, no
 * JSON, no state carried between the two requests. That is what makes the
 * association's website usable by somebody with scripting switched off - and it
 * is also the only design that could work under a content policy that names no
 * script source at all.
 *
 * Four properties are enforced here and each has a test:
 *
 *   The page is resolved as an ANONYMOUS visitor, whatever the request carries.
 *   A member-only page's form therefore answers exactly as a page that was
 *   never written does, so no submission can be used to find out which pages
 *   the association has. It also means no session is ever read on a write, so
 *   nothing on this path can set a cookie.
 *
 *   A form posted to a page that does not carry it is the same refusal. The
 *   block on the page is the permission.
 *
 *   The decoy is checked before the association's own settings are read, so a
 *   script that fell for it learns nothing at all - not even whether this
 *   cooperative takes reports from the public.
 *
 *   Nothing submitted is ever echoed back. The answer is a redirect, and the
 *   page it redirects to renders a fixed translated sentence. There is no path
 *   by which what somebody typed reaches a browser.
 *
 * This is the one file in src/site that calls services which encrypt. What it
 * hands them is a stranger's own name and address, typed a moment ago into a
 * form on this page - never anything read from the association's registers,
 * which this directory still cannot reach at all (site-boundary.spec.ts).
 */

/**
 * Twenty submissions a minute per client address, per form.
 *
 * The same number as the sign-up form and generous for the same reason: one
 * address is a household, an office or a whole building behind one line, and
 * turning a resident away is a worse failure than a script taking a minute
 * longer. It still bounds what a script can put in the board's queue, which is
 * the point - every entry there is read by a person.
 */
const SUBMISSIONS_PER_MINUTE = 20;

const contactSchema = z.object({
  // Trimmed and dropped when empty, so an untouched optional field is stored as
  // nothing rather than as a name that is the empty string.
  name: z
    .string()
    .max(100)
    .transform((value) => value.trim())
    .optional(),
  email: z.email().max(320),
  message: z
    .string()
    .max(4000)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
});

const issueSchema = z.object({
  type: z.string().min(1).max(64),
  location: z
    .string()
    .max(200)
    .transform((value) => value.trim())
    .optional(),
  description: z
    .string()
    .max(4000)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
  name: z
    .string()
    .max(100)
    .transform((value) => value.trim())
    .optional(),
  // Optional, and validated when it is there: a report from somebody who left
  // no address is still a report, but an address that is not one would be
  // stored as a way to answer them that does not work.
  email: z.email().max(320).optional(),
});

@Public()
@Controller()
export class SiteFormsController {
  private readonly logger = new Logger(SiteFormsController.name);

  constructor(
    private readonly pages: PagesService,
    private readonly renderer: SiteRenderer,
    private readonly contact: ContactService,
    private readonly issues: IssueService,
    private readonly issueTypes: IssueTypeService,
  ) {}

  /** A message to the board. */
  @Post(`:slug/${SITE_FORM_PATH.contact}`)
  @PublicRateLimit({ perMinute: SUBMISSIONS_PER_MINUTE })
  async contactForm(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (this.isApiPath(request)) {
      void reply.code(404).send({ reason: "not-found" });
      return;
    }

    const page = await this.pageCarrying(slug, "contactForm");
    if (page === null) {
      await this.sendNotFound(request, reply);
      return;
    }

    if (isHoneypotFilled(body)) {
      /*
       * Dropped, and answered exactly as a stored message is: the same status,
       * the same address, the same confirmation on the page it lands on. A
       * script learns nothing about which field gave it away. There is no
       * identifier to make identical here, unlike the sign-up form's answer -
       * a redirect carries nothing back but the address it points at.
       *
       * Logged without a word of what was submitted. This line is the only
       * trace a dropped message leaves, and if the decoy ever catches a real
       * person it is how that gets noticed.
       */
      this.logger.log("Dropped a contact message that filled the honeypot.");
      this.sent(reply, page, "contact");
      return;
    }

    // The schema does not name the decoy, so it is stripped here along with
    // anything else that was sent and not asked for.
    const parsed = contactSchema.safeParse(body);
    if (!parsed.success) {
      this.refused(reply, page, "contact");
      return;
    }

    await this.contact.submit({
      ...(parsed.data.name === undefined || parsed.data.name === ""
        ? {}
        : { name: parsed.data.name }),
      email: parsed.data.email,
      message: parsed.data.message,
    });
    this.sent(reply, page, "contact");
  }

  /** A fault reported by somebody with no account. */
  @Post(`:slug/${SITE_FORM_PATH.issue}`)
  @PublicRateLimit({ perMinute: SUBMISSIONS_PER_MINUTE })
  async issueForm(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (this.isApiPath(request)) {
      void reply.code(404).send({ reason: "not-found" });
      return;
    }

    const page = await this.pageCarrying(slug, "issueReportForm");
    if (page === null) {
      await this.sendNotFound(request, reply);
      return;
    }

    if (isHoneypotFilled(body)) {
      this.logger.log("Dropped an issue report that filled the honeypot.");
      this.sent(reply, page, "issue");
      return;
    }

    /*
     * The board's switch, read after the decoy and before anything else.
     *
     * After, so a script that fell for the decoy cannot learn from the answer
     * whether this cooperative takes reports from the public. Before the body
     * is read, because a closed form does not exist: the answer is the
     * website's own not-found document, byte for byte what a page that was
     * never written gets, so the block being absent from the page and the
     * endpoint being absent from the instance are the same fact seen twice.
     */
    if (!(await this.issueTypes.publicReportingEnabled())) {
      await this.sendNotFound(request, reply);
      return;
    }

    const parsed = issueSchema.safeParse(body);
    if (!parsed.success) {
      this.refused(reply, page, "issue");
      return;
    }

    try {
      await this.issues.reportPublicly({
        typeId: parsed.data.type,
        location: parsed.data.location ?? null,
        description: parsed.data.description,
        reporterName: parsed.data.name ?? null,
        reporterEmail: parsed.data.email ?? null,
      });
    } catch (error) {
      if (error instanceof IssueError) {
        // A type the form never offered, or a switch turned off in the moment
        // between the check above and this call. Either way the reporter is
        // told the form could not read what they sent, and nothing about the
        // association's internal categories travels back with it.
        this.refused(reply, page, "issue");
        return;
      }
      throw error;
    }

    this.sent(reply, page, "issue");
  }

  /**
   * The page a submission may be accepted for, or nothing.
   *
   * Resolved with no session at all, which is deliberate and is what keeps the
   * three ways of being refused - no such page, not published, not public -
   * indistinguishable from a fourth: a page that simply does not carry this
   * form.
   */
  private async pageCarrying(
    slug: string,
    block: "contactForm" | "issueReportForm",
  ): Promise<SitePage | null> {
    const page = await this.pages.bySlug(slug, false);
    return page !== null && hasBlock(page.content, block) ? page : null;
  }

  /**
   * Whether this path belongs to the API rather than to a page.
   *
   * Two static segments outrank a parameter and a static one, so an API route
   * of its own always wins - but "/api/kontakt" names no route, and without
   * this it would reach the parameter route here and be answered with the
   * website's HTML. It belongs to the API's JSON 404, exactly as "/api" does on
   * the page route beside this one.
   */
  private isApiPath(request: FastifyRequest): boolean {
    return isApiRequest(request.url);
  }

  /** Back to the page, which will show the confirmation. */
  private sent(reply: FastifyReply, page: SitePage, kind: SiteFormKind): void {
    this.redirect(reply, page, SITE_FORM_SENT_PARAM, kind);
  }

  /** Back to the page, which will say the form could not read the submission. */
  private refused(
    reply: FastifyReply,
    page: SitePage,
    kind: SiteFormKind,
  ): void {
    this.redirect(reply, page, SITE_FORM_REFUSED_PARAM, kind);
  }

  /**
   * The 303 that turns a submission into a page the visitor can reload.
   *
   * 303 rather than 302, because the point is that the browser follows it with
   * a GET: the visitor lands on an address that is theirs to bookmark, reload
   * and go back to without the browser offering to send the form again.
   *
   * The target is built from the page this endpoint just resolved, never from
   * anything the request said. That is what stops the confirmation becoming a
   * way to have this instance redirect somewhere of the caller's choosing.
   *
   * It carries the website's own headers. There is no body to protect, but
   * `no-cache` on a redirect is not decoration - a cached 303 would send the
   * next visitor to somebody else's confirmation - and having one set of
   * headers on every answer from this origin is one fewer thing to keep in
   * step.
   */
  private redirect(
    reply: FastifyReply,
    page: SitePage,
    param: string,
    kind: SiteFormKind,
  ): void {
    const target = `/${page.slug}?${param}=${SITE_FORM_PATH[kind]}`;
    void reply
      .code(303)
      .headers(SITE_HTML_HEADERS)
      .header("location", target)
      .send();
  }

  /**
   * The website's own not-found document.
   *
   * The same three things the site controller does - the same renderer, the
   * same headers, the same status - because the two answers have to be
   * identical and a visitor probing this endpoint must learn exactly as much as
   * one probing the page itself. That they are two pieces of code saying it is
   * held by an integration test comparing the bodies, not by this comment.
   */
  private async sendNotFound(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const acceptLanguage = request.headers["accept-language"];
    const html = await this.renderer.notFound(
      typeof acceptLanguage === "string" ? acceptLanguage : undefined,
    );
    void reply.code(404).headers(SITE_HTML_HEADERS).send(html);
  }
}
