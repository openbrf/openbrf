import { Module } from "@nestjs/common";

import { MoveController } from "./move.controller";
import { MoveService } from "./move.service";

/**
 * Move-in and move-out.
 *
 * The one place that creates and ends a residency, so that the statutory member
 * register is written by the same act that changes who lives here.
 *
 * The import writes its own residencies and register entries rather than
 * calling this service. Importing an existing member list is not a move-in:
 * nobody moved anywhere, and emailing two hundred residents "welcome to your
 * new home" because the board loaded a spreadsheet would be a bug with an
 * apology attached.
 */
@Module({
  controllers: [MoveController],
  providers: [MoveService],
  exports: [MoveService],
})
export class MovesModule {}
