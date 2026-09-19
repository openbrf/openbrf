import { Module } from "@nestjs/common";

import { ChargesModule } from "../charges/charges.module";
import { AccountingBasisService } from "./accounting-basis.service";
import { AccountingController } from "./accounting.controller";

/**
 * The accounting basis (bokforingsunderlag): what the association billed and
 * charged in a period, as one file for whoever keeps its books.
 *
 * A module of its own rather than a route on the fees module or on the charges
 * module, because it is the only thing in this product that reads both. Putting
 * it in either would put one module's vocabulary inside the other - which the
 * fees module's own comment refuses - and would leave a board member looking
 * for the file on whichever screen the decision had gone against.
 *
 * It owns no table and no purge. Every row it writes is read from rows another
 * module recorded and another module erases, which is what makes the export a
 * disclosure rather than a store: the file exists for as long as it takes to
 * download and the audit entry is the only trace of it the instance keeps.
 *
 * `ChargesModule` is imported for `MemberChargeService`, so the debiting list's
 * masking rule is applied by the module that owns it rather than restated here.
 * The fee notices are read directly, because the fee half of this file names
 * nobody and so has no masking to share. The database, the audit log and the
 * principal the controller reads come from global modules.
 */
@Module({
  imports: [ChargesModule],
  controllers: [AccountingController],
  providers: [AccountingBasisService],
})
export class AccountingModule {}
