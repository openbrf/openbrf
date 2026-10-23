import { Injectable, Logger } from "@nestjs/common";

import { failureName } from "../logging/failure";

/**
 * Finds the names for the ids an action's input carries.
 *
 * The answer maps an id, exactly as it stands in the input, to what a person
 * knows it by. An id with no name is left out, and the caller then shows it as
 * it is.
 */
export type InputNamer = (input: unknown) => Promise<Record<string, string>>;

/**
 * Where a core feature says what the ids in its actions' inputs stand for.
 *
 * The pending-changes screen shows a held input exactly as it will be sent
 * (ADR 0039, section 5), and an input that refers to a row carries its id. This lets
 * a feature put a name beside such an id, so the person confirming reads the
 * meeting and the agenda items they are replacing instead of a UUID. It adds to
 * the preview and never replaces it: the id is still shown.
 *
 * Core only, like {@link CoreActionRegistrar}: a namer reads the instance's own
 * rows as the platform, so a plugin has no way to register one.
 *
 * A namer that fails is logged by its type and costs the names, not the
 * preview. The screen then shows the ids alone, which is what it showed before.
 */
@Injectable()
export class ActionInputNames {
  private readonly logger = new Logger(ActionInputNames.name);
  private readonly namers = new Map<string, InputNamer>();

  register(actionName: string, namer: InputNamer): void {
    if (this.namers.has(actionName)) {
      throw new Error(`Input names for ${actionName} are already registered.`);
    }
    this.namers.set(actionName, namer);
  }

  /** The names for the ids in a held input, empty when nothing names them. */
  async namesOf(
    actionName: string,
    input: unknown,
  ): Promise<Record<string, string>> {
    const namer = this.namers.get(actionName);
    if (namer === undefined) {
      return {};
    }
    try {
      return await namer(input);
    } catch (cause) {
      this.logger.warn(
        `Could not name the ids in a held input for ${actionName}: ${failureName(cause)}`,
      );
      return {};
    }
  }
}
