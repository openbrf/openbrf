import { describe, expect, it } from "vitest";

import { isAcceptableRedirectUri } from "./redirect-uri.ts";

/**
 * The one redirect rule. Registration and the consent screen both ask it, so
 * an address one of them takes is never one the other refuses after the member
 * has already said yes.
 */
describe("isAcceptableRedirectUri", () => {
  it.each([
    "https://app.exempel.se/cb",
    "https://app.exempel.se:8443/cb?from=brf",
    // Names that only start or end like this machine's.
    "https://localhost.exempel.se/cb",
    "https://mylocalhost/cb",
    "http://localhost:8123/callback",
    "http://127.0.0.1:8123/callback",
    "http://[::1]:8123/callback",
    "http://localhost/callback",
    "HTTP://LOCALHOST:8123/callback",
    "se.exempel.app:/callback",
    "com.example.app:/oauth2redirect/brf",
  ])("takes %s", (uri) => {
    expect(isAcceptableRedirectUri(uri)).toBe(true);
  });

  it.each([
    // Run in, or handed on from, this application's origin.
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "file:///etc/passwd",
    "mailto:styrelsen@exempel.se",
    // The code in clear text across a network.
    "http://app.exempel.se/cb",
    "http://localhost.evil.com/cb",
    "http://localhost@evil.com/cb",
    "ftp://app.exempel.se/cb",
    // https on this machine, where an app listens on plain http.
    "https://localhost:8123/cb",
    "https://127.0.0.1:8123/cb",
    "https://127.0.0.2/cb",
    "https://[::1]:8123/cb",
    "https://localhost./cb",
    "https://app.localhost/cb",
    "https://app.localhost./cb",
    "https://brf.app.LOCALHOST:8443/cb",
    "http://127.0.0.2:8123/cb",
    // This machine in a spelling the parser normalizes and the provider refuses.
    "http://127.1:8123/cb",
    "http://0x7f.0.0.1:8123/cb",
    "http://2130706433:8123/cb",
    "http://127.000.000.001:8123/cb",
    "http://[0:0:0:0:0:0:0:1]:8123/cb",
    // An app scheme that is not a reversed domain name, or that names a host.
    "myapp:/callback",
    "myapp://callback",
    "se.exempel.app://callback",
    "se.exempel.app:callback",
    // Credentials or a fragment.
    "https://user:pass@app.exempel.se/cb",
    "https://app.exempel.se/cb#fragment",
    "https://app.exempel.se/cb#",
    "se.exempel.app:/callback#x",
    // Not an address.
    "",
    "/cb",
    "app.exempel.se/cb",
  ])("refuses %j", (uri) => {
    expect(isAcceptableRedirectUri(uri)).toBe(false);
  });
});
