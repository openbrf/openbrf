import { Module } from "@nestjs/common";

import { BoardRosterService } from "./board-roster.service";

/**
 * The association's board, as the association publishes it.
 *
 * One service and no controller. Nothing in the application reads the roster
 * yet - the board's own screens read the register, where the seats are entered
 * and where the publication consents are recorded - and the website is its
 * only reader. It is a module of its own rather than part of either, because
 * it is the seam: the public website may not reach the address book, and this
 * is the one shape of that data the association has decided to publish.
 *
 * The database client comes from the global module, which is why nothing is
 * imported here.
 */
@Module({
  providers: [BoardRosterService],
  exports: [BoardRosterService],
})
export class BoardModule {}
