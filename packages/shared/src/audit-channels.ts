/**
 * Which way a change reached the association's records: the audit channel
 * (granskningskanal).
 *
 * The audit log (granskningslogg) has always recorded who acted and what they
 * did. It could not say how they reached the records, and for as long as a
 * person in a browser was the only way in, there was nothing to say. Once a
 * token held by an external program can publish a news item and rearrange a
 * menu, the route is a fact about the act: the same board member acting in the
 * web interface and acting through a connected app (ansluten app) is the same
 * person reaching the records two different ways, and only one of those ways
 * involves them reading what they signed.
 *
 * It is a fact about the route and never about the person, which is why it sits
 * beside the actor rather than replacing anything: an entry says who, what, and
 * now how.
 *
 * The list lives here rather than only in the Prisma enum because both sides
 * render it. The API validates and writes the generated enum; the browser
 * prints the channel in the "Via" column of the data subject access report
 * (registerutdrag) and may not import server types. A spec on the API side
 * asserts that this tuple and the generated enum hold the same values, which is
 * the only place both can be seen at once.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */
export const AUDIT_CHANNELS = [
  /** A person working in the web interface. */
  "WEB",
  /**
   * A token presented by a connected app (ansluten app), acting as the person
   * who connected it.
   */
  "MCP",
  /**
   * The AI package, acting as the person who prompted it.
   *
   * Anticipatory: no such package exists yet. The value is minted now because
   * the table is append-only, so a value added later could never be written
   * onto the rows that needed it, and an act would be recorded as having come
   * through something it did not.
   */
  "AI",
  /**
   * The system itself: a nightly job whose clock struck, a seed, the command
   * line. It replaces the inference that an entry with no actor was the
   * system's, which was true only for as long as every other writer had one.
   */
  "SYSTEM",
  /** A plugin's own write through the host, outside any action of its own. */
  "PLUGIN",
] as const;

export type AuditChannelName = (typeof AUDIT_CHANNELS)[number];
