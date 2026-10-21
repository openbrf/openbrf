/**
 * What a paid plugin reads about its licence (ADR 0042).
 *
 * The host holds the licences the board entered and verifies them offline,
 * against the keys the plugin's manifest declares and the instance's own id
 * and key, on the association's calendar day. A plugin gets the finding and
 * never the file, and decides for itself what it withholds without an active
 * entitlement: the host loads and serves it either way.
 */

/** The version of the licence file format this contract reads. */
export const LICENCE_FORMAT = "openbrf-licence/1";

/** The version of the presentation format `present()` writes. */
export const LICENCE_PRESENTATION_FORMAT = "openbrf-licence-presentation/1";

/** The largest licence file the host accepts, in bytes. */
export const LICENCE_FILE_MAX_BYTES = 16_384;

/** The largest presentation a service has to read, in bytes. */
export const LICENCE_PRESENTATION_MAX_BYTES = 24_576;

/**
 * The finding for the entitlement the manifest names, judged today.
 *
 * Dates are `YYYY-MM-DD` on the association's calendar day, and inclusive: a
 * licence valid until a day is active through the whole of it.
 *
 * - `active`: a licence one of the plugin's keys verified names the
 *   entitlement, is bound to this instance, and covers today and this release.
 * - `absent`: no licence the plugin's keys verified names the entitlement.
 * - `expired`: today is after its `validUntil`.
 * - `version-not-covered`: this release was published after its
 *   `updatesUntil`. An earlier release stays covered.
 * - `wrong-instance`: it was issued to another instance, by id or by key.
 * - `tampered`: it verified when it was entered and no longer does.
 * - `not-yet-valid`: it was issued after today, which is a wrong clock on
 *   one side or the other.
 *
 * Without an active licence the finding is that of the licence entered most
 * recently, so a board that has just entered the wrong file is told about
 * that file.
 */
export type EntitlementState =
  | {
      status: "active";
      licenceId: string;
      validUntil: string | null;
      updatesUntil: string | null;
    }
  | { status: "absent" }
  | { status: "expired"; licenceId: string; validUntil: string }
  | {
      status: "version-not-covered";
      licenceId: string;
      updatesUntil: string;
      released: string;
    }
  | { status: "wrong-instance"; licenceId: string }
  | { status: "tampered" }
  | { status: "not-yet-valid"; licenceId: string; issuedOn: string };

export type EntitlementStatus = EntitlementState["status"];

export const ENTITLEMENT_STATUSES = [
  "active",
  "absent",
  "expired",
  "version-not-covered",
  "wrong-instance",
  "tampered",
  "not-yet-valid",
] as const satisfies readonly EntitlementStatus[];

/**
 * A licensed plugin's view of its entitlement.
 *
 * Read on every call rather than once at boot, so a licence the board enters,
 * one that ends, and the next one taking over all reach a running plugin
 * without a restart.
 */
export interface PluginEntitlements {
  /** The entitlement the manifest names, judged today. */
  get(): Promise<EntitlementState>;
  /**
   * The active licence with a fresh signature by the instance key, for one of
   * the audiences the manifest declares, as the text to send that service.
   * Null without an active licence.
   *
   * Signed without a network call; sending it is the plugin's. A presentation
   * is good at its audience for five minutes and once, so make one per
   * request rather than keeping one.
   *
   * Throws a RangeError for an audience the manifest does not declare, since
   * that is a defect in the plugin rather than a state of the licence.
   */
  present(audience: string): Promise<string | null>;
}

export interface TestEntitlementsOptions {
  /** What `get()` answers. */
  state: EntitlementState;
  /** The manifest's `licence.audiences`. None by default. */
  audiences?: readonly string[];
  /** What `present()` answers while the state is active. */
  presentation?: (audience: string) => string;
}

/**
 * A stand-in for `host.entitlements` in a plugin's own tests.
 *
 * It answers with the state it was given and keeps the host's two rules about
 * presenting: an undeclared audience is refused, and nothing is presented
 * without an active licence. A plugin that wants to test the service end of a
 * presentation signs licences with a throwaway key generated in the test;
 * nothing here needs one.
 */
export function createTestEntitlements(
  options: TestEntitlementsOptions,
): PluginEntitlements & { state: EntitlementState } {
  const audiences = new Set(options.audiences ?? []);
  const double = {
    state: options.state,
    get: (): Promise<EntitlementState> => Promise.resolve(double.state),
    present: (audience: string): Promise<string | null> => {
      if (!audiences.has(audience)) {
        return Promise.reject(undeclaredAudienceError());
      }
      if (double.state.status !== "active") {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        options.presentation?.(audience) ?? `test-presentation:${audience}`,
      );
    },
  };
  return double;
}

/**
 * The refusal of an audience the manifest does not declare, worded once for
 * the host and its test double. The audience is left out: it is whatever the
 * plugin passed.
 */
export function undeclaredAudienceError(): RangeError {
  return new RangeError(
    "present() was asked for an audience the plugin's manifest does not " +
      "declare under licence.audiences.",
  );
}
