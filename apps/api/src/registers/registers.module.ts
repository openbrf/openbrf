import { Module } from "@nestjs/common";

import {
  ApartmentRegisterController,
  OwnApartmentRegisterController,
} from "./apartment-register.controller";
import { ApartmentRegisterService } from "./apartment-register.service";
import { MemberRegisterController } from "./member-register.controller";
import { MemberRegisterService } from "./member-register.service";

/**
 * The two statutory registers.
 *
 * They live in one module because they are built from the same tables, and in
 * two services, two controllers and two screens because they are two documents
 * under two different rules: the member register (EFL 5 kap.) is public on
 * request and never carries a personal identity number, while the apartment
 * register (BRL 9 kap.) is confidential, carries one by statute, and is open
 * only to the board and to each tenant-owner for their own entry.
 *
 * Neither of them is the address book, which is the operational register the
 * board works in and has its own module.
 */
@Module({
  controllers: [
    MemberRegisterController,
    ApartmentRegisterController,
    OwnApartmentRegisterController,
  ],
  providers: [MemberRegisterService, ApartmentRegisterService],
  exports: [MemberRegisterService, ApartmentRegisterService],
})
export class RegistersModule {}
