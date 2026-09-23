import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/** Where in a title a refused value sits. */
export interface BinderTextLocation {
  /** Which field it was in. One today, named so the screen need not guess. */
  part: "title";
  /** Where in that text the refused value starts. */
  offset: number;
}

export type ApartmentBinderReason =
  | "not-found"
  | "kind-is-the-boards"
  | "date-required"
  | "personal-identity-number"
  | "binder-full";

/**
 * A refusal from the apartment binder.
 *
 * `not-found` is deliberately vaguer than what happened. It answers an
 * apartment that does not exist, an apartment the caller holds no residency on
 * today, and an entry that is not theirs to take out, without distinguishing
 * them - the rule the own-register route already states, that a refusal naming
 * the difference would confirm which apartments there are and who lives in
 * them. The media route answers the bytes the same way.
 *
 * The rest say what happened, because each tells the caller something about
 * their own act and nothing about anybody else's. `kind-is-the-boards` is the
 * association saying that a permission under BRL 7 kap. 7 § is the board's own
 * decision; `date-required` is the day the board took it; `binder-full` is the
 * bound an apartment's papers are kept inside.
 *
 * The refusal for a personal identity number names the field and the position
 * and never the value: what the scan caught is exactly what must not travel
 * back in a response body, into a log, or onto a screen.
 */
export class ApartmentBinderError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: ApartmentBinderReason,
    private readonly found: readonly BinderTextLocation[] = [],
  ) {
    super(message);
    this.status =
      reason === "not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "kind-is-the-boards"
          ? HttpStatus.FORBIDDEN
          : reason === "date-required"
            ? HttpStatus.BAD_REQUEST
            : reason === "binder-full"
              ? HttpStatus.CONFLICT
              : /*
                 * Understood and refused on its merits: the title is a title
                 * and it carries something that may not be written down here.
                 * Not a 400, which would say the request was malformed.
                 */
                HttpStatus.UNPROCESSABLE_ENTITY;
  }

  /**
   * Where the refusal is.
   *
   * Positions and a field name only, on the chat's rule: what was found is
   * exactly what must not travel back.
   */
  override details(): Record<string, readonly unknown[]> {
    return { locations: this.found };
  }
}
