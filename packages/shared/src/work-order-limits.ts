/**
 * How much the board may write about a contractor (entreprenör) and in a work
 * order (arbetsorder).
 *
 * Here rather than beside the routes that enforce them, for the reason the
 * issue report's limits give: the form has to know the same numbers, and a
 * length refused after somebody has written it is not something a generic
 * error can explain.
 */
export const CONTRACTOR_LIMITS = {
  /** The firm's or the tradesperson's name. */
  name: 200,
  /** What they do: "Rörmokare", "Elektriker", "Låssmed". */
  trade: 100,
  phone: 40,
  /** RFC 5321's limit on a path, which no address can exceed. */
  email: 254,
} as const;

export const WORK_ORDER_LIMITS = {
  /**
   * The job in the handler's own words. As long as an issue report may be, so
   * a handler who quotes what a resident saw about a leak is never cut short.
   */
  body: 4000,
  /**
   * A note a contractor writes through a work order's link (ADR 0055): what
   * they found or did, in a few lines. Shorter than the work order, because
   * the link is the one place in the product a stranger writes free text into
   * an issue.
   */
  note: 2000,
} as const;
