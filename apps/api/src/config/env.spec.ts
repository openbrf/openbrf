import { describe, expect, it } from "vitest";

import { EnvValidationError, loadEnv } from "./env";

/**
 * The address this instance says it is at.
 *
 * APP_URL leaves the process: invitation and sign-in links are built from it,
 * the discovery document publishes it, and it is the audience every access
 * token is issued for. So it has to be an address a client can actually reach
 * and reach safely - https anywhere, or plain http only on loopback, which is
 * what a development instance and the end-to-end stack run on. The sign-in
 * library validates the same thing when it is constructed, much later and from
 * inside somebody else's package; checking it here is what turns that into a
 * boot error naming the variable an operator has to change.
 */

/**
 * What loadEnv insists on besides the value under test, so a failure can only
 * be about APP_URL. A password would do as well as a connection URL here:
 * nothing is connected to and nothing is signed.
 */
const REQUIRED = {
  DATABASE_URL: "postgresql://openbrf:openbrf@localhost:5432/openbrf",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
};

function withAppUrl(value: string): string {
  return loadEnv({ ...REQUIRED, APP_URL: value }).APP_URL;
}

/** The error a rejected value produced, or a failure if it was accepted. */
function rejection(value: string): Error {
  try {
    loadEnv({ ...REQUIRED, APP_URL: value });
  } catch (cause) {
    return cause as Error;
  }
  throw new Error(`APP_URL=${value} was accepted.`);
}

describe("the APP_URL check", () => {
  it("accepts an https address", () => {
    expect(withAppUrl("https://brf.example.se")).toBe("https://brf.example.se");
  });

  it("accepts plain http on localhost", () => {
    // What a development instance runs on, and the schema's own default.
    expect(withAppUrl("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("accepts plain http on the loopback address", () => {
    // The end-to-end stack and docker-compose.prod.yml's example both publish
    // on loopback behind a proxy that terminates TLS.
    expect(withAppUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("accepts plain http on the IPv6 loopback address", () => {
    expect(withAppUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("defaults to an address that passes its own check", () => {
    // The default is what an instance boots with when the variable is unset or
    // empty, so a default the refine rejected would be an instance that cannot
    // start at all until an operator supplies a value.
    expect(loadEnv(REQUIRED).APP_URL).toBe("http://localhost:5173");
  });

  it("refuses plain http on a public host", () => {
    // Not a preference: sign-in links and the token audience travel over it,
    // and passkeys need a secure origin, which outside loopback only https is.
    const error = rejection("http://brf.example.se");

    expect(error).toBeInstanceOf(EnvValidationError);
    expect(error.message).toContain(
      "APP_URL: must be an https URL, or http on localhost",
    );
  });

  it("refuses a value that is not a URL at all", () => {
    const error = rejection("brf.example.se");

    // The parser throws a TypeError on this, and a TypeError out of a URL
    // constructor is what an operator would otherwise be left reading: no
    // variable named, no file to open. The refine catches it and the failure
    // arrives as the validation error that names APP_URL.
    expect(error).toBeInstanceOf(EnvValidationError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toContain("APP_URL:");
  });

  it("refuses a scheme no client would reach it over", () => {
    // The protocol is checked rather than only the host, so a loopback address
    // cannot carry an unreachable scheme past the check.
    expect(rejection("ftp://brf.example.se")).toBeInstanceOf(
      EnvValidationError,
    );
    expect(rejection("file://localhost/tmp/openbrf")).toBeInstanceOf(
      EnvValidationError,
    );
  });

  it("names only APP_URL when only APP_URL is wrong", () => {
    // Every problem is reported at once, so an operator fixes one deploy
    // rather than five. That only helps if the list is the problems there are.
    const { message } = rejection("http://brf.example.se");

    expect(message).toBe(
      "Invalid environment configuration:\n" +
        "  APP_URL: must be an https URL, or http on localhost",
    );
  });
});
