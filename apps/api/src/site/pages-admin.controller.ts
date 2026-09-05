import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError, MediaService } from "../media/media.service";
import { submittedContent, submittedContentSchema } from "./page-content";
import { type PageAdminView, PagesWriteService } from "./pages-write.service";
import { acceptLanguage } from "./site-request";
import { SiteRenderer } from "./site-renderer.service";

/**
 * The board's own screen for the association's website, over HTTP.
 *
 * Every route needs site:manage, declared on the class so a route added later
 * inherits the restriction instead of being open by omission. This controller
 * and the public one are deliberately separate classes: the website is
 * @Public() in the strongest sense - no route there reads a capability and none
 * of them can - and mixing the two on one class is how that stops being true.
 *
 * The visibility and publication routes are their own, rather than fields on
 * the ordinary save. They are what decides who may read a page, they are what
 * the audit log records, and a second way to set them through the save would be
 * a second way for that record to be missed.
 */

const contentSchema = submittedContentSchema;

const createSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  content: contentSchema,
  visibility: z.enum(["PUBLIC", "MEMBER"]),
});

const updateSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  content: contentSchema,
  photoConsentConfirmed: z.boolean().optional(),
  /*
   * The page's revision as the caller last read it. A save is the whole page,
   * so a second writer who read it earlier would put their copy over the first
   * one's work and neither would be told. Optional, because a caller that does
   * not send it is asking for the behaviour this endpoint has always had.
   */
  expectedRevision: z.int().nonnegative().optional(),
});

const publishSchema = z.object({
  published: z.boolean(),
  photoConsentConfirmed: z.boolean().optional(),
});

const visibilitySchema = z.object({
  visibility: z.enum(["PUBLIC", "MEMBER"]),
  photoConsentConfirmed: z.boolean().optional(),
});

const reorderSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).max(500),
});

const previewSchema = z.object({
  slug: z.string().trim().max(80).optional(),
  title: z.string().trim().max(200),
  content: contentSchema,
});

/** Whether an uploaded picture shows people who can be recognised in it. */
const imageFieldsSchema = z.object({
  showsIdentifiablePersons: z.enum(["true", "false"]),
});

/**
 * The acting person, or a fault.
 *
 * The global guard attaches a principal to every non-public route or rejects
 * it, so reaching this throw means the guard stopped doing that, and a 500
 * naming the guard is the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal) {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

@Controller("api/site/pages")
@RequireCapability("site:manage")
export class PagesAdminController {
  constructor(
    private readonly pages: PagesWriteService,
    private readonly renderer: SiteRenderer,
  ) {}

  @Get()
  async list(): Promise<PageAdminView[]> {
    return this.pages.list();
  }

  @Post()
  async create(@Body() body: unknown): Promise<PageAdminView> {
    const input = createSchema.parse(body);
    return this.pages.create({
      slug: input.slug,
      title: input.title,
      content: submittedContent(input.content),
      visibility: input.visibility,
    });
  }

  /**
   * What the page would look like on the website, rendered by the website.
   *
   * The same function that answers a visitor, given the draft rather than the
   * stored row, so the board is shown the real thing: the real theme, the real
   * stylesheet, and a body that has been through the same parser. A preview
   * assembled in the browser would be a second renderer to keep in step, and
   * the first time the two disagreed the board would be publishing what it had
   * not seen.
   *
   * It writes nothing. Declared above the parameter routes so the word
   * "preview" is never read as a page's id.
   */
  @Post("preview")
  async preview(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ html: string }> {
    const input = previewSchema.parse(body);
    const html = await this.renderer.page(
      acceptLanguage(request),
      {
        slug: input.slug ?? "",
        title: input.title,
        content: submittedContent(input.content),
        // The draft as an anonymous reader would get it, whatever visibility
        // it is going to be given. A preview of a public website that hid the
        // parts only the public sees - a form, above all - would be a preview
        // of something else.
        publiclyReadable: true,
      },
      /*
       * The same answer about the visitor rather than about the page: shown as
       * the widest audience would see it, though the board member looking at
       * it is signed in. A preview exists to answer "what am I publishing",
       * and neither the menu entries a session adds nor the members' news a
       * teaser block would pull in are part of that answer: what the board
       * needs to see before publishing is what the street will get, not the
       * fuller version its own session would produce. A document list on the
       * draft is previewed the same way and shows the public shelf: a board
       * member reading their own page must not be shown the members' documents
       * on it and take that for what a visitor gets.
       */
      { hasSession: false, personId: null },
    );
    return { html };
  }

  /** Puts the pages in the order the ids arrive in. */
  @Post("order")
  async reorder(@Body() body: unknown): Promise<PageAdminView[]> {
    return this.pages.reorder(reorderSchema.parse(body).ids);
  }

  @Get(":id")
  async byId(@Param("id") id: string): Promise<PageAdminView> {
    return this.pages.byId(id);
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<PageAdminView> {
    const input = updateSchema.parse(body);
    return this.pages.update(id, {
      slug: input.slug,
      title: input.title,
      content: submittedContent(input.content),
      ...(input.photoConsentConfirmed === undefined
        ? {}
        : { photoConsentConfirmed: input.photoConsentConfirmed }),
      ...(input.expectedRevision === undefined
        ? {}
        : { expectedRevision: input.expectedRevision }),
    });
  }

  @Post(":id/publish")
  async publish(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PageAdminView> {
    const input = publishSchema.parse(body);
    return this.pages.setPublished(id, {
      ...input,
      actorPersonId: requirePrincipal(request).personId,
    });
  }

  @Post(":id/visibility")
  async visibility(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PageAdminView> {
    const input = visibilitySchema.parse(body);
    return this.pages.setVisibility(id, {
      ...input,
      actorPersonId: requirePrincipal(request).personId,
    });
  }

  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.pages.remove(id, requirePrincipal(request).personId);
  }
}

/**
 * Pictures for the website.
 *
 * Stored public, because a picture placed on a page is published material and
 * the page it sits on is what decides who reads it. That is stated to the board
 * on the screen rather than left implied, and it is why the publication
 * guardrail asks for the consent confirmation on any published page rather than
 * only a public one.
 *
 * A declaration of whether the picture shows identifiable persons is required
 * by the media layer, and it is the input the guardrail acts on: an image
 * nobody has declared cannot be checked against a publication consent at all.
 */
@Controller("api/site/images")
@RequireCapability("site:manage")
export class SiteImagesController {
  constructor(private readonly media: MediaService) {}

  @Post()
  async upload(
    @Req() request: RequestWithPrincipal,
  ): Promise<{ id: string; url: string; showsIdentifiablePersons: boolean }> {
    const principal = requirePrincipal(request);

    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });

    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }

    const fields = imageFieldsSchema.parse(file.fields);
    const showsIdentifiablePersons = fields.showsIdentifiablePersons === "true";

    const stored = await this.media.upload({
      bytes: file.bytes,
      fileName: file.fileName,
      visibility: "PUBLIC",
      showsIdentifiablePersons,
      uploadedByPersonId: principal.personId,
      prefix: "media",
    });

    return {
      id: stored.id,
      url: stored.url,
      showsIdentifiablePersons,
    };
  }
}
