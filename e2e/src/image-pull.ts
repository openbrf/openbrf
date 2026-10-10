/**
 * Retrying a pull of the stack's registry images, and deciding when not to.
 *
 * Kept apart from stack.ts, which reads stack.env as it loads, so that the
 * decision can be tested without a Docker daemon, a compose stack or real
 * pauses: the pull and the pause are both handed in.
 */

/**
 * What a registry or the path to it says when a later attempt can succeed.
 *
 * The registries CI pulls from need no credentials, and answer a burst from a
 * shared runner address with `toomanyrequests: Rate exceeded` (ECR Public does,
 * for one); a registry's front end has bad minutes, and so does the network in
 * between. Only these are retried. Anything not recognised here is taken to be
 * permanent, because retrying it would only add minutes before the same failure.
 */
const TRANSIENT = [
  /toomanyrequests/i,
  /too many requests/i,
  /rate exceeded/i,
  /\b50[0234]\b[^\n]*(?:internal server error|bad gateway|service unavailable|gateway time-?out)/i,
  /TLS handshake timeout/i,
  /i\/o timeout/i,
  /connection reset by peer/i,
  /unexpected EOF/i,
  /Client\.Timeout exceeded/i,
  /temporary failure in name resolution/i,
];

/**
 * What no number of attempts changes: a digest or tag the registry does not
 * have, a registry that refuses the request, a reference or compose file that
 * does not parse, a daemon that is not there.
 *
 * Checked before TRANSIENT. Compose pulls the images side by side, so one run
 * can report a throttled image and a missing one together, and the missing one
 * is still missing on the next attempt.
 */
const PERMANENT = [
  /manifest unknown/i,
  /not found/i,
  /denied/i,
  /unauthorized/i,
  /invalid reference format/i,
  /no such (?:image|service)/i,
  /cannot connect to the docker daemon/i,
];

/**
 * Whether a failed pull is worth another attempt: its diagnostic names a
 * throttled or transient registry or transport failure, and nothing permanent.
 *
 * A failure that carries no diagnostic, such as a missing docker executable or
 * a pull that ran into its timeout, is not.
 */
export function isTransientPullFailure(failure: unknown): boolean {
  const diagnostic = failure instanceof Error ? failure.message : "";
  return (
    !PERMANENT.some((pattern) => pattern.test(diagnostic)) &&
    TRANSIENT.some((pattern) => pattern.test(diagnostic))
  );
}

export interface PullRetryOptions {
  /** Attempts in all, the first included. */
  attempts?: number;
  /** Blocks for this many milliseconds. */
  wait?: (milliseconds: number) => void;
  /** Says that an attempt failed and when the next one starts. */
  report?: (message: string) => void;
}

/**
 * Runs `pull` until it returns, retrying a transient failure after a pause that
 * grows by 15 seconds per attempt.
 *
 * A permanent failure is thrown at once, and once the attempts are used up the
 * last attempt's own failure is thrown, so what reaches the log is always what
 * the registry last said rather than a summary of it.
 */
export function pullWithRetry(
  pull: () => void,
  { attempts = 4, wait = sleep, report = console.warn }: PullRetryOptions = {},
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      pull();
      return;
    } catch (failure) {
      if (attempt >= attempts || !isTransientPullFailure(failure)) {
        throw failure;
      }
      const pause = attempt * 15_000;
      report(
        `image pull attempt ${attempt} of ${attempts} failed transiently; ` +
          `retrying in ${pause / 1000} s`,
      );
      wait(pause);
    }
  }
}

/** Blocks the thread: global setup is synchronous, and nothing else runs. */
function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
