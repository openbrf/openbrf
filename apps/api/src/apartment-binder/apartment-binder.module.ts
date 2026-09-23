import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import {
  ApartmentBinderBoardController,
  ApartmentBinderShelfController,
} from "./apartment-binder.controller";
import { ApartmentBinderService } from "./apartment-binder.service";

/**
 * The apartment binder (lagenhetsparm).
 *
 * Imports the media module because an entry's bytes are a media file: the
 * binder owns what an entry is and who it is for, and the media layer owns
 * storing it, identifying it and serving it. The database client and the audit
 * log come from the global modules, which is why they are not imported here.
 *
 * Nothing is imported from `site/`: a binder holds the papers of one home and
 * the public website renders none of them. There is no actions registrar
 * either, on the chat's precedent - a binder is not something a plugin or a
 * connected app reaches.
 *
 * The shelf controller is registered first so the household's routes are
 * declared before the board's, which is the order the two are read in.
 */
@Module({
  imports: [MediaModule],
  controllers: [ApartmentBinderShelfController, ApartmentBinderBoardController],
  providers: [ApartmentBinderService],
  exports: [ApartmentBinderService],
})
export class ApartmentBinderModule {}
