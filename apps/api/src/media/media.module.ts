import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { StoredFileEncryptionService } from "./stored-file-encryption.service";

/**
 * Uploaded files: stored through one interface, encrypted at rest, served from
 * this origin.
 *
 * The session and principal services the controller needs come from the global
 * auth and authorization modules, and the field encryption the stored files'
 * keys are wrapped with from the global crypto module, which is why none of
 * them is imported here.
 */
@Module({
  imports: [StorageModule],
  controllers: [MediaController],
  providers: [MediaService, StoredFileEncryptionService],
  exports: [MediaService],
})
export class MediaModule {}
