import { Global, Module } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { CatalogClient } from "./catalog.client";
import { PackageLock } from "./package-lock";

/**
 * Package distribution, shared by plugins and themes.
 *
 * Both are installed from the same curated index, as tarballs verified by
 * sha512 before anything is unpacked (plan section 5). This module holds the
 * half that does not care which of the two is being installed: reading the
 * index, fetching bytes, checking a digest, knowing where on the data volume
 * things go, and the lock that keeps an install and an uninstall of one package
 * apart. What happens after the bytes are verified belongs to the plugin
 * installer or the theme installer.
 *
 * Global because both installers need it and neither owns it.
 */
@Global()
@Module({
  providers: [
    CatalogClient,
    // Built here rather than by the injector, so a test can hand one tighter
    // limits; one per process, which is what makes its queue and its count
    // mean anything.
    {
      provide: PackageLock,
      useFactory: (env: Env) => new PackageLock(env),
      inject: [ENV],
    },
  ],
  exports: [CatalogClient, PackageLock],
})
export class PackagingModule {}
