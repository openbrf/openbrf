import { Module } from "@nestjs/common";

import { SiteBlocksService } from "./site-blocks.service";

/**
 * The website's block types, as a module of its own.
 *
 * Apart from the website module because the plugin system registers into it
 * and the website reads from it, and neither should import the other: the
 * website may not reach the register, and the plugin system does. Not global,
 * so a plugin's module cannot ask the root injector for it.
 */
@Module({
  providers: [SiteBlocksService],
  exports: [SiteBlocksService],
})
export class SiteBlocksModule {}
