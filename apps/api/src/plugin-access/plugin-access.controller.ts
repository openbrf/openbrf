import { Body, Controller, Get, Param, Patch, Req } from "@nestjs/common";
import { pluginIdSchema } from "@openbrf/plugin-sdk";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import type { GrantablePluginView, PluginAccessesView } from "./plugin-access";
import { PluginAccessService } from "./plugin-access.service";

const pluginAccessSchema = z.object({
  pluginId: pluginIdSchema,
  granted: z.boolean(),
});

/**
 * The board's plugin accesses (tilläggsåtkomst, ADR 0053), operated from the
 * person's page in the address book.
 *
 * `addressBook:write`, as every other change the board makes on that page.
 * The capability is in DENIED_ACTION_CAPABILITIES, so no action reaches these
 * routes, and they take a session's cookie and never a connected app's
 * token. A support session does not hold the capability (ADR 0028).
 */
@Controller("api/plugin-accesses")
@RequireCapability("addressBook:read", "addressBook:write")
export class PluginAccessController {
  constructor(private readonly accesses: PluginAccessService) {}

  /** The installed plugins an access can be granted to today. */
  @Get("plugins")
  async grantable(): Promise<{ plugins: GrantablePluginView[] }> {
    return { plugins: await this.accesses.grantable() };
  }

  /**
   * Grants or withdraws one access.
   *
   * One route for both directions, shaped as the system role it sits beside
   * on the person's page: the caller names the plugin and whether the access
   * is held, and the answer is every access the person holds afterwards. A
   * change that changes nothing writes nothing and answers the same way.
   */
  @Patch("persons/:personId")
  async setAccess(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ): Promise<PluginAccessesView> {
    const input = pluginAccessSchema.parse(body);
    const change = {
      personId,
      pluginId: input.pluginId,
      actorPersonId: actingPersonId(request),
    };
    return input.granted
      ? this.accesses.grant(change)
      : this.accesses.withdraw(change);
  }
}
