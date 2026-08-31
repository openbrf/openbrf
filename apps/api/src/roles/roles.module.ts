import { Module } from "@nestjs/common";

import { BoardPositionService } from "./board-position.service";
import {
  BoardPositionController,
  SystemRoleController,
} from "./role.controller";
import { SystemRoleService } from "./system-role.service";

/**
 * Conferring and revoking a role.
 *
 * One module and two controllers, because the two halves are answered by two
 * different people: a board seat is recorded by the board from the minutes of
 * the general meeting that elected it, and a system role is granted by an
 * administrator. Separate controllers rather than one with a branch inside it,
 * so the split is a property of the routes and the capability map rather than
 * of a check somebody has to remember to write.
 *
 * Deliberately not inside the address book. That module is the register of
 * people and where they live; this one decides what somebody may do with the
 * instance, and the two questions have different answers about who may write
 * them. What the address book keeps is the reading: the seats and grants a
 * person holds travel on its person payload, which is the panel these routes
 * are operated from.
 *
 * Deliberately not inside `src/board` either. That module is the roster as the
 * association publishes it - one query, no controller, and the website's only
 * reader - and putting a write path into it would put the register's writes
 * behind the seam that exists to keep the public site away from personal data.
 *
 * The database client and the audit log both come from global modules, which is
 * why nothing is imported here.
 */
@Module({
  controllers: [BoardPositionController, SystemRoleController],
  providers: [BoardPositionService, SystemRoleService],
  exports: [BoardPositionService, SystemRoleService],
})
export class RolesModule {}
