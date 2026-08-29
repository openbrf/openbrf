import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { ContactService, type ContactSubmissionView } from "./contact.service";

const handledSchema = z.object({ handled: z.boolean() });

/**
 * The board's inbox for the website's contact form.
 *
 * Gated on signupRequest:decide rather than on a capability of its own. That is
 * a considered decision and not a shortcut: this is the second inbound public
 * queue on the instance, the circle that reads one is exactly the circle that
 * should read the other, and a sixteenth capability name whose grant list was
 * identical to an existing one's would be a name nobody could explain the
 * difference of.
 *
 * Every route here requires a session, which is what makes the class-level
 * capability the whole rule. The form that fills this queue is public and lives
 * on its own controller in the site module, for the reason the sign-up module
 * gives: one @Public() and one @RequireCapability() on the same class is the
 * mistake that opens a route rather than closing it.
 */
@Controller("api/contact-submissions")
@RequireCapability("signupRequest:decide")
export class ContactSubmissionController {
  constructor(private readonly contact: ContactService) {}

  @Get()
  async list(): Promise<ContactSubmissionView[]> {
    return this.contact.list();
  }

  @Put(":id/handled")
  async setHandled(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ContactSubmissionView> {
    const input = handledSchema.parse(body);
    return this.contact.setHandled({
      id,
      handled: input.handled,
      byPersonId: request.principal?.personId ?? "",
    });
  }

  /**
   * Removes a message the board is finished with.
   *
   * The one way these rows leave the instance. They are a stranger's name,
   * address and free text, and most senders are nobody the association holds a
   * record of - so the person-keyed purge cannot reach them and there is no
   * move-out date to count a retention period from. The board deleting what it
   * has answered is what bounds how long the association keeps them.
   */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.contact.remove(id);
  }
}
