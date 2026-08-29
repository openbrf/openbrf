import { Module } from "@nestjs/common";

import { PagesService } from "./pages.service";

/**
 * The association's pages, as storage.
 *
 * A module of its own, apart from the website that serves them, because the
 * setup wizard writes the first page and the website reads whether the instance
 * has been claimed at all. Keeping the pages here means those two point at this
 * module instead of at each other, and the module graph stays a graph.
 */
@Module({
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
