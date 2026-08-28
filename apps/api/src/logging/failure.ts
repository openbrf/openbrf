/**
 * Naming a failure without repeating what it carried.
 *
 * An exception from a mail server or from the database holds more than the fact
 * that something failed. An SMTP rejection quotes the envelope it rejected, and
 * that envelope holds an address this application decrypted a moment earlier; a
 * constraint violation names the value that broke it. An application log is
 * read by more people and kept longer than the data it would be repeating, so
 * none of that goes in it.
 *
 * What travels instead is the class of the failure - a transport error, a
 * database error, a type error - which says which layer gave way and nothing
 * about whom it happened to. The identifier comes from the caller: a residency,
 * a board member, an import session. That is enough to find the row and to run
 * the same call again.
 */
export function failureName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
