import { Module } from "@nestjs/common";

import { MenuService } from "./menu.service";
import { PagesService } from "./pages.service";

/**
 * The association's pages, as storage.
 *
 * A module of its own, apart from the website that serves them, because the
 * setup wizard writes the first page and the website reads whether the instance
 * has been claimed at all. Keeping the pages here means those two point at this
 * module instead of at each other, and the module graph stays a graph.
 *
 * The menu reader is here beside them for one reason: the menu decides which
 * page the root serves, so the pages service reads it. Writing the menu is the
 * board's own screen and lives with the rest of the site administration.
 */
@Module({
  providers: [MenuService, PagesService],
  exports: [MenuService, PagesService],
})
export class PagesModule {}
