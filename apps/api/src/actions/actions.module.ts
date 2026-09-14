import { Module } from "@nestjs/common";

import { ActionCallerFactory } from "./action-caller";
import { ActionRegistryService } from "./action-registry.service";
import { CoreActionRegistrar } from "./action-registrar";

/**
 * The action registry, deliberately NOT global.
 *
 * `AuditModule` and `AuthorizationModule` are `@Global()`, which puts their
 * providers in the root injector where any loaded plugin's provider can ask for
 * them by type. The seal refuses a plugin's own `@Global()` module and the four
 * application-wide tokens, but neither of those stops a plugin constructor from
 * resolving a core global provider - that is a separate check, added to the
 * seal in this change.
 *
 * The registry is kept out of reach by construction instead. A plugin reaches
 * dispatch through `host.actions`, which carries the plugin's identity with it;
 * there is no path by which it can hold the registry itself and register an
 * action as somebody else.
 *
 * Imported explicitly by SiteModule, NewsModule, ActionCatalogueModule and
 * PluginsModule, and by nothing else.
 */
@Module({
  providers: [ActionRegistryService, ActionCallerFactory, CoreActionRegistrar],
  exports: [ActionRegistryService, ActionCallerFactory, CoreActionRegistrar],
})
export class ActionsModule {}
