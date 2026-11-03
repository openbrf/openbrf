import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/** Where a personal identity number was found: the line, the field, the offset. */
export interface ResponsibilityGuideTextLocation {
  /** The line's place in the guide as sent, from 0. */
  item: number;
  field: "part" | "note";
  offset: number;
}

/**
 * A refusal of the board's responsibility guide.
 *
 * `personal-identity-number` is a line carrying one: the guide is shown to
 * every resident before they file, and a personnummer pasted in with the text
 * around it would be published to the house. The refusal names the line, the
 * field and the offset, never the value. `too-many-items`, `part-required`
 * and `text-too-long` are the limits in `RESPONSIBILITY_GUIDE_LIMITS`, held
 * here as well as by the controller's schema, because the service is what the
 * integration tests and every later caller go through.
 */
export type ResponsibilityGuideReason =
  | "personal-identity-number"
  | "too-many-items"
  | "part-required"
  | "text-too-long";

export class ResponsibilityGuideError extends DomainError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(
    message: string,
    readonly reason: ResponsibilityGuideReason,
    private readonly locations: readonly ResponsibilityGuideTextLocation[] = [],
  ) {
    super(message);
  }

  override details(): Record<string, readonly unknown[]> {
    return this.locations.length === 0 ? {} : { locations: this.locations };
  }
}
