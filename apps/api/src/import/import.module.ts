import { Module } from "@nestjs/common";

import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

/**
 * The one-time import of an existing member list.
 *
 * Recurring, differential import is a paid module (Import Pro) and is not this:
 * what ships here loads a list once, with a mapping the board confirms and a
 * preview it approves.
 */
@Module({
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
