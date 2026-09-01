import { Module } from "@nestjs/common";

import { BoardModule } from "../board/board.module";
import { ContactModule } from "../contact/contact.module";
import { DocumentsModule } from "../documents/documents.module";
import { IssuesModule } from "../issues/issues.module";
import { MediaModule } from "../media/media.module";
import { SetupModule } from "../setup/setup.module";
import { ThemesModule } from "../themes/themes.module";
import { AssociationFactsController } from "./association-facts.controller";
import { AssociationFactsService } from "./association-facts.service";
import { MenuAdminController } from "./menu-admin.controller";
import { MenuWriteService } from "./menu-write.service";
import {
  PagesAdminController,
  SiteImagesController,
} from "./pages-admin.controller";
import { PagesModule } from "./pages.module";
import { PagesWriteService } from "./pages-write.service";
import { SiteController } from "./site.controller";
import { SiteCalendarController } from "./site-calendar.controller";
import { SiteEventsService } from "./site-events.service";
import { SiteFormsController } from "./site-forms.controller";
import { SiteNewsController } from "./site-news.controller";
import { SiteNewsService } from "./site-news.service";
import { SiteRenderer } from "./site-renderer.service";

/**
 * The public website.
 *
 * The news and calendar controllers are declared ahead of the page controller
 * because the page controller's parameter route claims every single-segment
 * path: Fastify ranks a static path above a parameter whatever the order, and
 * stating the order here as well says which way round they are meant to be
 * read.
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
    // The archive, for a document list block. Asked with the reader's own
    // principal, so the website lists exactly the shelves the archive would.
    DocumentsModule,
    /*
     * The board roster, for a roster block. It lives outside this directory
     * because the website may not read the address book, and a roster is
     * personal data: who may be named on a published page is decided there,
     * against each person's own publication consent, and the website is handed
     * the answer.
     */
    BoardModule,
  ],
  controllers: [
    // The four public ones first, then the board's.
    SiteNewsController,
    SiteCalendarController,
    SiteController,
    SiteFormsController,
    PagesAdminController,
    SiteImagesController,
    MenuAdminController,
    AssociationFactsController,
  ],
  providers: [
    SiteRenderer,
    SiteNewsService,
    SiteEventsService,
    PagesWriteService,
    MenuWriteService,
    AssociationFactsService,
  ],
  exports: [SiteRenderer],
})
export class SiteModule {}
