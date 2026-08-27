import { describe, expect, it } from "vitest";

import {
  type AccountState,
  deliverMagicLink,
  type MagicLinkDelivery,
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
