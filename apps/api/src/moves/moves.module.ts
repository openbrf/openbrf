import { Module } from "@nestjs/common";

import { RegistersModule } from "../registers/registers.module";
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
  /*
   * The apartment register, for the duty a move-in opens on its own. An
   * upplatelse is reported to the cooperative housing register on the day it
   * happened, so its deadline belongs to the transaction that records the
   * grant, and that ledger's writer lives there. The dependency runs one way:
   * the registers module knows nothing about moves.
   */
  imports: [RegistersModule],
  controllers: [MoveController],
  providers: [MoveService],
  exports: [MoveService],
})
export class MovesModule {}
