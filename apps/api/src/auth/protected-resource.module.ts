import { Global, Module } from "@nestjs/common";

import { protectedResource } from "./protected-resource";

/**
 * The token the three injectors that need the resource resolve it by.
 *
 * A string token rather than a class, because the value is a plain record
 * decided before the container exists and there is nothing to construct.
 */
export const PROTECTED_RESOURCE = "PROTECTED_RESOURCE";

/**
 * Global, and it has to be.
 *
 * `AuthorizationGuard` is constructed inside `AuthorizationModule`, which
 * imports nothing; `AuthModule` and the discovery controller sit in two more
 * injectors. A provider on `AppModule` would not resolve in the injector that
 * needs it, and `AppModule.withPlugins` takes a module array and nothing else,
 * so this is a module rather than a provider.
 */
@Global()
@Module({
  providers: [{ provide: PROTECTED_RESOURCE, useFactory: protectedResource }],
  exports: [PROTECTED_RESOURCE],
})
export class ProtectedResourceModule {}
