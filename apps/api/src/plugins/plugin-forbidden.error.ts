import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * The caller may not use this plugin route.
 *
 * Kept separate from the other plugin failures because it is the one a
 * resident will actually see: a plugin whose route requires the board's
 * capability, reached from a resident's screen. The reason code lets the
 * client say "not for your account" rather than "something went wrong".
 */
export class PluginForbiddenError extends DomainError {
  readonly status = HttpStatus.FORBIDDEN;
  readonly reason = "plugin-forbidden";

  constructor(pluginId: string) {
    super(`Your account may not use the "${pluginId}" plugin's route.`);
  }
}
