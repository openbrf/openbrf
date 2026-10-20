/**
 * The support session's cookie (ADR 0028).
 *
 * A cookie of its own rather than the sign-in library's, because a support
 * session is not an account session: nothing the library reads or renews may
 * mistake it for one, and the guard reads it before the library is asked.
 *
 * HttpOnly, SameSite=Strict, and Secure with the `__Host-` prefix whenever the
 * instance is served over https. The prefix is what makes the name mean
 * something: a cookie under it can only have been set by this origin, over a
 * secure connection, for every path, so a sibling site under the same domain
 * cannot plant one. Strict rather than the account cookie's Lax, because a
 * supporter is never sent into the instance by a link that needs the session:
 * the sign-in link carries its own token, and everything after it is a
 * same-origin request.
 *
 * Only the name the instance's own scheme gives is read. An unprefixed cookie
 * on an https instance is somebody else's and is ignored.
 */

/** What the request presented under the support cookie's name. */
export type PresentedSupportCookie =
  | { readonly kind: "none" }
  | { readonly kind: "token"; readonly token: string }
  /** Presented twice, or empty: carried, but not a token anybody minted. */
  | { readonly kind: "unreadable" };

export class SupportSessionCookie {
  readonly name: string;
  private readonly secure: boolean;

  constructor(appUrl: string) {
    this.secure = new URL(appUrl).protocol === "https:";
    this.name = this.secure ? "__Host-openbrf-support" : "openbrf-support";
  }

  /**
   * The token a Cookie header carries under this name.
   *
   * Two of them is unreadable rather than either one, which is what an
   * ambiguous credential deserves (ADR 0009 says the same of two Authorization
   * headers).
   */
  presented(header: string | undefined): PresentedSupportCookie {
    if (header === undefined) {
      return { kind: "none" };
    }
    const values: string[] = [];
    for (const pair of header.split(";")) {
      const separator = pair.indexOf("=");
      if (separator === -1) {
        continue;
      }
      if (pair.slice(0, separator).trim() === this.name) {
        values.push(pair.slice(separator + 1).trim());
      }
    }
    if (values.length === 0) {
      return { kind: "none" };
    }
    const [token] = values;
    if (values.length > 1 || token === undefined || token === "") {
      return { kind: "unreadable" };
    }
    return { kind: "token", token };
  }

  /** The Set-Cookie value that starts a session, until `expiresAt`. */
  set(token: string, expiresAt: Date): string {
    return this.serialize(token, `Expires=${expiresAt.toUTCString()}`);
  }

  /** The Set-Cookie value that removes the cookie. */
  clear(): string {
    return this.serialize("", "Max-Age=0");
  }

  private serialize(value: string, lifetime: string): string {
    return [
      `${this.name}=${value}`,
      "Path=/",
      lifetime,
      "HttpOnly",
      "SameSite=Strict",
      ...(this.secure ? ["Secure"] : []),
    ].join("; ");
  }
}
