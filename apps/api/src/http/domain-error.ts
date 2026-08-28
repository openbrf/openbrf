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

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
