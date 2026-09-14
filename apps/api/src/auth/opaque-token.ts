import { createHash } from "node:crypto";

/**
 * The digest an opaque access or refresh token is stored and looked up under.
 *
 * Access tokens here are opaque rather than self-contained: the value a client
 * presents carries no claims, and every call resolves it by looking the row up.
 * That is what makes a disconnect take effect on the next request rather than
 * when the token would have expired - there is no cached copy of the person's
 * capabilities anywhere in the path, and deleting the row is the revocation.
 *
 * What is stored is the digest and never the token. A token is a bearer
 * credential: anything holding the stored value could act as the person, so a
 * database copy, a backup or a support query must not be enough. The lookup is
 * unaffected, because a digest of a fixed input is fixed - the column is
 * unique and indexed and the query is the same one.
 *
 * Pinned here rather than left to the library's default. The default is this
 * same construction today, but a default is an implementation detail a minor
 * version may change, and a changed digest would not fail loudly: every live
 * token would simply stop resolving, reading as though every member had
 * disconnected every app at once. Naming the function makes that a decision
 * somebody has to take rather than something an upgrade can do.
 *
 * SHA-256 with no salt and no key, deliberately. The input is a high-entropy
 * random value the server minted, not a password, so there is no dictionary to
 * defend against and nothing for a work factor to buy; what is wanted is a
 * fast, stable, one-way index. base64url unpadded because the value is only
 * ever a database key and a URL-safe alphabet keeps it copyable in a log line
 * or a query without escaping.
 */
export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}
