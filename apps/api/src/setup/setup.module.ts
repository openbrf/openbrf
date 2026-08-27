import { Module } from "@nestjs/common";

import { SetupCompletionController, SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

@Module({
  controllers: [SetupController, SetupCompletionController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
