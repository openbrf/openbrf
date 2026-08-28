import { Module } from "@nestjs/common";

import { StorageService } from "./storage.service";

/** File storage, behind one interface and two drivers. */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
