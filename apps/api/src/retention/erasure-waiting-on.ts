import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import {
  erasureDomainKey,
  erasureRemainder,
  lastDayOfRunningConsentedLetting,
  type ErasureDbClient,
  type ErasureRemainder,
} from "./erasure-domains";
import {
  purgeRefusalOnRequest,
  type RequestPurgeRefusal,
} from "./purge-refusal";

/**
 * Why a granted erasure request is still open.
 *
 * Two answers and they mean opposite things. "blocked" is the product working as
 * it is meant to: a legal hold, a restriction, a board seat, a system role, a
 * residency that has not ended or a motion the association is still dealing
 * with is keeping rows the purge must not take, and the request waits for that
 * to change. "incomplete" is work that was owed and has not happened: a job
 * that has not run since the grant, a run that threw for this person, a reader
 * that has not got through them, a night the instance was down. The purge logs
 * the first as expected and warns about the second, because nothing else would
 * report it.
 *
 * Not the word this product already uses for a person whose personal data is
 * protected (skyddade personuppgifter), which every service that returns a
 * person to a screen answers with and which a debiting list and a fee notice
 * print in the cell where a name would go. A log line saying it beside a person
 * id would be a false signal for an ordinary member and would read as a
 * disclosure for a real one.
 */
export type ErasureRequestStatus = "blocked" | "incomplete";

/**
 * What one person's granted erasure request is waiting on, as it stands now.
 *
 * Asked of the database every time and never stored. Everything in it changes
 * without the request changing - a hold is released, a motion's meeting is
 * held, a letting's end is recorded, a night's run gets through - so a stored
 * answer would be one that was true once.
 */
export interface ErasureWaitingOn {
  status: ErasureRequestStatus;
  /** The rule that refuses the purge for this person, or null. */
  refusal: RequestPurgeRefusal | null;
  /** What each domain still holds for them, as {@link erasureRemainder} answers. */
  remainder: ErasureRemainder[];
  /**
   * The last day of the consented letting that keeps their subletting
   * application, or null where none does.
   */
  lettingLastDay: Date | null;
}

/**
 * What a granted erasure request for this person is waiting on.
 *
 * The one reading of an open request, for the purge's account of the requests
 * it left open and for the board's screen alike, so the log line and what the
 * board reads cannot disagree about why. The purge adds the one thing only a
 * run knows - that its own erasure threw for somebody - on top of this.
 */
export async function erasureWaitingOn(
  client: ErasureDbClient,
  personId: string,
  now: Date,
  encryption: FieldEncryptionService,
): Promise<ErasureWaitingOn> {
  const remainder = await erasureRemainder(client, personId, now, encryption);
  const refusal = await purgeRefusalOnRequest(client, personId, now);
  const keepsSublets = remainder.some(
    (domain) =>
      erasureDomainKey(domain) === "subletApplications" && domain.kept > 0,
  );
  return {
    status: erasureRequestStatus(refusal, remainder),
    refusal,
    remainder,
    // Only asked where the domain keeps something: no kept application, no
    // letting to wait for.
    lettingLastDay: keepsSublets
      ? await lastDayOfRunningConsentedLetting(client, personId, now)
      : null,
  };
}

/**
 * Whether an open granted request is blocked or incomplete.
 *
 * A refusal blocks whatever else stands: the purge will not take the contact
 * details and the account while it does, so nothing a domain job does can
 * close the request. Rows owed are incomplete: a job that reads granted
 * requests has not got through this person, because it has not run since the
 * grant, threw for them, stopped at its bound, or did not run at all. Rows only
 * kept are blocked: the erasure has gone as far as it can go, and the request
 * says so rather than claiming to be carried out.
 *
 * Nothing owed, kept or refusing is incomplete too. The request would close the
 * next time the purge reached the person, which it has not yet done.
 */
export function erasureRequestStatus(
  refusal: RequestPurgeRefusal | null,
  remainder: readonly ErasureRemainder[],
): ErasureRequestStatus {
  if (refusal !== null) {
    return "blocked";
  }
  if (remainder.some((domain) => domain.owed > 0)) {
    return "incomplete";
  }
  return remainder.length > 0 ? "blocked" : "incomplete";
}
