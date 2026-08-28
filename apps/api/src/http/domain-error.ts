/**
 * A failure the caller caused, carrying the status and the machine-readable
 * reason to answer with.
 *
 * The reason exists because the client must not render the API's own words. The
 * interface is Swedish by default while these messages are English, and how
 * much a failure gives away is a decision for the endpoint rather than for a
 * translation: the sign-in screen already maps codes to one translated sentence
 * each for exactly that reason. So every domain failure travels as a code, and
 * the message is for the server log and for a developer reading a response.
 *
 * Subclasses declare their own status rather than the filter mapping them,
 * which keeps the status next to the rule that produced it. The exception
 * filter catches this base class once, so a new module needs no change there.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly reason: string;

  /**
   * The particulars this failure publishes, keyed by the field they travel in.
   *
   * Opt-in, and declared by the error that owns them. A refusal that names none
   * is often not actionable - "this theme was refused" without the contrast
   * pairs that failed leaves the person looking at the screen no way to fix it
   * - but which fields are safe to send is a decision for the rule that
   * produced the failure, not for the filter that serialises it. Undeclared, an
   * error answers with its status, reason and message and nothing else, so a
   * field holding submitted values cannot reach a response body by being named
   * the right thing.
   *
   * Every value is codes and numbers rather than prose, because the interface
   * translates them, and never personal data.
   */
  details?(): Record<string, readonly unknown[]>;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
