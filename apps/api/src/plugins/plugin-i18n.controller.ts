import { Controller, Get, Param } from "@nestjs/common";

import { RequireCapability } from "../authorization/require-capability.decorator";
import { type Locale, SUPPORTED_LOCALES } from "../i18n/i18n.service";
import { PluginLoaderService } from "./plugin-loader.service";

/** Namespace a plugin's strings are merged under, so it cannot shadow core keys. */
const PLUGIN_NAMESPACE = /^plugin-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

/**
 * Serves a plugin's translations to the browser.
 *
 * Plugins ship locales/{sv,en}.json and the host merges them at runtime under
 * `plugin-<id>` (plan section 7). The browser cannot bundle them - the whole
 * point is that the application is not rebuilt when a plugin is installed - so
 * i18next loads the namespace lazily from here, the same way it loads one on
 * the server.
 *
 * An unknown namespace answers with an empty bundle rather than a 404.
 * i18next asks for a namespace whenever a component references one, including
 * during the moment after a plugin is disabled and before the view unmounts;
 * a 404 there is a console error about a state that is already correct.
 */
@Controller("api/i18n")
@RequireCapability("self:manage")
export class PluginI18nController {
  constructor(private readonly loader: PluginLoaderService) {}

  @Get(":lng/:ns")
  bundle(
    @Param("lng") lng: string,
    @Param("ns") ns: string,
  ): Record<string, unknown> {
    const locale = SUPPORTED_LOCALES.find(
      (supported): supported is Locale => supported === lng,
    );
    if (locale === undefined) {
      return {};
    }

    const match = PLUGIN_NAMESPACE.exec(ns);
    if (match === null) {
      return {};
    }

    const plugin = this.loader.get(match[1] ?? "");
    return plugin?.locales[locale] ?? {};
  }
}
