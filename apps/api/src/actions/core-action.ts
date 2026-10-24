import type { ActionDefinition } from "@openbrf/plugin-sdk";

/**
 * What a core action may declare beyond the plugin contract, for a call to it
 * held as a pending change (ADR 0039).
 *
 * Core only, and not in `@openbrf/plugin-sdk`: both run the action's own code
 * when nothing is being dispatched - the target when a preview is read, the
 * rule when a change is proposed - and what the preview says about the thing a
 * change is to is the platform's statement, not a plugin's. The registry keeps
 * them only for a core owner (`ActionRegistryService.register`), so a plugin's
 * definition that carried either key would have it ignored.
 */
export interface CoreActionDefinition<
  Input = unknown,
  Output = unknown,
> extends ActionDefinition<Input, Output> {
  /**
   * The one thing a call names by id, read when its preview is shown.
   *
   * A held call whose input is an id and little else - publish this, take that
   * down - says nothing a person can check by reading its input: an id is not
   * an item. The preview shows what the id names as it stands at that moment,
   * and what confirming would set on it.
   */
  readonly target?: ActionTarget<Input>;
  /**
   * What a proposed call is held to beyond the input schema, as the paths it
   * fails at.
   *
   * For a field a direct call may leave out and a held one may not. A held
   * call is confirmed up to a week after it was proposed, so a precondition
   * that is a convenience when a caller writes at once - the revision it read -
   * is what keeps a confirmed one from writing over whatever was saved in
   * between. Refused at proposing as the schema refuses, with a 400 naming the
   * path.
   */
  readonly checkProposed?: (input: Input) => readonly ProposedInputIssue[];
}

/** One path a proposed input fails `checkProposed` at, and why. */
export interface ProposedInputIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** What kind of thing a target is, which the screen names it by. */
export type ActionTargetKind = "news" | "page";

/**
 * One fact about a target: what it is now and what confirming would set.
 *
 * `after` is absent for a fact the call leaves alone. The values are what the
 * action's own schemas use - `PUBLIC`, `MEMBERS_ONLY`, a slug, a title - so the
 * preview speaks the action's vocabulary, which the screen translates where it
 * knows the word.
 */
export interface ActionTargetFact {
  readonly fact: string;
  readonly now: string | boolean;
  readonly after?: string | boolean;
}

export interface ActionTarget<Input> {
  readonly kind: ActionTargetKind;
  /** The id the input names. */
  readonly id: (input: Input) => string;
  /**
   * The facts about what the id names, as it stands now and as the call would
   * leave it. Null when nothing answers to the id any more.
   */
  readonly read: (input: Input) => Promise<readonly ActionTargetFact[] | null>;
}

/**
 * A target as the pending-change screen reads it.
 *
 * - `found`: the facts as they stand now, with what confirming would set.
 * - `missing`: nothing answers to the id any more, so confirming will be
 *   refused; the change can be rejected.
 * - `withheld`: the reader no longer holds the action's capability, so is not
 *   shown what stands there now. Confirming would be refused as well.
 */
export interface ActionTargetView {
  readonly kind: ActionTargetKind;
  readonly id: string;
  readonly state: "found" | "missing" | "withheld";
  /** Empty unless `found`. */
  readonly facts: readonly ActionTargetFact[];
}

/**
 * A target's facts, from what stands now and what the call sets.
 *
 * In the order `now` lists them. A fact `after` leaves undefined is one the
 * call does not set; one it sets to what it already is keeps its `after`, and
 * the screen shows that nothing changes.
 */
export function targetFacts(
  now: Readonly<Record<string, string | boolean>>,
  after: Readonly<Record<string, string | boolean | undefined>>,
): ActionTargetFact[] {
  return Object.entries(now).map(([fact, value]) => {
    const next = after[fact];
    return next === undefined
      ? { fact, now: value }
      : { fact, now: value, after: next };
  });
}
