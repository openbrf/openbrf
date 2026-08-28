import { Module } from "@nestjs/common";

import { ThemeInstallService } from "./theme-install.service";
import { CatalogThemeSource } from "./theme-source";
import { ThemeStore } from "./theme-store";
import {
  ActiveThemeController,
  ThemeAdminController,
  ThemeListController,
} from "./theme.controller";
import { ThemeService } from "./theme.service";

/**
 * Themes.
 *
 * The public controller is registered first so its two fixed paths - `active`
 * and `asset` - are matched before any route carrying a parameter.
 */
@Module({
  controllers: [
    ActiveThemeController,
    ThemeListController,
    ThemeAdminController,
  ],
  providers: [
    ThemeService,
    ThemeInstallService,
    ThemeStore,
    CatalogThemeSource,
  ],
  exports: [ThemeService],
})
export class ThemesModule {}
