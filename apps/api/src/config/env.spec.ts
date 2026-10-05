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
        "  APP_URL: must be an https URL, or http on localhost, and carry no " +
        "credentials, path, query or fragment",
    );
  });

  it("refuses an address carrying credentials", () => {
    // The value is published verbatim in the discovery documents, so a
    // password written into it is a password handed to every client that reads
    // one.
    expect(rejection("https://someone:hunter2@brf.example.se")).toBeInstanceOf(
      EnvValidationError,
    );
  });

  it("refuses an address with a path, a query or a fragment", () => {
    /*
     * A prefix here is not honoured, it is dropped: the resource URL is built
     * by resolving an absolute path against this value, so a base path never
     * reaches the audience. An operator mounting the instance under a prefix
     * would get tokens bound to an address their instance does not serve, and
     * nothing would say so. Refused at boot instead.
     */
    expect(rejection("https://brf.example.se/openbrf")).toBeInstanceOf(
      EnvValidationError,
    );
    expect(rejection("https://brf.example.se/?tenant=1")).toBeInstanceOf(
      EnvValidationError,
    );
    expect(rejection("https://brf.example.se/#top")).toBeInstanceOf(
      EnvValidationError,
    );
  });

  it("accepts the bare origin with a trailing slash", () => {
    // What an operator copies out of a browser's address bar. The path is
    // empty, so nothing is being asked for that cannot be honoured.
    expect(withAppUrl("https://brf.example.se/")).toBe(
      "https://brf.example.se/",
    );
  });
});

/**
 * The setup link's digest (ADR 0023).
 *
 * Refused at boot when it is not the shape hashOpaqueToken writes: a value
 * that could never equal any token's digest would leave the instance
 * unclaimable, and the first sign of it would be a board told its link does
 * not work.
 */
describe("the setup link's digest", () => {
  const DIGEST = "Dw2IjKhXMqZmAQPb-7sHzcTMAl5w-M6-vjgoiaP5WP8";

  function withDigest(value: string): Error | string | undefined {
    try {
      return loadEnv({ ...REQUIRED, OPENBRF_SETUP_TOKEN_DIGEST: value })
        .OPENBRF_SETUP_TOKEN_DIGEST;
    } catch (cause) {
      return cause as Error;
    }
  }

  it("accepts one base64url SHA-256 digest", () => {
    expect(withDigest(DIGEST)).toBe(DIGEST);
  });

  it("reads an empty value as absent", () => {
    // Compose passes an unset optional variable as an empty string, and an
    // absent digest is the self-hosted path: the link is minted and logged.
    expect(withDigest("")).toBeUndefined();
  });

  it.each([
    ["the token rather than its digest, as hex", "a".repeat(64)],
    ["padded base64", `${DIGEST.slice(0, 42)}=`],
    ["plain base64's alphabet", `${DIGEST.slice(0, 42)}+`],
    ["one character short", DIGEST.slice(0, 42)],
    ["two digests", `${DIGEST},${DIGEST}`],
  ])("refuses %s", (_what, value) => {
    const result = withDigest(value);
    expect(result).toBeInstanceOf(EnvValidationError);
    expect((result as Error).message).toContain("OPENBRF_SETUP_TOKEN_DIGEST");
  });
});

/**
 * Mail set where the instance runs (ADR 0024).
 *
 * Each driver needs its own variables, and a variable of another driver beside
 * the chosen one is half of a configuration that was being switched. Both are
 * boot errors naming the variable, so an operator reads what to fix rather than
 * finding out at the first invitation.
 */
describe("the mail driver's variables", () => {
  const HTTP_API = {
    OPENBRF_MAIL_DRIVER: "http-api",
    OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
    OPENBRF_MAIL_API_URL: "https://api.mail.example/v1",
    OPENBRF_MAIL_API_KEY: "key",
    OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "mail.example",
  };
  const SMTP = {
    OPENBRF_MAIL_DRIVER: "smtp",
    OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
    OPENBRF_SMTP_HOST: "smtp.host.example",
  };

  /** The problems loadEnv named, one per line, or none. */
  function problems(variables: Record<string, string>): string[] {
    try {
      loadEnv({ ...REQUIRED, ...variables });
    } catch (cause) {
      expect(cause).toBeInstanceOf(EnvValidationError);
      return (cause as Error).message
        .split("\n")
        .slice(1)
        .map((line) => line.trim());
    }
    return [];
  }

  it("defaults to the board's own settings, and needs nothing for them", () => {
    expect(loadEnv(REQUIRED).OPENBRF_MAIL_DRIVER).toBe("settings");
  });

  it("accepts each driver with its own variables", () => {
    expect(problems(HTTP_API)).toEqual([]);
    expect(problems(SMTP)).toEqual([]);
    expect(
      problems({
        ...SMTP,
        OPENBRF_MAIL_FROM_NAME: "Brf Eksemplet",
        OPENBRF_MAIL_REPLY_TO: "styrelsen@eksemplet.example",
        OPENBRF_SMTP_PORT: "2525",
        OPENBRF_SMTP_SECURE: "true",
        OPENBRF_SMTP_USER: "relay",
        OPENBRF_SMTP_PASSWORD: "relay-password",
      }),
    ).toEqual([]);
  });

  it("names every variable the http-api driver needs and was not given", () => {
    expect(problems({ OPENBRF_MAIL_DRIVER: "http-api" })).toEqual([
      'OPENBRF_MAIL_FROM_ADDRESS: is required when OPENBRF_MAIL_DRIVER is "http-api"',
      'OPENBRF_MAIL_API_URL: is required when OPENBRF_MAIL_DRIVER is "http-api"',
      'OPENBRF_MAIL_API_KEY: is required when OPENBRF_MAIL_DRIVER is "http-api"',
      'OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: is required when OPENBRF_MAIL_DRIVER is "http-api"',
    ]);
  });

  it("names every variable the smtp driver needs and was not given", () => {
    expect(problems({ OPENBRF_MAIL_DRIVER: "smtp" })).toEqual([
      'OPENBRF_MAIL_FROM_ADDRESS: is required when OPENBRF_MAIL_DRIVER is "smtp"',
      'OPENBRF_SMTP_HOST: is required when OPENBRF_MAIL_DRIVER is "smtp"',
    ]);
  });

  it("refuses the other driver's variables beside the chosen one", () => {
    expect(
      problems({ ...HTTP_API, OPENBRF_SMTP_HOST: "smtp.host.example" }),
    ).toEqual([
      'OPENBRF_SMTP_HOST: belongs to the "smtp" mail driver, and OPENBRF_MAIL_DRIVER is "http-api"',
    ]);
    expect(problems({ ...HTTP_API, OPENBRF_SMTP_SECURE: "false" })).toEqual([
      'OPENBRF_SMTP_SECURE: belongs to the "smtp" mail driver, and OPENBRF_MAIL_DRIVER is "http-api"',
    ]);
    expect(problems({ ...SMTP, OPENBRF_MAIL_API_KEY: "key" })).toEqual([
      'OPENBRF_MAIL_API_KEY: belongs to the "http-api" mail driver, and OPENBRF_MAIL_DRIVER is "smtp"',
    ]);
  });

  it("refuses a driver's variables when the environment chooses none", () => {
    // Otherwise an SMTP host set with the driver left at its default would be
    // ignored without a word, and the board's settings would send instead.
    expect(
      problems({
        OPENBRF_SMTP_HOST: "smtp.host.example",
        OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
      }),
    ).toEqual([
      'OPENBRF_SMTP_HOST: belongs to the "smtp" mail driver, and OPENBRF_MAIL_DRIVER is "settings"',
      'OPENBRF_MAIL_FROM_ADDRESS: belongs to a mail driver set in the environment, and OPENBRF_MAIL_DRIVER is "settings"',
    ]);
  });

  it('reads the SMTP flag as "true" or "false" and names anything else', () => {
    // "TRUE" or "1" read as false would leave the connection in the clear
    // until STARTTLS without a word.
    for (const value of ["TRUE", "1", "yes"]) {
      expect(problems({ ...SMTP, OPENBRF_SMTP_SECURE: value })).toEqual([
        'OPENBRF_SMTP_SECURE: must be "true" or "false"',
      ]);
    }
    expect(
      loadEnv({ ...REQUIRED, ...SMTP, OPENBRF_SMTP_SECURE: "false" })
        .OPENBRF_SMTP_SECURE,
    ).toBe(false);
  });

  it('reads the STARTTLS opt-out as "true" or "false" and names anything else', () => {
    // Only the exact word turns the requirement off.
    for (const value of ["FALSE", "0", "no"]) {
      expect(problems({ ...SMTP, OPENBRF_SMTP_REQUIRE_TLS: value })).toEqual([
        'OPENBRF_SMTP_REQUIRE_TLS: must be "true" or "false"',
      ]);
    }
    expect(
      loadEnv({ ...REQUIRED, ...SMTP, OPENBRF_SMTP_REQUIRE_TLS: "false" })
        .OPENBRF_SMTP_REQUIRE_TLS,
    ).toBe(false);
    expect(
      loadEnv({ ...REQUIRED, ...SMTP, OPENBRF_SMTP_REQUIRE_TLS: "true" })
        .OPENBRF_SMTP_REQUIRE_TLS,
    ).toBe(true);
    expect(
      problems({ ...HTTP_API, OPENBRF_SMTP_REQUIRE_TLS: "false" }),
    ).toEqual([
      'OPENBRF_SMTP_REQUIRE_TLS: belongs to the "smtp" mail driver, and OPENBRF_MAIL_DRIVER is "http-api"',
    ]);
    expect(problems({ OPENBRF_SMTP_REQUIRE_TLS: "false" })).toEqual([
      'OPENBRF_SMTP_REQUIRE_TLS: belongs to the "smtp" mail driver, and OPENBRF_MAIL_DRIVER is "settings"',
    ]);
  });

  it("trims the display name and refuses a blank one", () => {
    expect(problems({ ...SMTP, OPENBRF_MAIL_FROM_NAME: "   " })).toEqual([
      "OPENBRF_MAIL_FROM_NAME: must not be blank",
    ]);
    expect(
      loadEnv({
        ...REQUIRED,
        ...SMTP,
        OPENBRF_MAIL_FROM_NAME: " Brf Eksemplet ",
      }).OPENBRF_MAIL_FROM_NAME,
    ).toBe("Brf Eksemplet");
  });

  it("wants an SMTP user and password together or not at all", () => {
    expect(problems({ ...SMTP, OPENBRF_SMTP_USER: "relay" })).toEqual([
      "OPENBRF_SMTP_PASSWORD: is required when OPENBRF_SMTP_USER is set",
    ]);
    expect(problems({ ...SMTP, OPENBRF_SMTP_PASSWORD: "secret" })).toEqual([
      "OPENBRF_SMTP_USER: is required when OPENBRF_SMTP_PASSWORD is set",
    ]);
  });

  it("refuses a mail API reached over plain http off loopback", () => {
    // Every message carries the key and a recipient's address.
    expect(
      problems({
        ...HTTP_API,
        OPENBRF_MAIL_API_URL: "http://api.mail.example/v1",
      }),
    ).toEqual([
      "OPENBRF_MAIL_API_URL: must be an https URL, or http on localhost, and carry no credentials, query or fragment",
    ]);
  });

  it("accepts a mail API on loopback over http, and a path on either", () => {
    expect(
      problems({
        ...HTTP_API,
        OPENBRF_MAIL_API_URL: "http://127.0.0.1:8025/v1",
      }),
    ).toEqual([]);
  });

  it("refuses a mail API address carrying credentials, a query or a fragment", () => {
    for (const url of [
      "https://user:secret@api.mail.example/v1",
      "https://api.mail.example/v1?key=1",
      "https://api.mail.example/v1#top",
    ]) {
      expect(problems({ ...HTTP_API, OPENBRF_MAIL_API_URL: url })).toHaveLength(
        1,
      );
    }
  });

  it("refuses a display name that is not one line", () => {
    // It becomes part of a header, where a line break starts another one.
    expect(
      problems({
        ...HTTP_API,
        OPENBRF_MAIL_FROM_NAME: "Brf Eksemplet\r\nBcc: nagon@annan.example",
      }),
    ).toEqual([
      "OPENBRF_MAIL_FROM_NAME: must be one line, with no line break or other control character",
    ]);
  });

  it("refuses a sender that is not a bare address", () => {
    expect(
      problems({
        ...HTTP_API,
        OPENBRF_MAIL_FROM_ADDRESS: "Brf Eksemplet <utskick@delad.example>",
      }),
    ).toHaveLength(1);
  });

  it("refuses a Message-ID domain that is not a domain", () => {
    expect(
      problems({
        ...HTTP_API,
        OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "<getpost.se>",
      }),
    ).toHaveLength(1);
    expect(
      problems({
        ...HTTP_API,
        OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "getpost.se",
      }),
    ).toEqual([]);
  });
});

/**
 * The size of the application's connection pool.
 *
 * Several instances can share one database server, and every connection an
 * instance may open comes out of that server's one max_connections. A value
 * that is not a whole number of connections, or that no single instance
 * should need, is a boot error naming the variable rather than a server that
 * runs out of connections for somebody else's instance.
 */
describe("the connection pool's size", () => {
  function withPoolSize(value: string | undefined): number {
    return loadEnv({ ...REQUIRED, OPENBRF_DATABASE_POOL_SIZE: value })
      .OPENBRF_DATABASE_POOL_SIZE;
  }

  function poolSizeRejection(value: string): Error {
    try {
      loadEnv({ ...REQUIRED, OPENBRF_DATABASE_POOL_SIZE: value });
    } catch (cause) {
      return cause as Error;
    }
    throw new Error(`OPENBRF_DATABASE_POOL_SIZE=${value} was accepted.`);
  }

  it("is node-postgres's ten when nothing is set", () => {
    expect(withPoolSize(undefined)).toBe(10);
    // Compose passes an unset optional variable as an empty string.
    expect(withPoolSize("")).toBe(10);
  });

  it("takes any whole number from one to fifty", () => {
    expect(withPoolSize("1")).toBe(1);
    expect(withPoolSize("4")).toBe(4);
    expect(withPoolSize("50")).toBe(50);
  });

  it("refuses none at all, more than fifty, a fraction and a word", () => {
    for (const value of ["0", "51", "2.5", "twelve", "-3"]) {
      const error = poolSizeRejection(value);
      expect(error, value).toBeInstanceOf(EnvValidationError);
      expect(error.message, value).toContain("OPENBRF_DATABASE_POOL_SIZE");
    }
  });
});

describe("the sign-in secret in production", () => {
  const production = (secret: string) =>
    loadEnv({
      ...REQUIRED,
      NODE_ENV: "production",
      APP_URL: "https://brf.example",
      BETTER_AUTH_SECRET: secret,
    });

  it.each([
    ["the published development placeholder", "dev-only-secret-change-me"],
    ["one of sixteen characters", "0123456789abcdef"],
    ["one a character short of the floor", "k".repeat(31)],
  ])("refuses %s, naming the variable", (_name, secret) => {
    expect(() => production(secret)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it.each([
    ["one exactly at the floor", "k".repeat(32)],
    ["a long one", "k".repeat(48)],
  ])("takes %s", (_name, secret) => {
    expect(production(secret).BETTER_AUTH_SECRET).toBe(secret);
  });

  it("keeps the shorter floor outside production", () => {
    expect(
      loadEnv({ ...REQUIRED, BETTER_AUTH_SECRET: "dev-only-secret-change-me" })
        .BETTER_AUTH_SECRET,
    ).toBe("dev-only-secret-change-me");
  });
});
