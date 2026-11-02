import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import type { PluginAccessClass } from "../plugin-access/plugin-access-class";
import { PluginLoaderService } from "./plugin-loader.service";
import { servedNonResidentCallers } from "./resident-routes-consent";

/**
 * The plugin system's answer to which installed plugins a plugin access can
 * be granted to (ADR 0053): the loaded plugins whose manifest declares
 * `pluginAccess` and whose install approved it, as the guard on a resident
 * route works the served classes out.
 *
 * Read on each call, so a plugin that stops serving, or an install whose
 * consent no longer covers the class, stops being offered at once. A plugin
 * that is installed and not loaded, switched off or refused at boot, is not
 * offered: its routes serve nobody, so an access to it would serve nobody.
 */
@Injectable()
export class PluginAccessClassService implements PluginAccessClass {
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly prisma: PrismaService,
  ) {}

  async pluginsServingAccess(): Promise<ReadonlySet<string>> {
    const declaring = this.loader
      .list()
      .filter((plugin) =>
        plugin.manifest.nonResidentCallers.includes("pluginAccess"),
      );
    if (declaring.length === 0) {
      return new Set();
    }
    const installs = await this.prisma.installedPlugin.findMany({
      where: { id: { in: declaring.map((plugin) => plugin.id) } },
      select: { id: true, consentedNonResidentCallers: true },
    });
    const approved = new Map(
      installs.map((install) => [
        install.id,
        install.consentedNonResidentCallers,
      ]),
    );
    return new Set(
      declaring
        .filter((plugin) =>
          servedNonResidentCallers(
            plugin.manifest.nonResidentCallers,
            approved.get(plugin.id) ?? [],
          ).includes("pluginAccess"),
        )
        .map((plugin) => plugin.id),
    );
  }
}
