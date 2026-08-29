import { Module } from "@nestjs/common";

import { SetupModule } from "../setup/setup.module";
import { ThemesModule } from "../themes/themes.module";
import { PagesModule } from "./pages.module";
import { SiteController } from "./site.controller";
import { SiteRenderer } from "./site-renderer.service";

/**
 * The public website.
 *
 * Imports the setup module for one question - has this instance been claimed -
 * and the theme module for what it renders as. It exports the renderer because
 * the route that claims every unmatched path answers with the website's own
 * not-found page, and that route is registered outside the Nest container.
 */
@Module({
  imports: [PagesModule, SetupModule, ThemesModule],
  controllers: [SiteController],
  providers: [SiteRenderer],
  exports: [SiteRenderer],
})
export class SiteModule {}
