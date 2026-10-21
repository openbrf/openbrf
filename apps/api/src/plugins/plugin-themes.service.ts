import { Injectable } from "@nestjs/common";
import type {
  ActionRequest,
  PluginInstalledTheme,
  PluginThemeInstallResult,
} from "@openbrf/plugin-sdk";

import {
  ActionCallerFactory,
  type PluginDispatcher,
  type RequestWithToken,
} from "../actions/action-caller";
import { principalCan } from "../authorization/capabilities";
import { PrincipalService } from "../authorization/principal.service";
import {
  ThemeInstallError,
  ThemeInstallService,
} from "../themes/theme-install.service";

/**
 * Installing a theme for a plugin, as the person its route is serving
 * (ADR 0046).
 *
 * The installer takes a person; this decides which one. It is read from the
 * request the plugin's own route received, through the mark core put on it,
 * so a plugin installs as whoever is on the other end of that request and as
 * nobody else - the same way `host.actions.invoke` dispatches. That person
 * must hold what the theme screen requires to install, association:manage,
 * re-derived at the moment of the call as dispatch derives it.
 *
 * Only a person in the web interface. A request a connected app's token
 * reached is refused: installing packages is kept out of reach of connected
 * apps and the AI package, and a plugin's route does not reopen it. A plugin's
 * background job has no request at all, so nothing a plugin does on its own
 * changes what every resident sees.
 */
@Injectable()
export class PluginThemesService {
  constructor(
    private readonly installer: ThemeInstallService,
    private readonly callers: ActionCallerFactory,
    private readonly principals: PrincipalService,
  ) {}

  async install(
    pluginId: string,
    dispatcher: PluginDispatcher,
    request: ActionRequest,
    archive: Uint8Array,
    sha512: string,
  ): Promise<PluginThemeInstallResult> {
    const personId = await this.installingPerson(dispatcher, request);
    const { theme, warnings } = await this.installer.installFromPlugin(
      pluginId,
      archive,
      sha512,
      personId,
    );
    return {
      id: theme.id,
      // Never null for an installed row: only the built-in theme has none.
      version: theme.version ?? "",
      warnings: warnings.map((finding) => ({
        rule: finding.rule,
        detail: { ...finding.detail },
      })),
    };
  }

  async list(pluginId: string): Promise<PluginInstalledTheme[]> {
    return this.installer.installedByPlugin(pluginId);
  }

  /** The person a plugin's install is made as, or a refusal. */
  private async installingPerson(
    dispatcher: PluginDispatcher,
    request: ActionRequest,
  ): Promise<string> {
    // Throws for anything core did not authenticate, so an object a plugin
    // built itself names nobody.
    const caller = this.callers.resolve(
      this.callers.forPlugin(request as RequestWithToken, dispatcher),
    );
    if (caller.channel !== "plugin") {
      throw new ThemeInstallError(
        "A theme is installed for a person in the web interface, not for a connected app or the AI package.",
        "forbidden-capability",
      );
    }
    const principal = await this.principals.forPerson(caller.personId);
    if (principal === null || !principalCan(principal, "association:manage")) {
      throw new ThemeInstallError(
        "This person may not install themes.",
        "forbidden-capability",
      );
    }
    return principal.personId;
  }
}
