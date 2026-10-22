import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * Why a licence file was not entered (ADR 0042), as a code the licence screen
 * and the command-line tool say in their reader's language.
 *
 * - `too-large`: over 16 KiB.
 * - `unsupported-format`: a licence of a format version this core does not
 *   read.
 * - `not-a-licence`: not a licence file at all, or one whose signed payload
 *   this format version refuses.
 * - `signature-invalid`: installed plugins declare its key id, and none of
 *   their keys verifies it.
 * - `already-entered`: the same file is entered already.
 * - `limit-reached`: fifty licences are entered; remove one first.
 */
export const LICENCE_REFUSALS = [
  "too-large",
  "unsupported-format",
  "not-a-licence",
  "signature-invalid",
  "already-entered",
  "limit-reached",
] as const;

export type LicenceRefusal = (typeof LICENCE_REFUSALS)[number];

const MESSAGES: Record<LicenceRefusal, string> = {
  "too-large": "The file is larger than a licence may be (16 KiB).",
  "unsupported-format":
    "The file is a licence of a format this version of Open BRF does not read.",
  "not-a-licence": "The file is not a licence this instance can read.",
  "signature-invalid":
    "No installed plugin's key verifies the licence. It may have been changed after it was issued.",
  "already-entered": "This licence is entered already.",
  "limit-reached":
    "Fifty licences are entered, which is as many as an instance keeps. Remove one first.",
};

export class LicenceRefusedError extends DomainError {
  readonly status: number;
  readonly reason: string;

  constructor(readonly refusal: LicenceRefusal) {
    super(MESSAGES[refusal]);
    this.reason = `licence-${refusal}`;
    this.status =
      refusal === "already-entered" || refusal === "limit-reached"
        ? HttpStatus.CONFLICT
        : HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

export class LicenceNotFoundError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "licence-not-found";

  constructor() {
    super("No such licence is entered on this instance.");
  }
}
