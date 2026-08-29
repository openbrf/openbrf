import { Module } from "@nestjs/common";

import { PagesModule } from "../site/pages.module";
import { SetupCompletionController, SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  // Finishing the wizard writes the association its first page, so the
  // instance's public address answers with something the moment it is
  // claimed. The pages sit in a module of their own precisely so this edge
  // can exist: the website reads the setup state, and a single site module
  // would make the two import each other.
  imports: [PagesModule],
  controllers: [SetupController, SetupCompletionController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
