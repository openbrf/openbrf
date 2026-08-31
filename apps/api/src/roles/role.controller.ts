import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import { BoardPositionService } from "./board-position.service";
import type { BoardPositionView, SystemRoleGrantsView } from "./role-changes";
import { SystemRoleService } from "./system-role.service";

/** ISO calendar date. A register date is never guessed from free text. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const electSchema = z.object({
  position: z.enum(["CHAIR", "BOARD_MEMBER", "DEPUTY_BOARD_MEMBER"]),
  electedOn: isoDate,
});

const endTermSchema = z.object({
  endedOn: isoDate,
});

const systemRoleSchema = z.object({
  role: z.enum(["ADMIN", "PROPERTY_MANAGER"]),
  granted: z.boolean(),
});

/**
 * Positions of trust on the board.
 *
 * Gated on `boardPosition:manage`, which the board holds and an administrator
 * holds with everything else. A board is elected by the general meeting
 * (foreningsstamma), so recording who sits on it is the board's own minute
 * rather than an administrator's appointment - and the seat it writes carries
 * no capability the person writing it does not already hold, so it cannot be
 * used to climb.
 *
 * The seats a person holds also travel on the address book's person payload,
 * which is what the panel renders; this controller is what changes them.
 */
@Controller("api/board-positions")
@RequireCapability("boardPosition:manage")
export class BoardPositionController {
  constructor(private readonly positions: BoardPositionService) {}

  @Get("persons/:personId")
  async forPerson(
    @Param("personId") personId: string,
  ): Promise<BoardPositionView[]> {
    return this.positions.forPerson(personId);
  }

  @Post("persons/:personId")
  @HttpCode(201)
  async elect(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ): Promise<BoardPositionView> {
    const input = electSchema.parse(body);
    return this.positions.elect({
      personId,
      position: input.position,
      electedOn: input.electedOn,
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Ends a term.
   *
   * A POST rather than a DELETE, because nothing is deleted: the row stays with
   * an end date on it. Who answered for the association between two dates is
   * exactly the question a board seat exists to answer, and a register that
   * removed the seat when the term ran out could no longer answer it.
   */
  @Post(":boardPositionId/end")
  @HttpCode(200)
  async endTerm(
    @Req() request: RequestWithPrincipal,
    @Param("boardPositionId") boardPositionId: string,
    @Body() body: unknown,
  ): Promise<BoardPositionView> {
    const input = endTermSchema.parse(body);
    return this.positions.endTerm({
      boardPositionId,
      endedOn: input.endedOn,
      actorPersonId: actingPersonId(request),
    });
  }
}

/**
 * The administrator grant and the external property manager grant.
 *
 * Gated on `systemRole:manage`, which only an administrator holds. That is the
 * decision this feature turns on and it is enforced here and in the capability
 * map, nowhere else: the board holds no capability that reaches this
 * controller, so a board seat is not a way to grant oneself administrator
 * rights. The guarantee is that there is no route by which a board member can
 * write a `system_role` row, rather than a branch inside one that inspects
 * which role is being asked for.
 *
 * `capabilities.ts` carries the argument for why the property manager grant
 * sits on this side of the line with the administrator grant, although what it
 * confers is a subset of what the board already holds.
 */
@Controller("api/system-roles")
@RequireCapability("systemRole:manage")
export class SystemRoleController {
  constructor(private readonly roles: SystemRoleService) {}

  @Get("persons/:personId")
  async forPerson(
    @Param("personId") personId: string,
  ): Promise<SystemRoleGrantsView> {
    return this.roles.forPerson(personId);
  }

  /**
   * Grants or revokes one role.
   *
   * One route for both directions, shaped like the publication consent it sits
   * beside on the same panel: the caller says which role and whether it is
   * held, and the answer is every role the person holds afterwards. A grant
   * that changes nothing writes nothing and answers the same way, so a second
   * press is not an error and does not pad the audit log.
   */
  @Patch("persons/:personId")
  async setRole(
    @Req() request: RequestWithPrincipal,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ): Promise<SystemRoleGrantsView> {
    const input = systemRoleSchema.parse(body);
    return this.roles.setRole({
      personId,
      role: input.role,
      granted: input.granted,
      actorPersonId: actingPersonId(request),
    });
  }
}
