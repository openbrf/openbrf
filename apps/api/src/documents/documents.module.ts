import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import {
  DocumentArchiveController,
  DocumentShelfController,
} from "./documents.controller";
import { DocumentsService } from "./documents.service";

/**
 * The association's document archive.
 *
 * Imports the media module because the bytes are a media file: the archive
 * owns what a document is and who it is for, and the media layer owns storing
 * it, identifying it and serving it. The database client and the audit log
 * come from the global modules, which is why they are not imported here.
 *
 * The shelf controller is registered first so the reading route is declared
 * before the writing one, which is the order the two are read in.
 */
@Module({
  imports: [MediaModule],
  controllers: [DocumentShelfController, DocumentArchiveController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
