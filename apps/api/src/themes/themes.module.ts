import { Module } from "@nestjs/common";

import { PackagingModule } from "../packaging/packaging.module";
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
 *
 * Packaging is imported by name although it is global: the catalog client is
 * what the theme source reads the index through, and the dependency is the
 * module's to state.
 *
 * The installer is exported for the plugin system alone, which imports this
 * module to give `host.themes` its install (ADR 0046). The module is not
 * global, so a plugin's own providers cannot resolve the installer by type.
 */
@Module({
  imports: [PackagingModule],
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
  exports: [ThemeService, ThemeInstallService],
})
export class ThemesModule {}
