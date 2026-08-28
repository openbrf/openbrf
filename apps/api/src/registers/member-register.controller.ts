import { Controller, Get, Query, Req } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type MemberRegisterExtract,
  MemberRegisterService,
} from "./member-register.service";
import { actingPersonId } from "./acting-person";

const querySchema = z.object({
  /** "current" is the list of members today; "all" adds ended memberships. */
  scope: z.enum(["current", "all"]).default("current"),
});

/**
 * The member register (medlemsforteckning, EFL 5 kap. via BRL 9 kap.).
 *
 * Its own controller with its own path and its own capability. The apartment
 * register is reached through a different controller entirely: the plan
 * requires the two registers to share no screen and no endpoint, because the
 * member register extract is public on request while the apartment register is
 * confidential, and one endpoint serving both is one mistake away from handing
 * out the wrong one.
 *
 * Nothing here accepts a parameter that would add a personal identity number.
 * The register does not contain one.
 */
@Controller("api/member-register")
@RequireCapability("memberRegister:read")
export class MemberRegisterController {
  constructor(private readonly register: MemberRegisterService) {}

  @Get()
  async extract(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<MemberRegisterExtract> {
    const { scope } = querySchema.parse(query);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      scope,
    });
  }
}
