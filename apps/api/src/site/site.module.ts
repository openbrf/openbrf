import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import { SetupModule } from "../setup/setup.module";
import { ThemesModule } from "../themes/themes.module";
import { MenuAdminController } from "./menu-admin.controller";
import { MenuWriteService } from "./menu-write.service";
import {
  PagesAdminController,
  SiteImagesController,
} from "./pages-admin.controller";
import { PagesModule } from "./pages.module";
import { PagesWriteService } from "./pages-write.service";
import { SiteController } from "./site.controller";
import { SiteRenderer } from "./site-renderer.service";

/**
 * The public website.
 *
 * Imports the setup module for one question - has this instance been claimed -
 * the theme module for what it renders as, and the media module because a page
 * can carry a picture. It exports the renderer because the route that claims
 * every unmatched path answers with the website's own not-found page, and that
 * route is registered outside the Nest container.
 *
 * The board's own screen for the website lives here too, on its own
 * controllers. The public controller is @Public() and the admin ones require
 * site:manage, which is why they are separate classes rather than one with a
 * mixture: a class carrying both would make the website's openness a per-route
 * detail instead of a property of the class.
 */
@Module({
  imports: [PagesModule, SetupModule, ThemesModule, MediaModule],
  controllers: [
    SiteController,
    PagesAdminController,
    SiteImagesController,
    MenuAdminController,
  ],
  providers: [SiteRenderer, PagesWriteService, MenuWriteService],
  exports: [SiteRenderer],
})
export class SiteModule {}
