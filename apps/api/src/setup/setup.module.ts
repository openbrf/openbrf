import { Module } from "@nestjs/common";

import { DataProtectionModule } from "../data-protection/data-protection.module";
import { PagesModule } from "../site/pages.module";
import { SetupCompletionController, SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  // Finishing the wizard writes the association its first page, so the
  // instance's public address answers with something the moment it is
  // claimed. The pages sit in a module of their own precisely so this edge
  // can exist: the website reads the setup state, and a single site module
  // would make the two import each other.
  //
  // And its record of processing activities, for the same reason: a board that
  // finishes the wizard and opens the data protection screen should find the
  // record there rather than an empty list that fills itself in on the next
  // restart.
  imports: [PagesModule, DataProtectionModule],
  controllers: [SetupController, SetupCompletionController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
