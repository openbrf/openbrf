import type { ConsentScope } from "../generated/prisma/enums";
import { toIsoDate } from "./address-book-view";

/**
 * Publication consent (publiceringssamtycke) as the board's person view shows
 * it: what the person has agreed to, and the dates that say when.
 *
 * Pure, and separate from the service that writes consents, so the person view
 * can project them without depending on the write path.
 */

/**
 * Every scope, in the order the person view lists them.
 *
 * Deliberately a list rather than a derivation from the generated enum: the
 * order is an interface decision, and a scope added to the schema should have
 * to be given a place and a label here rather than appearing unlabelled.
 */
export const CONSENT_SCOPES = [
  "PHOTO",
  "NAME_ON_SITE",
  "BOARD_ROSTER",
] as const satisfies readonly ConsentScope[];

/**
 * What one scope stands at.
 *
 * Three states, not two. "Never asked" is not the same answer as "asked and
 * answered, then withdrawn": the first says the board has a conversation to
 * have, the second says it has had one and got an answer.
 */
export type PublicationConsentState = "granted" | "withdrawn" | "never";

export interface PublicationConsentView {
  scope: ConsentScope;
  state: PublicationConsentState;
  /** Date of the most recent grant, null when there has never been one. */
  grantedOn: string | null;
  /** Date the most recent grant was withdrawn, null while it stands. */
  withdrawnOn: string | null;
  /** What the person said when they granted it, as the board wrote it down. */
  note: string | null;
}

/** One consent row, as much of it as the projection needs. */
export interface PublicationConsentRecord {
  scope: ConsentScope;
  grantedAt: Date;
  withdrawnAt: Date | null;
  note: string | null;
}

/**
 * One scope's state, from its most recent row or from the absence of one.
 *
 * The dates are days rather than timestamps, like every other register date on
 * screen: what a consent has to answer is which day it started to hold and
 * which day it stopped.
 */
export function consentViewOf(
  scope: ConsentScope,
  latest: PublicationConsentRecord | null,
): PublicationConsentView {
  if (latest === null) {
    return {
      scope,
      state: "never",
      grantedOn: null,
      withdrawnOn: null,
      note: null,
    };
  }

  return {
    scope,
    state: latest.withdrawnAt === null ? "granted" : "withdrawn",
    grantedOn: toIsoDate(latest.grantedAt),
    withdrawnOn: toIsoDate(latest.withdrawnAt),
    note: latest.note,
  };
}

/**
 * The current state of every scope, from a person's consent rows.
 *
 * Withdrawal never deletes a row, so one scope can hold several: a person who
 * grants, withdraws and grants again leaves three dated facts behind. The most
 * recent grant is the state that holds, and the older rows stay as the record
 * of what was lawful to publish when.
 *
 * Always one entry per scope, whether or not the person has any rows: a scope
 * nobody has asked about is a state the board needs to see, not an absence.
 */
export function consentStateFor(
  rows: readonly PublicationConsentRecord[],
): PublicationConsentView[] {
  return CONSENT_SCOPES.map((scope) =>
    consentViewOf(scope, latestForScope(rows, scope)),
  );
}

function latestForScope(
  rows: readonly PublicationConsentRecord[],
  scope: ConsentScope,
): PublicationConsentRecord | null {
  return rows.reduce<PublicationConsentRecord | null>(
    (newest, row) =>
      row.scope !== scope
        ? newest
        : newest === null ||
            row.grantedAt.getTime() > newest.grantedAt.getTime()
          ? row
          : newest,
    null,
  );
}
