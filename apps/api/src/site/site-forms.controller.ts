import {
  type ArgumentMetadata,
  Body,
  Controller,
  Injectable,
  Logger,
  Param,
  type PipeTransform,
  Post,
  Req,
  Res,
  UsePipes,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";
import { z } from "zod";

import { Public } from "../authorization/public.decorator";
import {
  type BrokerUpdateRequestOutcome,
  BrokerUpdateRequestService,
} from "../broker-update-requests/broker-update-request.service";
import { ContactService } from "../contact/contact.service";
import { isApiRequest } from "../http/serve-single-page-app";
import { isHoneypotFilled } from "../http/honeypot";
import { PublicRateLimit } from "../http/public-rate-limit.decorator";
import { IssueError } from "../issues/issue.error";
import { IssueService } from "../issues/issue.service";
import { IssueTypeService } from "../issues/issue-type.service";
import { SetupService } from "../setup/setup.service";
import { hasBlock } from "./page-content";
import { PagesService, type SitePage } from "./pages.service";
import {
  BROKER_UPDATE_REQUEST_PATH,
  brokerUpdateRequestAnswerPath,
  type BrokerUpdateRequestState,
} from "./site-broker";
import {
  SITE_FORM_PATH,
  SITE_FORM_REFUSED_PARAM,
  SITE_FORM_SENT_PARAM,
  type SiteFormKind,
} from "./site-forms";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

/**
 * The three things anybody can write into this instance from the street: a
 * message to the board, a fault report, and a broker's request that the board
 * look at the facts on the broker information page again.
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
 *
 * The broker's form is the one that is not a block on a page the board wrote.
 * It stands on the generated broker page, at a fixed address, and is offered
 * only while the facts there are older than the board's threshold - which its
 * endpoint asks again rather than trusting the page.
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

/**
 * Five update requests a minute per client address.
 *
 * Tighter than the other two forms, because no resident sends this one: a
 * broker fills it in once per apartment, by hand. This is the one limit per
 * client address the form has, and it is kept in memory like every public
 * route's, because the address is stored nowhere (the data protection note on
 * the broker package). The limits that bound the queue for good are counted
 * in the database by the service.
 */
const UPDATE_REQUESTS_PER_MINUTE = 5;

/**
 * An optional field as a browser sends it.
 *
 * A form sends every field it has, and one left untouched arrives as the empty
 * string, never as an absent key. So a value that is blank once trimmed is
 * read as no value at all before the field's own rule sees it: otherwise an
 * address nobody typed would be refused as an address that is not one, and a
 * name nobody typed would be stored as a name that is the empty string.
 */
function optionalField<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, schema.optional());
}

const contactSchema = z.object({
  name: optionalField(z.string().max(100)),
  email: z.email().max(320),
  message: z
    .string()
    .max(4000)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
});

const issueSchema = z.object({
  type: z.string().min(1).max(64),
  location: optionalField(z.string().max(200)),
  description: z
    .string()
    .max(4000)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
  name: optionalField(z.string().max(100)),
  // Optional, and validated when it is there: a report from somebody who left
  // no address is still a report, but an address that is not one would be
  // stored as a way to answer them that does not work.
  email: optionalField(z.email().max(320)),
});

/**
 * No control characters on a one-line field.
 *
 * A name or a firm is read by a board member on a screen and copied into a
 * reply. A tab or an escape in it was put there by a script, never by a
 * broker typing into the form, and would be carried into whatever it is
 * pasted into next.
 */
const ONE_LINE = /^[^\p{Cc}]*$/u;

/**
 * An apartment as a broker writes it: "1101", "lgh 1101", "1101-2".
 *
 * Letters, digits, spaces and the separators a number is written with, and
 * nothing that could turn the board's list into something else.
 */
const APARTMENT_REFERENCE = /^[\p{L}\p{N} ./-]+$/u;

const noIdentityNumber = (value: string): boolean =>
  scanForPersonalIdentityNumbers(value).length === 0;

/**
 * Only the address is required, which is what the data protection note on the
 * broker package lists: it is how the board answers. A name, a firm, an
 * apartment and a note are the broker's to give or not, and no phone number is
 * asked for at all.
 *
 * A name, a firm, an apartment and a note are each refused when they hold a
 * personal identity number, as the broker page's own facts are: they are free
 * text from a public form, read by the board and kept for weeks, and the
 * apartment is copied into the notice mail to every board member, where the
 * purge cannot reach it. A seller's number pasted into any of them is the one
 * thing nobody should be keeping there.
 */
const brokerUpdateRequestSchema = z.object({
  name: optionalField(
    z.string().max(100).regex(ONE_LINE).refine(noIdentityNumber),
  ),
  email: z.email().max(320),
  brokerage: optionalField(
    z.string().max(100).regex(ONE_LINE).refine(noIdentityNumber),
  ),
  apartment: optionalField(
    z.string().max(20).regex(APARTMENT_REFERENCE).refine(noIdentityNumber),
  ),
  note: optionalField(z.string().max(280).refine(noIdentityNumber)),
});

/**
 * What the broker is told for each outcome.
 *
 * A duplicate is told exactly what a stored request is, and so is a request
 * that filled the decoy: see BrokerUpdateRequestService.
 */
const ANSWER_FOR: Readonly<
  Record<BrokerUpdateRequestOutcome, BrokerUpdateRequestState>
> = {
  stored: "sent",
  duplicate: "sent",
  current: "current",
  limited: "limited",
};

/**
 * Every submitted body with each line break as the one character the form
 * counted.
 *
 * The form's `maxlength` counts a line break in a text area as one character,
 * and the browser then submits it as CRLF, two. A message the form let
 * somebody finish could then be refused by the limit below it - and nothing
 * submitted is ever echoed back, so the text would be lost. Normalised before
 * any limit is checked, which also stores one line break the same way whatever
 * sent it.
 *
 * A pipe on the controller rather than a call in each handler, so a form added
 * to this controller later is read the same way without anybody remembering to.
 */
@Injectable()
export class LineBreaksAsOne implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    return metadata.type === "body" ? withLineBreaksAsOne(value) : value;
  }
}

function withLineBreaksAsOne(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }
  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value,
    ]),
  );
}

@Public()
@Controller()
@UsePipes(LineBreaksAsOne)
export class SiteFormsController {
  private readonly logger = new Logger(SiteFormsController.name);

  constructor(
    private readonly pages: PagesService,
    private readonly renderer: SiteRenderer,
    private readonly contact: ContactService,
    private readonly issues: IssueService,
    private readonly issueTypes: IssueTypeService,
    private readonly brokerUpdateRequests: BrokerUpdateRequestService,
    private readonly setup: SetupService,
  ) {}

  /**
   * A broker's request that the board look at the facts again.
   *
   * A fixed address rather than one below a page's slug, because the form
   * stands on the generated broker page. Static, so it outranks the slug
   * routes below whatever order they are declared in.
   */
  @Post(BROKER_UPDATE_REQUEST_PATH.slice(1))
  @PublicRateLimit({ perMinute: UPDATE_REQUESTS_PER_MINUTE })
  async brokerUpdateRequest(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (isHoneypotFilled(body)) {
      // Answered as a stored request is, before anything about the
      // association is read: see the contact form.
      this.logger.log(
        "Dropped a broker update request that filled the honeypot.",
      );
      this.answerUpdateRequest(reply, "sent");
      return;
    }

    // An instance nobody has claimed has no broker page to have sent this
    // from, and answers as the page itself does.
    if ((await this.setup.state()).setupRequired) {
      await this.sendNotFound(request, reply);
      return;
    }

    const parsed = brokerUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.answerUpdateRequest(reply, "refused");
      return;
    }

    const { name, email, brokerage, apartment, note } = parsed.data;
    const outcome = await this.brokerUpdateRequests.submit({
      email,
      ...(name === undefined ? {} : { name }),
      ...(brokerage === undefined ? {} : { brokerage }),
      ...(apartment === undefined ? {} : { apartmentReference: apartment }),
      ...(note === undefined ? {} : { note }),
    });
    this.answerUpdateRequest(reply, ANSWER_FOR[outcome]);
  }

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
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
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
   * Back to the broker page, which will say what became of the request.
   *
   * Always the page's Swedish address, whichever one the form was read at,
   * and never one the request named - the reason redirect() below gives.
   */
  private answerUpdateRequest(
    reply: FastifyReply,
    state: BrokerUpdateRequestState,
  ): void {
    void reply
      .code(303)
      .headers(SITE_HTML_HEADERS)
      .header("location", brokerUpdateRequestAnswerPath(state))
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
