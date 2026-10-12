import type { ErasureDbClient } from "./erasure-domains";

/**
 * Which rule refuses a person's purge.
 *
 * A code rather than a sentence, because two readers want it in two forms: the
 * purge's log line and run summary say it in English
 * ({@link describePurgeRefusal}), and the board's screen says it in the board's
 * language. The codes that a granted erasure request can meet are the ones
 * `DataSubjectRequestError` already refuses a grant with, because they are the
 * same rules asked at a later moment - a hold placed, a seat taken or a
 * residency recorded after the board granted the request.
 *
 * `no-residency` and `residency-within-retention` belong to the scheduled run
 * alone: a granted request lifts both, so the board never meets them on a
 * request.
 */
export type PurgeRefusal =
  | "processing-restricted"
  | "board-position-current"
  | "on-legal-hold"
  | "system-role-current"
  | "currently-resident"
  | "no-residency"
  | "residency-within-retention"
  | "person-not-found";

/**
 * The refusals a granted erasure request can meet: every one but the two the
 * request lifts.
 */
export type RequestPurgeRefusal = Exclude<
  PurgeRefusal,
  "no-residency" | "residency-within-retention"
>;

/** What a person's row has to answer for {@link purgeRefusal}. */
export interface PurgeRefusalFacts {
  residencies: readonly { movedOutOn: Date | null }[];
  boardPositions: readonly { endedOn: Date | null }[];
  systemRoles: readonly unknown[];
  legalHolds: readonly unknown[];
  processingRestrictedAt: Date | null;
}

/**
 * What refuses this person's purge, or null where nothing does.
 *
 * The same four conditions the scan applies, expressed over objects rather
 * than as a query, because the check that matters is the one taken with the
 * rows locked in front of it.
 *
 * A reason rather than a boolean, so that a granted erasure request the purge
 * will not carry out can say which rule kept it waiting. It names a rule and
 * never a row.
 */
export function purgeRefusal(
  person: PurgeRefusalFacts,
  now: Date,
  cutoff: Date,
  onRequest: true,
): RequestPurgeRefusal | null;
export function purgeRefusal(
  person: PurgeRefusalFacts,
  now: Date,
  cutoff: Date,
  onRequest?: boolean,
): PurgeRefusal | null;
export function purgeRefusal(
  person: PurgeRefusalFacts,
  now: Date,
  cutoff: Date,
  onRequest = false,
): PurgeRefusal | null {
  /*
   * A restriction refuses before anything else is considered. Art. 18(2) lets
   * the association store the data and little else, so erasing it is the one
   * act the person has asked it not to perform - and asking for a restriction
   * after asking for erasure is a person changing their mind, which the later
   * request wins.
   */
  if (person.processingRestrictedAt !== null) {
    return "processing-restricted";
  }
  /*
   * Asked before the residencies, because none of these depends on one. A
   * granted request moves the cutoff and lifts the requirement of a past
   * residency; it lifts nothing else, so a hold placed after the grant still
   * refuses here - and it has to refuse for somebody who never held a
   * residency too, whose data a hold is just as capable of preserving.
   */
  if (
    person.boardPositions.some(
      (position) =>
        position.endedOn === null || position.endedOn.getTime() > now.getTime(),
    )
  ) {
    return "board-position-current";
  }
  if (person.legalHolds.length > 0) {
    return "on-legal-hold";
  }
  if (person.systemRoles.length > 0) {
    return "system-role-current";
  }
  /*
   * Somebody who never lived here has no move-out to anchor a purge date on, so
   * the scheduled job leaves them alone. A granted request is a different
   * authority: it names this person, and their contact details and account are
   * service data whether or not they ever held a residency.
   */
  if (person.residencies.length === 0) {
    return onRequest ? null : "no-residency";
  }
  return person.residencies.some(
    (residency) =>
      residency.movedOutOn === null ||
      residency.movedOutOn.getTime() > cutoff.getTime(),
  )
    ? onRequest
      ? "currently-resident"
      : "residency-within-retention"
    : null;
}

/**
 * What refuses this person's purge on a granted erasure request, read from the
 * database, or null where nothing does.
 *
 * The scan's rules asked one person at a time, so a request left open has a
 * reason that names the same thing the query filtered on. A granted request
 * is the authority here, so the cutoff is now and a past residency is not
 * required - every other refusal stands.
 */
export async function purgeRefusalOnRequest(
  client: ErasureDbClient,
  personId: string,
  now: Date,
): Promise<RequestPurgeRefusal | null> {
  const person = await client.person.findUnique({
    where: { id: personId },
    select: {
      processingRestrictedAt: true,
      residencies: { select: { movedOutOn: true } },
      boardPositions: { select: { endedOn: true } },
      systemRoles: { select: { role: true } },
      legalHolds: { where: { releasedAt: null }, select: { id: true } },
    },
  });
  if (person === null) {
    return "person-not-found";
  }
  return purgeRefusal(person, now, now, true);
}

/**
 * The refusal as a log line and a run summary say it.
 *
 * The words those have always used, so a line read against last month's says
 * the same thing for the same rule.
 */
export function describePurgeRefusal(refusal: PurgeRefusal): string {
  switch (refusal) {
    case "processing-restricted":
      return "processing is restricted";
    case "board-position-current":
      return "a board seat is still held";
    case "on-legal-hold":
      return "a legal hold stands";
    case "system-role-current":
      return "a system role is still granted";
    case "currently-resident":
      return "a residency is still running";
    case "no-residency":
      return "no residency to anchor a purge date on";
    case "residency-within-retention":
      return "a residency has not ended long enough ago";
    case "person-not-found":
      return "the person row is gone";
  }
}
