import { Injectable, Logger } from "@nestjs/common";

import type { Capability, Principal } from "../authorization/capabilities";
import { failureName } from "../logging/failure";

/**
 * What a person knows a row by, and what kind of value that is.
 *
 * The kind is for the screen, which sets register data in the data face: a
 * meeting named by its day is a `date`, an ISO 8601 day (YYYY-MM-DD), and an
 * agenda item named by its title is `text`.
 */
export interface InputName {
  readonly text: string;
  readonly kind: "date" | "text";
}

/**
 * Finds the names for the ids an action's input carries.
 *
 * The answer maps an id, exactly as it stands in the input, to what a person
 * knows it by. An id with no name is left out, and the caller then shows it as
 * it is.
 */
export type InputNamer = (input: unknown) => Promise<Record<string, InputName>>;

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
 * A namer is registered with the capability that reads what it names, and is
 * asked only for a viewer who holds that capability now. The screen's routes
 * take no capability, since a pending change is its proposer's whatever their
 * standing, so without this a board member whose term ended would still read
 * the meeting through a change they proposed while they sat. Such a viewer gets
 * no names, and the ids alone, which is what the screen showed before.
 *
 * A namer that fails is logged by its type and costs the names, not the
 * preview. The screen then shows the ids alone here too.
 */
@Injectable()
export class ActionInputNames {
  private readonly logger = new Logger(ActionInputNames.name);
  private readonly namers = new Map<
    string,
    { readonly capability: Capability; readonly namer: InputNamer }
  >();

  register(
    actionName: string,
    capability: Capability,
    namer: InputNamer,
  ): void {
    if (this.namers.has(actionName)) {
      throw new Error(`Input names for ${actionName} are already registered.`);
    }
    this.namers.set(actionName, { capability, namer });
  }

  /**
   * The names for the ids in a held input, as this viewer may read them now:
   * empty when nothing names them or the viewer lacks what reads them.
   */
  async namesOf(
    actionName: string,
    input: unknown,
    viewer: Pick<Principal, "capabilities">,
  ): Promise<Record<string, InputName>> {
    const registered = this.namers.get(actionName);
    if (
      registered === undefined ||
      !viewer.capabilities.has(registered.capability)
    ) {
      return {};
    }
    try {
      return await registered.namer(input);
    } catch (cause) {
      this.logger.warn(
        `Could not name the ids in a held input for ${actionName}: ${failureName(cause)}`,
      );
      return {};
    }
  }
}
