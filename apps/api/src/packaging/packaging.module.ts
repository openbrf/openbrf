import { Global, Module } from "@nestjs/common";

import { CatalogClient } from "./catalog.client";

/**
 * Package distribution, shared by plugins and themes.
 *
 * Both are installed from the same curated index, as tarballs verified by
 * sha512 before anything is unpacked (plan section 5). This module holds the
 * half that does not care which of the two is being installed: reading the
 * index, fetching bytes, checking a digest, and knowing where on the data
 * volume things go. What happens after the bytes are verified belongs to the
 * plugin installer or the theme installer.
 *
 * Global because both installers need it and neither owns it.
 */
@Global()
@Module({
  providers: [CatalogClient],
  exports: [CatalogClient],
})
export class PackagingModule {}
