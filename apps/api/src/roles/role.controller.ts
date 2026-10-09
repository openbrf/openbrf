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
import { calendarDateSchema } from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import { BoardPositionService } from "./board-position.service";
import type { BoardPositionView, SystemRoleGrantsView } from "./role-changes";
import { SystemRoleService } from "./system-role.service";

const electSchema = z.object({
  position: z.enum(["CHAIR", "BOARD_MEMBER", "DEPUTY_BOARD_MEMBER"]),
  electedOn: calendarDateSchema,
});

/**
 * A board recovery: the seats the meeting elected, and why the board is
 * recorded this way. The reason is kept in the audit log for good, so its
 * length is bounded here (AuditLogService, "What `context` may carry").
 */
const recoverBoardSchema = z.object({
  seats: z
    .array(electSchema.extend({ personId: z.string().min(1) }))
    .min(1)
    .max(30),
  reason: z.string().trim().min(1).max(500),
});

const endTermSchema = z.object({
  endedOn: calendarDateSchema,
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
 * rather than an administrator's appointment. A seat confers what no grant of
 * capabilities carries (ADR 0017), so an election and an end date are written
 * only for somebody who holds a seat today; the service decides that. A
 * register with no board at all is recorded through a board recovery, its own
 * act with a stated reason and its own audit entry.
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
   * Whether the register is vacant, so a screen knows to offer a board
   * recovery rather than an election that would be refused.
   */
  @Get("recovery")
  async recoveryState(): Promise<{ vacant: boolean }> {
    return { vacant: await this.positions.isVacant() };
  }

  /**
   * Records a board on a vacant register: no seat held today and none recorded
   * ahead. Never the caller's own seat, and never without a reason.
   *
   * Answers `board-not-vacant` once a board is recorded, whoever asks: from
   * then on the board records its own seats.
   */
  @Post("recovery")
  @HttpCode(201)
  async recoverBoard(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<BoardPositionView[]> {
    const input = recoverBoardSchema.parse(body);
    return this.positions.recoverBoard({
      seats: input.seats,
      reason: input.reason,
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Says when a term ends.
   *
   * A POST rather than a DELETE, because nothing is deleted: the row stays with
   * an end date on it. Who answered for the association between two dates is
   * exactly the question a board seat exists to answer, and a table that
   * removed the seat when the term ran out could no longer answer it.
   *
   * The same route writes the date of a term that already carries a future one,
   * which is how a mistyped year is corrected before it takes effect. A term
   * whose date has passed is settled and answers `term-already-ended`.
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
