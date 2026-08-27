import { Module } from "@nestjs/common";

import {
  AddressBookController,
  ResidentDirectoryController,
} from "./address-book.controller";
import { AddressBookService } from "./address-book.service";
import { PersonService } from "./person.service";

/**
 * The address book: the register the board works in, and the resident-facing
 * view of it.
 *
 * Deliberately does not contain the member register or the apartment register.
 * Those are separate statutory documents (EFL 5 kap. and BRL 9 kap.) with their
 * own field lists, their own access rules and their own views, and blending them
 * into this module is the mistake the two-tier model exists to prevent.
 */
@Module({
  controllers: [AddressBookController, ResidentDirectoryController],
  providers: [AddressBookService, PersonService],
  exports: [AddressBookService, PersonService],
})
export class AddressBookModule {}
