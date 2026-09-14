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

/**
 * A second plugin declaring the OAuth protected resource.
 *
 * The resource's full URL is the audience every access token is issued for, so
 * a second declaration can only either move the audience - which strands every
 * connection the members have already granted, because their tokens name the
 * old one - or be ignored, which is a plugin installed on a promise the
 * instance will not keep. Refused at install because that is where a board can
 * still act on it: the answer is to remove the other connector, and removing
 * one after the fact is the same disruption by a longer route.
 */
export class PluginResourceConflictError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "plugin-resource-conflict";

  constructor(id: string, incumbent: string) {
    super(
      `"${id}" declares the OAuth protected resource and "${incumbent}" is ` +
        "already installed declaring one. At most one installed plugin may.",
    );
  }
}

/**
 * A plugin taking the reserved connector id without serving the resource.
 *
 * An instance with no connector still advertises the default resource under
 * this id, so that sign-in is configurable and discoverable before a connector
 * exists; nothing is mounted there and no Bearer route is installed. But plugin
 * routes are mounted under `/api/plugin/<id>/`, nothing else reserves the id,
 * and `pluginIdSchema` accepts it - so an unrelated plugin taking it and
 * serving `mcp` would turn a route that answers the browser's own session into
 * a Bearer-only one, with nothing having declared that it should.
 */
export class PluginReservedIdError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "plugin-id-reserved";

  constructor(id: string) {
    super(
      `The plugin id "${id}" is reserved for the OAuth protected resource. ` +
        "Only a plugin whose manifest declares oauthProtectedResource may " +
        "take it.",
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

/**
 * The board said the plugin sends personal data outside the instance and did
 * not say to whom.
 *
 * A recipient with no name is not a record of anything: GDPR art. 30(1)(d)
 * asks who receives the data, and art. 28 asks what agreement covers them.
 */
export class PluginRecipientRequiredError extends DomainError {
  readonly status = HttpStatus.BAD_REQUEST;
  readonly reason = "recipient-required";

  constructor() {
    super("Name who the plugin sends personal data to.");
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
