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
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { submittedContent, submittedContentSchema } from "../site/page-content";
import {
  type NewsAdminView,
  NewsWriteService,
  type PublishNewsResult,
} from "./news-write.service";

/**
 * The board's own screen for the association's news, over HTTP.
 *
 * Every route needs site:manage, declared on the class so a route added later
 * inherits the restriction instead of being open by omission. Writing news is
 * publishing in the cooperative's name, which is the same act the pages
 * capability describes, and a sixteenth capability with an identical grant list
 * would only be a second name for one job.
 *
 * The publish route is its own. It is what decides who may read an item, it is
 * what puts the mailing in the queue, and it is what the audit log records - so
 * a second way to reach any of that through the ordinary save would be a second
 * way for the record to be missed and, worse, a way for a correction to
 * mail the members again.
 */

const bodySchema = z.object({
  slug: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  content: submittedContentSchema,
});

const publishSchema = z.object({
  published: z.boolean(),
  visibility: z.enum(["PUBLIC", "MEMBER"]).optional(),
  sendEmail: z.boolean().optional(),
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

@Controller("api/news")
@RequireCapability("site:manage")
export class NewsAdminController {
  constructor(private readonly news: NewsWriteService) {}

  @Get()
  async list(): Promise<NewsAdminView[]> {
    return this.news.list();
  }

  /**
   * How many members a mailing would reach.
   *
   * Its own route, declared above the parameter route so "recipients" is never
   * read as an item's id. A count and not a list: who the members are is the
   * register's answer to give, under the register's own capability.
   */
  @Get("recipients")
  async recipients(): Promise<{ count: number }> {
    return { count: await this.news.recipientCount() };
  }

  @Post()
  async create(@Body() body: unknown): Promise<NewsAdminView> {
    const input = bodySchema.parse(body);
    return this.news.create({
      slug: input.slug,
      title: input.title,
      content: submittedContent(input.content),
    });
  }

  @Get(":id")
  async byId(@Param("id") id: string): Promise<NewsAdminView> {
    return this.news.byId(id);
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<NewsAdminView> {
    const input = bodySchema.parse(body);
    return this.news.update(id, {
      slug: input.slug,
      title: input.title,
      content: submittedContent(input.content),
    });
  }

  @Post(":id/publish")
  async publish(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PublishNewsResult> {
    const input = publishSchema.parse(body);
    return this.news.publish(id, {
      ...input,
      actorPersonId: requirePrincipal(request).personId,
    });
  }

  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.news.remove(id, requirePrincipal(request).personId);
  }
}
