import { Global, Module } from "@nestjs/common";

import { I18nService } from "./i18n.service";

/** Translation is needed by mail, PDF extracts and every error surface. */
@Global()
@Module({
  providers: [I18nService],
  exports: [I18nService],
})
export class I18nModule {}
