import { describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import {
  type AccountState,
  buildAuthOptions,
  deliverMagicLink,
  type MagicLinkDelivery,
  RATE_LIMIT_MAX,
  SESSION_READ_MAX,
  SESSION_READ_PATH,
  SESSION_READ_WINDOW_SECONDS,
} from "./auth-options";

/**
 * The magic-link policy, tested on its own.
 *
 * Every branch has to end in the same visible outcome, because the endpoint
 * that reaches this is public and serves an instance holding a statutory
 * register: any difference a caller can observe enumerates accounts.
 */

interface Recorded {
  delivery: MagicLinkDelivery;
  sent: string[];
  notices: string[];
}

function recording(state: AccountState): Recorded {
  const sent: string[] = [];
  const notices: string[] = [];

  return {
    sent,
    notices,
    delivery: {
      accountState: () => Promise.resolve(state),
      send: ({ email }) => {
        sent.push(email);
        return Promise.resolve();
      },
      sendSecondFactorNotice: ({ email }) => {
        notices.push(email);
        return Promise.resolve();
      },
    },
  };
}

const request = {
  email: "resident@exempel.se",
  url: "https://brf.example/api/auth/magic-link/verify?token=t",
  expiresAt: new Date("2026-08-27T12:15:00Z"),
};

describe("deliverMagicLink", () => {
  it("sends the link to an account without a second factor", async () => {
    const { delivery, sent, notices } = recording({
      exists: true,
      hasSecondFactor: false,
    });

    await deliverMagicLink(delivery, request);

    expect(sent).toEqual([request.email]);
    expect(notices).toEqual([]);
  });

  it("mails an explanation instead of a link when TOTP is enrolled", async () => {
    const { delivery, sent, notices } = recording({
      exists: true,
      hasSecondFactor: true,
    });

    await deliverMagicLink(delivery, request);

    // A magic link mints a session directly, so issuing one to a TOTP account
    // would walk around the second factor with mailbox access alone.
    expect(sent).toEqual([]);
    expect(notices).toEqual([request.email]);
  });

  it("sends nothing at all to an address with no account", async () => {
    const { delivery, sent, notices } = recording({
      exists: false,
      hasSecondFactor: false,
    });

    await deliverMagicLink(delivery, request);

    // Better Auth calls this before it checks whether the user exists, so
    // without the guard anyone could make the instance mail a sign-in link to
    // an address of their choosing.
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("resolves for every account state, so the caller cannot tell them apart", async () => {
    const states: AccountState[] = [
      { exists: true, hasSecondFactor: false },
      { exists: true, hasSecondFactor: true },
      { exists: false, hasSecondFactor: false },
    ];

    for (const state of states) {
      await expect(
        deliverMagicLink(recording(state).delivery, request),
      ).resolves.toBeUndefined();
    }
  });
});

/**
 * The rate-limit configuration, read off the options object.
 *
 * Better Auth's own rules are what defend the credential paths, and they are
 * tighter than the default this file sets: three attempts per ten seconds on
 * /sign-in, /sign-up, /change-password and /change-email, three per ten on
 * /two-factor/*, five per minute on the magic link's two paths. A custom rule
 * replaces whichever of those it matches, which makes customRules the one place
 * from which a brute-force defence could be widened without anybody meaning to.
 * These assertions are that nothing in it reaches such a path - the behaviour
 * either side of the session read's budget is in auth.int-spec.ts, over HTTP,
 * because it is the limiter's counting that decides it and not this object.
 */
describe("the auth rate-limit configuration", () => {
  const options = buildAuthOptions(
    {
      NODE_ENV: "test",
      APP_URL: "https://brf.example",
      BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    } as Env,
    {} as PrismaService,
    {
      accountState: () =>
        Promise.resolve({ exists: false, hasSecondFactor: false }),
      send: () => Promise.resolve(),
      sendSecondFactorNotice: () => Promise.resolve(),
    },
  );

  it("carries a rule for the session read and for nothing else", () => {
    expect(Object.keys(options.rateLimit.customRules)).toEqual([
      SESSION_READ_PATH,
    ]);
    // A pattern is matched with a wildcard and a bare path by equality, so a
    // rule that is spelled out cannot spread to a neighbouring path however the
    // endpoints are later named.
    expect(SESSION_READ_PATH).not.toContain("*");
  });

  it("gives the session read a wider budget over a shorter window", () => {
    const rule = options.rateLimit.customRules[SESSION_READ_PATH];

    // Wider, because the caller is the interface rather than somebody trying
    // credentials; shorter, because the count only clears after a window in
    // which the address asked nothing, so a long window is a budget an
    // interface in continuous use never gets back.
    expect(rule.max).toBeGreaterThan(RATE_LIMIT_MAX);
    expect(rule.window).toBeLessThan(options.rateLimit.window);
    expect(rule).toEqual({
      max: SESSION_READ_MAX,
      window: SESSION_READ_WINDOW_SECONDS,
    });
  });
});
