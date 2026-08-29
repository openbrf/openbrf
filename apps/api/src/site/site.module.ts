import { Module } from "@nestjs/common";

import { ContactModule } from "../contact/contact.module";
import { IssuesModule } from "../issues/issues.module";
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
import { SiteFormsController } from "./site-forms.controller";
import { SiteNewsController } from "./site-news.controller";
import { SiteNewsService } from "./site-news.service";
import { SiteRenderer } from "./site-renderer.service";

/**
 * The public website.
 *
 * The news controller is declared ahead of the page controller because the page
 * controller's parameter route claims every single-segment path: Fastify ranks
 * a static path above a parameter whatever the order, and stating the order
 * here as well says which way round the two are meant to be read.
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
  imports: [
    PagesModule,
    SetupModule,
    ThemesModule,
    MediaModule,
    // The two modules behind the public forms. The website renders and submits
    // them in process rather than calling its own API over HTTP, which is what
    // both of those modules' export lists were written for.
    IssuesModule,
    ContactModule,
  ],
  controllers: [
    // The three public ones first, then the board's.
    SiteNewsController,
    SiteController,
    SiteFormsController,
    PagesAdminController,
    SiteImagesController,
    MenuAdminController,
  ],
  providers: [
    SiteRenderer,
    SiteNewsService,
    PagesWriteService,
    MenuWriteService,
  ],
  exports: [SiteRenderer],
})
export class SiteModule {}
