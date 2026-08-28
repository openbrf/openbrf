import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

/**
 * Uploaded files: stored through one interface, served from this origin.
 *
 * The session and principal services the controller needs come from the global
 * auth and authorization modules, which is why they are not imported here.
 */
@Module({
  imports: [StorageModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
