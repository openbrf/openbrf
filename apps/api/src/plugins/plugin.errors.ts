import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Failures a board can cause from the plugin screen or the CLI.
 *
 * Each carries a machine-readable reason rather than prose, because the API
 * answers in English while the interface is Swedish by default, and how much a
 * failure explains is a decision for the screen.
 */

export class PluginNotFoundError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "plugin-not-found";

  constructor(id: string) {
    super(`No plugin "${id}" is installed on this instance.`);
  }
}

export class CatalogEntryNotFoundError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "catalog-entry-not-found";

  constructor(id: string) {
    super(`The catalog does not list "${id}".`);
  }
}

export class PluginApiVersionError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "plugin-api-version-unsupported";

  constructor(id: string, declared: number) {
    super(
      `"${id}" is built against plugin API version ${String(declared)}, ` +
        "which this version of Open BRF does not implement.",
    );
  }
}

export class PluginConsentMismatchError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "plugin-consent-mismatch";

  constructor() {
    super(
      "The permissions or personal data the catalog lists have changed since " +
        "this screen was opened. Review them again.",
    );
  }
}

export class PluginsDisabledError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "plugins-disabled";

  constructor() {
    super("Plugins are disabled on this instance (OPENBRF_PLUGINS_ENABLED).");
  }
}

export class PluginRouteNotFoundError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "plugin-route-not-found";

  constructor(pluginId: string, path: string) {
    super(`Plugin "${pluginId}" serves no route at ${path}.`);
  }
}

/**
 * A plugin's own handler threw.
 *
 * Reported as a 502 rather than a 500: the fault is in software the instance
 * hosts but did not write, and an operator reading the log needs that
 * distinction to know whose bug it is.
 */
export class PluginHandlerError extends DomainError {
  readonly status = HttpStatus.BAD_GATEWAY;
  readonly reason = "plugin-handler-failed";

  constructor(pluginId: string) {
    super(`Plugin "${pluginId}" failed while handling the request.`);
  }
}

export class PluginSettingsUnavailableError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "plugin-settings-unavailable";

  constructor(id: string) {
    super(`Plugin "${id}" declares no settings.`);
  }
}
