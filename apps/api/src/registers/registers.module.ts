import { Module } from "@nestjs/common";

import {
  ApartmentRegisterController,
  OwnApartmentRegisterController,
} from "./apartment-register.controller";
import { ApartmentRegisterService } from "./apartment-register.service";
import { InitialSupplyService } from "./initial-supply.service";
import { MemberRegisterController } from "./member-register.controller";
import { MemberRegisterService } from "./member-register.service";
import { RegisterReportMailerService } from "./register-report-mailer.service";
import {
  InitialSupplyController,
  RegisterReportController,
} from "./register-report.controller";
import { RegisterReportService } from "./register-report.service";

/**
 * The two statutory registers, and what the association owes the third.
 *
 * The registers live in one module because they are built from the same tables,
 * and in two services, two controllers and two screens because they are two
 * documents under two different rules: the member register (EFL 5 kap.) is
 * public on request and never carries a personal identity number, while the
 * apartment register (BRL 9 kap.) is confidential, carries one by statute, and
 * is open only to the board and to each tenant-owner for their own entry.
 *
 * Neither of them is the address book, which is the operational register the
 * board works in and has its own module.
 *
 * The duty towards the cooperative housing register sits here too, and splits
 * for the same kind of reason. The queue of outstanding duties carries apartment
 * designations and statutory dates and no personal data at all; the initial
 * supply carries every current holder's personal identity number.
 * `RegisterReportService` is deliberately not given the field encryption
 * service, so that separation is a fact about what the class can reach rather
 * than a promise about what it does.
 *
 * The notice that a reporting window has opened is provided and not exported.
 * Who is written to, and when, is this module's decision: it is sent by the
 * register write that opened the window, after that transaction has committed.
 */
@Module({
  controllers: [
    MemberRegisterController,
    ApartmentRegisterController,
    OwnApartmentRegisterController,
    RegisterReportController,
    InitialSupplyController,
  ],
  providers: [
    MemberRegisterService,
    ApartmentRegisterService,
    RegisterReportService,
    RegisterReportMailerService,
    InitialSupplyService,
  ],
  exports: [MemberRegisterService, ApartmentRegisterService],
})
export class RegistersModule {}
