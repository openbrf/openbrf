import type { PrismaService } from "../database/prisma.service";

/**
 * How long a refresh token can be presented for.
 *
 * The week the provider is configured to issue them for. Stated here rather
 * than read off a row, because what it bounds is how long a **revoked** row is
 * kept as the evidence that a replay happened - and that window has to hold for
 * a row whose own expiry has already passed.
 *
 * A change to the provider's lifetime therefore moves only how long a spent row
 * is kept before it is deleted. It can neither keep a usable token from being
 * swept nor sweep one that is still usable: both of those are decided by the
 * row's own `expiresAt`, which is written when the token is issued.
 */
const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** What one sweep deleted. Counts, never a row. */
export interface ConnectedAppTokenSweepOutcome {
  accessTokens: number;
  refreshTokens: number;
}

/**
 * Deletes the tokens issued to connected apps that can no longer be presented.
 *
 * A token row is a credential rather than a record of anything. It names the
 * account it was issued for, the client it was issued to and the scopes it
 * carries, and every call the app makes looks it up. Once it can no longer be
 * presented it holds personal data for a purpose that has ended, which is what
 * GDPR art. 5(1)(e) reaches - and the retention sentence in the record of
 * processing says these rows go when they expire or are revoked. This is what
 * makes that sentence true rather than a description of an intention.
 *
 * It rides the service-data purge's own minute rather than taking one of its
 * own: two jobs waking together on one small connection pool is a contention
 * nobody gains anything from, and this is two deletes with no person loop
 * behind them. It is not a person's purge either - a credential that has run
 * out has run out whoever it was issued for - so it runs once per run rather
 * than once per eligible person, and writes no audit entry: nothing was decided
 * about anybody.
 *
 * ## What it deliberately does not delete
 *
 * A consent. That is the grant itself, and it is not held on a clock: it lasts
 * until the person disconnects the app, or until their purge erases the account
 * and takes it through the cascade.
 *
 * A refresh row whose replay window is still open. Presenting a revoked refresh
 * token is what a replay looks like, and the provider answers it by
 * invalidating the whole family. A deleted row cannot do that - the attempt
 * would look like an ordinary miss, and the signal that somebody took a token
 * would have been thrown away with the row it was written on. So a revoked row
 * is kept for as long as it could still have been presented.
 *
 * A refresh row an app can still act through. Deleting one cascades to the
 * access tokens issued from it, so a sweep that took a refresh row with a live
 * access token hanging off it would cut a connection off mid-minute. That is a
 * revocation, and a revocation here is a deliberate act with an audit entry
 * behind it - never something a clock performs.
 *
 * @param now The moment to judge expiry at, passed in so a run can be driven
 *   rather than waited for.
 */
export async function sweepConnectedAppTokens(
  prisma: PrismaService,
  now: Date,
): Promise<ConnectedAppTokenSweepOutcome> {
  /*
   * Every access row past its expiry. An access token lasts fifteen minutes and
   * every call resolves it against this table, so a row past that moment is the
   * credential of a call that can no longer be made.
   */
  const access = await prisma.oauthAccessToken.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  const refresh = await prisma.oauthRefreshToken.deleteMany({
    where: {
      expiresAt: { lte: now },
      /*
       * Nothing live hanging off it. The delete above has already taken every
       * expired access row, so an access row still here is one an app can
       * present - and this delete cascades to it.
       */
      accessTokens: { none: {} },
      OR: [
        // Never exchanged again: the row simply ran out, and there is no replay
        // to recognise because nobody revoked anything.
        { revoked: null },
        // Revoked, and kept until the moment it could no longer have been
        // presented anyway.
        {
          revoked: {
            lte: new Date(now.getTime() - REFRESH_TOKEN_LIFETIME_MS),
          },
        },
      ],
    },
  });

  return { accessTokens: access.count, refreshTokens: refresh.count };
}
