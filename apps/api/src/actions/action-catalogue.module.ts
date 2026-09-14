import { Module } from "@nestjs/common";

import { ActionCatalogueController } from "./action-catalogue.controller";
import { ActionsModule } from "./actions.module";

/**
 * The catalogue endpoint, in a module of its own.
 *
 * Separate from ActionsModule so that importing the registry does not also
 * mount a route: SiteModule and NewsModule need to register actions, and
 * neither should be the reason an HTTP endpoint exists.
 */
@Module({
  imports: [ActionsModule],
  controllers: [ActionCatalogueController],
})
export class ActionCatalogueModule {}
